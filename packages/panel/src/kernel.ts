import type { AuditEntry, OutboxItem, PanelEvent, Session, Staff } from './domain';
import { feeds, type CircuitStat, type FeedCtx, type FeedMap, type FeedName } from './feeds';
import {
  DomainError,
  type CircuitName,
  type DispatchResult,
  type HandlerCtx,
  type IntentDef,
  type IntentMap,
  type IntentName,
  type PanelConfig,
  type Registry,
} from './intents';
import { authIntents } from './circuits/auth';
import { catalogueIntents } from './circuits/catalogue';
import { orderIntents } from './circuits/orders';
import { paymentIntents } from './circuits/payments';
import { staffIntents } from './circuits/staff';
import { stockIntents } from './circuits/stock';
import { syncIntents } from './circuits/sync';
import { describeSchemaProblems, feedSchemas, schemas } from './schemas';
import {
  createIds,
  createMemoryStore,
  createSecrets,
  createSha256Hasher,
  sha256Hex,
  systemClock,
  type Clock,
  type Ids,
  type PinHasher,
  type Secrets,
  type Store,
  type Terminals,
} from './ports';

export interface PanelOptions {
  store?: Store;
  clock?: Clock;
  ids?: Ids;
  secrets?: Secrets;
  hasher?: PinHasher;
  terminals?: Terminals;
  /** Short prefix that keeps order numbers unique across devices. */
  devicePrefix?: string;
  formatMoney?: (n: number) => string;
  lockoutMaxFailures?: number;
  lockoutMinutes?: number[];
  sessionIdleMs?: number;
  sessionMaxMs?: number;
  /** How long a request id is remembered for retry safety. */
  requestTtlMs?: number;
  /** Called for failures nobody expected, so the host can log them with a stack trace. */
  onError?: (err: unknown, info: { intent?: string; feed?: string }) => void;
}

export interface DispatchOptions {
  /** Send the same id when retrying. If it already succeeded, you get the same answer and nothing runs twice. */
  requestId?: string;
}

export type FeedResult<D> =
  | { ok: true; data: D }
  | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] } };

export interface Panel {
  /** Send an instruction. Passes the breakers, then the circuit, all-or-nothing. */
  dispatch<K extends IntentName>(type: K, payload: IntentMap[K], token?: string, options?: DispatchOptions): Promise<DispatchResult>;
  /** Read display-ready data once. */
  feed<K extends FeedName>(name: K, params: FeedMap[K]['params'], token?: string): Promise<FeedResult<FeedMap[K]['data']>>;
  /** Read a feed and get it again after every change. Returns an unsubscribe function. */
  subscribe<K extends FeedName>(
    name: K,
    params: FeedMap[K]['params'],
    token: string | undefined,
    listener: (r: FeedResult<FeedMap[K]['data']>) => void,
  ): () => void;
  onEvent(listener: (e: PanelEvent) => void): () => void;
  /** Housekeeping: drop expired sessions and old request ids. Safe to call any time. */
  maintain(): Promise<{ sessionsPruned: number; requestsPruned: number }>;
  /** Run something while no instruction or feed is running. Used for consistent backups. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

interface SessionRecord {
  id: string; // sha256 of the token, never the token itself
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface RequestRecord {
  id: string;
  at: string;
  result: DispatchResult;
}

const registry = {
  ...authIntents,
  ...staffIntents,
  ...catalogueIntents,
  ...stockIntents,
  ...orderIntents,
  ...paymentIntents,
  ...syncIntents,
} as Registry;

export const INTENT_NAMES = Object.keys(registry) as IntentName[];

/** Who may send each instruction. Feeds the generated API reference. */
export function describeIntents() {
  return INTENT_NAMES.map((name) => {
    const def = registry[name] as IntentDef<unknown>;
    return { name, circuit: def.circuit, roles: def.roles };
  });
}

/** Who may read each feed. Feeds the generated API reference. */
export function describeFeeds() {
  return (Object.keys(feeds) as FeedName[]).map((name) => ({ name, roles: feeds[name].roles }));
}

const defaultMoney = (n: number) => new Intl.NumberFormat('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);

const HOUR = 3_600_000;
const TOUCH_EVERY_MS = 60_000;

export function createPanel(options: PanelOptions = {}): Panel {
  const store = options.store ?? createMemoryStore();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createIds();
  const secrets = options.secrets ?? createSecrets();
  const hasher = options.hasher ?? createSha256Hasher();
  const terminals = options.terminals ?? {};
  const config: PanelConfig = {
    devicePrefix: options.devicePrefix ?? 'A',
    formatMoney: options.formatMoney ?? defaultMoney,
    lockoutMaxFailures: options.lockoutMaxFailures ?? 5,
    lockoutMinutes: options.lockoutMinutes ?? [1, 5, 15, 60],
    sessionIdleMs: options.sessionIdleMs ?? 10 * HOUR,
    sessionMaxMs: options.sessionMaxMs ?? 24 * HOUR,
  };
  const requestTtlMs = options.requestTtlMs ?? 7 * 24 * HOUR;

  const eventListeners = new Set<(e: PanelEvent) => void>();
  const refreshers = new Set<() => void>();
  const stats = new Map<CircuitName, CircuitStat>();
  for (const def of Object.values(registry) as IntentDef<unknown>[]) {
    if (!stats.has(def.circuit)) stats.set(def.circuit, { handled: 0, denied: 0, invalid: 0, errors: 0, lastActivityAt: null });
  }

  const now = () => clock.now().toISOString();

  /**
   * One instruction or feed at a time. This is what makes order numbers, stock counts and payments
   * safe: nothing can interleave with a transaction that is half done. A shop has a handful of
   * devices, so waiting a few milliseconds for the queue costs nothing.
   */
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  }

  let refreshQueued = false;
  const scheduleRefresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      for (const r of refreshers) r();
    });
  };

  /* ---------- Sessions: stored, hashed, expiring ---------- */

  async function resolveSession(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const id = await sha256Hex(token);
    const rec = await store.get<SessionRecord>('sessions', id);
    if (!rec) return null;
    const nowMs = clock.now().getTime();
    if (Date.parse(rec.expiresAt) <= nowMs || nowMs - Date.parse(rec.lastSeenAt) > config.sessionIdleMs) {
      await store.delete('sessions', id);
      return null;
    }
    const staff = await store.get<Staff>('staff', rec.userId);
    if (!staff || !staff.active) return null;
    if (nowMs - Date.parse(rec.lastSeenAt) > TOUCH_EVERY_MS) await store.put('sessions', { ...rec, lastSeenAt: now() });
    return { userId: staff.id, name: staff.name, role: staff.role };
  }

  const makeCtx = (session: Session | null, token: string | undefined): HandlerCtx => ({
    store,
    clock,
    ids,
    config,
    terminals,
    hasher,
    secrets,
    session,
    sessionId: token,
    now,
    issueSession: async (s) => {
      const issued = secrets.token();
      const at = clock.now().getTime();
      await store.put<SessionRecord>('sessions', {
        id: await sha256Hex(issued),
        userId: s.userId,
        createdAt: new Date(at).toISOString(),
        lastSeenAt: new Date(at).toISOString(),
        expiresAt: new Date(at + config.sessionMaxMs).toISOString(),
      });
      return issued;
    },
    endSession: async (t) => {
      if (t) await store.delete('sessions', await sha256Hex(t));
    },
    revokeSessions: async (userId, exceptToken) => {
      const keep = exceptToken ? await sha256Hex(exceptToken) : null;
      for (const s of await store.find<SessionRecord>('sessions', { where: { userId } })) {
        if (s.id !== keep) await store.delete('sessions', s.id);
      }
    },
  });

  /* ---------- Breaker 3: audit ---------- */

  async function writeAudit(entry: Omit<AuditEntry, 'id' | 'at'>) {
    await store.put<AuditEntry>('audit', { id: ids.next('aud'), at: now(), ...entry });
  }

  async function enqueueSync(intent: string, target: string | undefined) {
    const item: OutboxItem = {
      id: ids.next('out'),
      kind: 'sync',
      payload: { intent, target },
      createdAt: now(),
      attempts: 0,
      status: 'pending',
    };
    await store.put('outbox', item);
  }

  const fail = (code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error', messages: string[]): DispatchResult => ({
    ok: false,
    error: { code, messages },
  });

  const bump = (stat: CircuitStat, key: 'handled' | 'denied' | 'invalid' | 'errors') => {
    stat[key]++;
    stat.lastActivityAt = now();
  };

  /* ---------- dispatch ---------- */

  interface Outcome {
    result: DispatchResult;
    events: Array<{ type: string; payload?: Record<string, unknown> }>;
    stat: 'handled' | 'denied' | 'invalid';
    actorId?: string;
    changed: boolean;
  }

  async function dispatchInner<K extends IntentName>(type: K, payload: IntentMap[K], token: string | undefined, opts: DispatchOptions): Promise<DispatchResult> {
    const def = registry[type] as IntentDef<IntentMap[K]> | undefined;
    if (!def) return fail('invalid', [`Unknown instruction ${String(type)}.`]);
    const stat = stats.get(def.circuit)!;
    const session = await resolveSession(token);
    const actor = session ? { actorId: session.userId, actorName: session.name, role: session.role } : {};
    const ctx = makeCtx(session, token);

    // Breaker 1: PIN and role.
    if (def.roles !== 'public') {
      if (!session) {
        bump(stat, 'denied');
        await writeAudit({ intent: type, summary: 'Blocked: not signed in', outcome: 'denied' });
        return fail('unauthenticated', ['Sign in with your PIN to continue.']);
      }
      if (!def.roles.includes(session.role)) {
        bump(stat, 'denied');
        await writeAudit({ ...actor, intent: type, summary: `Blocked: ${session.role} cannot do this`, outcome: 'denied' });
        return fail('forbidden', ['Your role cannot do this. Ask the owner.']);
      }
    }

    // Shape check: what actually arrived, not what the types promise.
    const parsed = schemas[type].safeParse(payload ?? {});
    if (!parsed.success) {
      bump(stat, 'invalid');
      await writeAudit({ ...actor, intent: type, summary: 'Rejected: the request was malformed', outcome: 'invalid' });
      return fail('invalid', describeSchemaProblems(parsed.error));
    }
    const data = parsed.data as IntentMap[K];

    // Retry safety: the same request id from the same person is answered, not run again.
    const requestKey = opts.requestId && session ? `${session.userId}:${opts.requestId.slice(0, 80)}` : null;
    if (requestKey) {
      const prior = await store.get<RequestRecord>('requests', requestKey);
      if (prior) return prior.result;
    }

    try {
      // Breakers 2 and 3 and the circuit itself: one transaction, all or nothing.
      const outcome = await store.transaction<Outcome>(async () => {
        if (def.validate) {
          const errors = await def.validate(data, ctx);
          if (errors.length) {
            await writeAudit({ ...actor, intent: type, summary: `Rejected: ${errors[0]}`, outcome: 'invalid' });
            return { result: fail('invalid', errors), events: [], stat: 'invalid', changed: false };
          }
        }

        const res = await def.handle(data, ctx);
        const who = res.actor ? { actorId: res.actor.userId, actorName: res.actor.name, role: res.actor.role } : actor;

        if (res.failure) {
          const denied = res.failure.code === 'forbidden';
          await writeAudit({ ...who, intent: type, target: res.target, summary: res.summary, outcome: denied ? 'denied' : 'invalid' });
          return { result: fail(res.failure.code, res.failure.messages), events: [], stat: denied ? 'denied' : 'invalid', changed: false };
        }

        await writeAudit({ ...who, intent: type, target: res.target, summary: res.summary, outcome: 'ok' });
        if (!res.skipSync) await enqueueSync(type, res.target);
        const result: DispatchResult = { ok: true, data: res.data, warnings: res.warnings ?? [], summary: res.summary };
        if (requestKey) await store.put<RequestRecord>('requests', { id: requestKey, at: now(), result });
        return { result, events: res.events ?? [], stat: 'handled', actorId: who.actorId, changed: true };
      });

      bump(stat, outcome.stat === 'handled' ? 'handled' : outcome.stat);
      for (const e of outcome.events) {
        const event: PanelEvent = { type: e.type, at: now(), actorId: outcome.actorId, payload: e.payload ?? {} };
        for (const l of eventListeners) l(event);
      }
      if (outcome.changed) scheduleRefresh();
      return outcome.result;
    } catch (err) {
      // The transaction has been rolled back, so nothing half-done is left behind.
      if (err instanceof DomainError) {
        bump(stat, err.code === 'forbidden' ? 'denied' : 'invalid');
        await writeAudit({
          ...actor,
          intent: type,
          summary: `${err.code === 'forbidden' ? 'Blocked' : 'Rejected'}: ${err.messages[0]}`,
          outcome: err.code === 'forbidden' ? 'denied' : 'invalid',
        });
        return fail(err.code, err.messages);
      }
      bump(stat, 'errors');
      options.onError?.(err, { intent: type });
      try {
        await writeAudit({ ...actor, intent: type, summary: 'Something went wrong. Nothing was changed', outcome: 'error' });
      } catch {
        /* the store itself may be failing; the host has already been told through onError */
      }
      return fail('error', ['Something went wrong. Nothing was saved, so it is safe to try again.']);
    }
  }

  /* ---------- feeds ---------- */

  async function feedInner<K extends FeedName>(name: K, params: FeedMap[K]['params'], token: string | undefined): Promise<FeedResult<FeedMap[K]['data']>> {
    const def = feeds[name];
    if (!def) return { ok: false, error: { code: 'invalid', messages: [`Unknown feed ${String(name)}.`] } };
    const parsed = feedSchemas[name].safeParse(params ?? {});
    if (!parsed.success) return { ok: false, error: { code: 'invalid', messages: describeSchemaProblems(parsed.error) } };

    const session = await resolveSession(token);
    if (def.roles !== 'public') {
      if (!session) return { ok: false, error: { code: 'unauthenticated', messages: ['Sign in with your PIN to continue.'] } };
      if (!def.roles.includes(session.role)) return { ok: false, error: { code: 'forbidden', messages: ['Your role cannot see this.'] } };
    }
    const ctx: FeedCtx = { store, config, clock, terminals, session, stats: () => stats };
    try {
      const built = await (def.build as (c: FeedCtx, p: FeedMap[K]['params']) => Promise<FeedMap[K]['data']>)(ctx, parsed.data as FeedMap[K]['params']);
      return { ok: true, data: built };
    } catch (err) {
      if (err instanceof DomainError) return { ok: false, error: { code: 'invalid', messages: err.messages } };
      options.onError?.(err, { feed: name });
      return { ok: false, error: { code: 'error', messages: ['This could not be loaded. Try again.'] } };
    }
  }

  const feed: Panel['feed'] = (name, params, token) => serial(() => feedInner(name, params, token));

  const subscribe: Panel['subscribe'] = (name, params, token, listener) => {
    let alive = true;
    const run = () => {
      void feed(name, params, token).then((r) => {
        if (alive) listener(r);
      });
    };
    refreshers.add(run);
    run();
    return () => {
      alive = false;
      refreshers.delete(run);
    };
  };

  return {
    dispatch: (type, payload, token, opts = {}) => serial(() => dispatchInner(type, payload, token, opts)),
    feed,
    subscribe,
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    exclusive: (fn) => serial(fn),
    maintain: () =>
      serial(() =>
        store.transaction(async () => {
          const nowMs = clock.now().getTime();
          let sessionsPruned = 0;
          for (const s of await store.list<SessionRecord>('sessions')) {
            if (Date.parse(s.expiresAt) <= nowMs || nowMs - Date.parse(s.lastSeenAt) > config.sessionIdleMs) {
              await store.delete('sessions', s.id);
              sessionsPruned++;
            }
          }
          let requestsPruned = 0;
          for (const r of await store.list<RequestRecord>('requests')) {
            if (nowMs - Date.parse(r.at) > requestTtlMs) {
              await store.delete('requests', r.id);
              requestsPruned++;
            }
          }
          return { sessionsPruned, requestsPruned };
        }),
      ),
  };
}
