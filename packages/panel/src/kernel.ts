import type { AuditEntry, OutboxItem, PanelEvent, Session } from './domain';
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
import { stockIntents } from './circuits/stock';
import { syncIntents } from './circuits/sync';
import { createIds, createMemoryStore, systemClock, type Clock, type Ids, type Store, type Terminals } from './ports';

export interface PanelOptions {
  store?: Store;
  clock?: Clock;
  ids?: Ids;
  terminals?: Terminals;
  /** Short prefix that keeps order numbers unique across devices. */
  devicePrefix?: string;
  formatMoney?: (n: number) => string;
}

export type FeedResult<D> =
  | { ok: true; data: D }
  | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'error'; messages: string[] } };

export interface Panel {
  /** Send an instruction. Passes the breakers, then the circuit. */
  dispatch<K extends IntentName>(type: K, payload: IntentMap[K], sessionId?: string): Promise<DispatchResult>;
  /** Read display-ready data once. */
  feed<K extends FeedName>(name: K, params: FeedMap[K]['params'], sessionId?: string): Promise<FeedResult<FeedMap[K]['data']>>;
  /** Read a feed and get it again after every change. Returns an unsubscribe function. */
  subscribe<K extends FeedName>(
    name: K,
    params: FeedMap[K]['params'],
    sessionId: string | undefined,
    listener: (r: FeedResult<FeedMap[K]['data']>) => void,
  ): () => void;
  onEvent(listener: (e: PanelEvent) => void): () => void;
}

const registry = {
  ...authIntents,
  ...catalogueIntents,
  ...stockIntents,
  ...orderIntents,
  ...paymentIntents,
  ...syncIntents,
} as Registry;

export const INTENT_NAMES = Object.keys(registry) as IntentName[];

const defaultMoney = (n: number) =>
  new Intl.NumberFormat('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);

export function createPanel(options: PanelOptions = {}): Panel {
  const store = options.store ?? createMemoryStore();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createIds();
  const terminals = options.terminals ?? {};
  const config: PanelConfig = {
    devicePrefix: options.devicePrefix ?? 'A',
    formatMoney: options.formatMoney ?? defaultMoney,
  };

  const sessions = new Map<string, Session>();
  const eventListeners = new Set<(e: PanelEvent) => void>();
  const refreshers = new Set<() => void>();
  const stats = new Map<CircuitName, CircuitStat>();
  for (const def of Object.values(registry) as IntentDef<unknown>[]) {
    if (!stats.has(def.circuit))
      stats.set(def.circuit, { handled: 0, denied: 0, invalid: 0, errors: 0, lastActivityAt: null });
  }

  const now = () => clock.now().toISOString();

  let refreshQueued = false;
  const scheduleRefresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      for (const r of refreshers) r();
    });
  };

  const makeCtx = (session: Session | null, sessionId: string | undefined): HandlerCtx => ({
    store,
    clock,
    ids,
    config,
    terminals,
    session,
    sessionId,
    now,
    issueSession: (s) => {
      const id = ids.next('ses');
      sessions.set(id, s);
      return id;
    },
    endSession: (id) => {
      if (id) sessions.delete(id);
    },
  });

  /** Breaker 3: every attempt is written to the audit log, whether it worked or not (BR-21). */
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

  const fail = (
    code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error',
    messages: string[],
  ): DispatchResult => ({ ok: false, error: { code, messages } });

  async function dispatch<K extends IntentName>(type: K, payload: IntentMap[K], sessionId?: string): Promise<DispatchResult> {
    const def = registry[type] as IntentDef<IntentMap[K]> | undefined;
    if (!def) return fail('invalid', [`Unknown instruction ${String(type)}.`]);
    const stat = stats.get(def.circuit)!;
    const session = sessionId ? (sessions.get(sessionId) ?? null) : null;
    const actor = session ? { actorId: session.userId, actorName: session.name, role: session.role } : {};
    const touch = () => (stat.lastActivityAt = now());
    const ctx = makeCtx(session, sessionId);

    // Breaker 1: PIN and role.
    if (def.roles !== 'public') {
      if (!session) {
        stat.denied++;
        touch();
        await writeAudit({ intent: type, summary: 'Blocked: not signed in', outcome: 'denied' });
        return fail('unauthenticated', ['Sign in with your PIN to continue.']);
      }
      if (!def.roles.includes(session.role)) {
        stat.denied++;
        touch();
        await writeAudit({ ...actor, intent: type, summary: `Blocked: ${session.role} cannot do this`, outcome: 'denied' });
        return fail('forbidden', ['Your role cannot do this. Ask the owner.']);
      }
    }

    try {
      // Breaker 2: validation.
      if (def.validate) {
        const errors = await def.validate(payload, ctx);
        if (errors.length) {
          stat.invalid++;
          touch();
          await writeAudit({ ...actor, intent: type, summary: `Rejected: ${errors[0]}`, outcome: 'invalid' });
          return fail('invalid', errors);
        }
      }

      // The circuit.
      const result = await def.handle(payload, ctx);
      stat.handled++;
      touch();
      const who = result.actor
        ? { actorId: result.actor.userId, actorName: result.actor.name, role: result.actor.role }
        : actor;
      await writeAudit({ ...who, intent: type, target: result.target, summary: result.summary, outcome: 'ok' });
      if (!result.skipSync) await enqueueSync(type, result.target);

      for (const e of result.events ?? []) {
        const event: PanelEvent = { type: e.type, at: now(), actorId: who.actorId, payload: e.payload ?? {} };
        for (const l of eventListeners) l(event);
      }
      scheduleRefresh();
      return { ok: true, data: result.data, warnings: result.warnings ?? [], summary: result.summary };
    } catch (err) {
      if (err instanceof DomainError) {
        if (err.code === 'forbidden') stat.denied++;
        else stat.invalid++;
        touch();
        await writeAudit({
          ...actor,
          intent: type,
          summary: `${err.code === 'forbidden' ? 'Blocked' : 'Rejected'}: ${err.messages[0]}`,
          outcome: err.code === 'forbidden' ? 'denied' : 'invalid',
        });
        return fail(err.code, err.messages);
      }
      stat.errors++;
      touch();
      await writeAudit({ ...actor, intent: type, summary: 'Something went wrong', outcome: 'error' });
      return fail('error', ['Something went wrong. Nothing was lost, so try again.']);
    }
  }

  async function feed<K extends FeedName>(
    name: K,
    params: FeedMap[K]['params'],
    sessionId?: string,
  ): Promise<FeedResult<FeedMap[K]['data']>> {
    const def = feeds[name];
    const session = sessionId ? (sessions.get(sessionId) ?? null) : null;
    if (def.roles !== 'public') {
      if (!session) return { ok: false, error: { code: 'unauthenticated', messages: ['Sign in with your PIN to continue.'] } };
      if (!def.roles.includes(session.role))
        return { ok: false, error: { code: 'forbidden', messages: ['Your role cannot see this.'] } };
    }
    const ctx: FeedCtx = {
      store,
      config,
      clock,
      terminals,
      session,
      stats: () => stats,
      activeSessions: () => sessions.size,
    };
    try {
      const data = await (def.build as (c: FeedCtx, p: FeedMap[K]['params']) => Promise<FeedMap[K]['data']>)(ctx, params);
      return { ok: true, data };
    } catch (err) {
      const message = err instanceof DomainError ? err.messages : ['This could not be loaded. Try again.'];
      return { ok: false, error: { code: 'error', messages: message } };
    }
  }

  function subscribe<K extends FeedName>(
    name: K,
    params: FeedMap[K]['params'],
    sessionId: string | undefined,
    listener: (r: FeedResult<FeedMap[K]['data']>) => void,
  ) {
    let alive = true;
    const run = () => {
      void feed(name, params, sessionId).then((r) => {
        if (alive) listener(r);
      });
    };
    refreshers.add(run);
    run();
    return () => {
      alive = false;
      refreshers.delete(run);
    };
  }

  return {
    dispatch,
    feed,
    subscribe,
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
  };
}
