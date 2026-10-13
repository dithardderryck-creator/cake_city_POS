import { flushChanges, withChangeLog, type Change, type FlushResult } from './changelog';
import type { Alert, AuditEntry, Device, PairingCode, OutboxItem, PanelEvent, Photo, PhotoData, Role, Session, Staff } from './domain';
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
import { NOT_REGISTERED, deviceIntents, deviceTokenHash } from './circuits/devices';
import { catalogueIntents } from './circuits/catalogue';
import { customIntents } from './circuits/custom';
import { orderIntents } from './circuits/orders';
import { MAX_PHOTO_BYTES, UNATTACHED_PHOTO_TTL_MS, sniffImage } from './circuits/photos';
import { inventoryIntents } from './circuits/inventory';
import { quoteIntents } from './circuits/quotes';
import { recipeIntents } from './circuits/recipes';
import { usageIntents } from './circuits/usage';
import { NOTIFY_ITEM_TTL_MS, notifyIntents, planDue, recordResults } from './circuits/notify';
import { requestIntents } from './circuits/requests';
import { announcementIntents } from './circuits/announcements';
import { countIntents } from './circuits/count';
import { batchIntents } from './circuits/batches';
import { RESOLVED_ALERT_TTL_MS, alertEvents, alertIntents, reconcileAlerts } from './circuits/alerts';
import { settingsIntents } from './circuits/settings';
import { paymentIntents } from './circuits/payments';
import { staffIntents } from './circuits/staff';
import { stockIntents } from './circuits/stock';
import { syncIntents } from './circuits/sync';
import { cleanPayload, describeSchemaProblems, feedSchemas, schemas } from './schemas';
import {
  base64ToBytes,
  bytesToBase64,
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
  type SendResult,
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
  /** What amounts are written in. Default "TSh". Ignored when `formatMoney` is given. */
  currencyLabel?: string;
  lockoutMaxFailures?: number;
  lockoutMinutes?: number[];
  sessionIdleMs?: number;
  sessionMaxMs?: number;
  /** Only registered devices may sign in. Off by default in the panel; the server turns it on unless told not to. */
  requireDevice?: boolean;
  /** How long a pairing code works. Default 10 minutes. */
  pairingCodeMs?: number;
  /** How long a request id is remembered for retry safety. */
  requestTtlMs?: number;
  /** Called for failures nobody expected, so the host can log them with a stack trace. */
  onError?: (err: unknown, info: { intent?: string; feed?: string }) => void;
}

export type PhotoUploadResult =
  | { ok: true; photoId: string; mime: Photo['mime']; size: number }
  | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] } };
export type PhotoReadResult =
  | { ok: true; mime: Photo['mime']; bytes: Uint8Array }
  | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] } };

export interface DispatchOptions {
  /** Send the same id when retrying. If it already succeeded, you get the same answer and nothing runs twice. */
  requestId?: string;
  /** The secret this browser was given when it was registered. */
  deviceToken?: string;
}

export type FeedResult<D> =
  | { ok: true; data: D }
  | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] } };

export interface Panel {
  /** Send an instruction. Passes the breakers, then the circuit, all-or-nothing. */
  dispatch<K extends IntentName>(type: K, payload: IntentMap[K], token?: string, options?: DispatchOptions): Promise<DispatchResult>;
  /** Read display-ready data once. */
  feed<K extends FeedName>(name: K, params: FeedMap[K]['params'], token?: string, deviceToken?: string): Promise<FeedResult<FeedMap[K]['data']>>;
  /** Read a feed and get it again after every change. Returns an unsubscribe function. */
  subscribe<K extends FeedName>(
    name: K,
    params: FeedMap[K]['params'],
    token: string | undefined,
    listener: (r: FeedResult<FeedMap[K]['data']>) => void,
    deviceToken?: string,
  ): () => void;
  /** Is this device allowed in? Used by the server to decide which page to show before anyone signs in. */
  deviceStatus(deviceToken: string | undefined): Promise<{ required: boolean; registered: boolean; name?: string }>;
  onEvent(listener: (e: PanelEvent) => void): () => void;
  /**
   * Store a picture (jpeg, png or webp, up to 5 MB) for a custom cake. Returns an id to pass to
   * `orders/attach_reference_photo`. Pictures that are never attached are removed after a day.
   */
  uploadPhoto(bytes: Uint8Array, token?: string): Promise<PhotoUploadResult>;
  /** Read a stored picture. */
  readPhoto(photoId: string, token?: string): Promise<PhotoReadResult>;
  /** Housekeeping: drop expired sessions, old request ids and unused pictures. Safe to call any time. */
  maintain(): Promise<{ sessionsPruned: number; requestsPruned: number; photosPruned: number; alertsPruned: number; notificationsPruned: number; syncPruned: number }>;
  /**
   * Sends the notifications that are due: push to phones, SMS and WhatsApp through the provider. Failed ones are tried again
   * later with growing waits. The network is never touched while shop work is waiting, so a slow provider cannot slow a sale.
   * The server calls this every few seconds. Safe to call at any time, even twice at once.
   */
  deliver(): Promise<{ sent: number; failed: number; retrying: number }>;
  /** Sends the changes waiting for the online database, oldest first. Safe to call any time; the server calls it every few seconds. */
  syncNow(): Promise<FlushResult>;
  /**
   * Checks every alert condition against the data now and raises or clears alerts. Also runs after changes to orders, stock
   * and usage, but time passing alone (a cake becoming late) needs this called regularly. The server calls it every minute.
   */
  tick(): Promise<{ raised: number; resolved: number }>;
  /** Run something while no instruction or feed is running. Used for consistent backups. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

interface SessionRecord {
  id: string; // sha256 of the token, never the token itself
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** The registered device this sign-in was made on. */
  deviceId?: string;
}

interface RequestRecord {
  id: string;
  at: string;
  result: DispatchResult;
}

const registry = {
  ...authIntents,
  ...deviceIntents,
  ...staffIntents,
  ...catalogueIntents,
  ...stockIntents,
  ...orderIntents,
  ...customIntents,
  ...quoteIntents,
  ...settingsIntents,
  ...inventoryIntents,
  ...recipeIntents,
  ...usageIntents,
  ...alertIntents,
  ...requestIntents,
  ...announcementIntents,
  ...countIntents,
  ...batchIntents,
  ...notifyIntents,
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

/** Money is Tanzanian shillings (TSh). Shillings have no everyday minor unit, so no decimals unless an amount really has them. */
// `n + 0` turns -0 into 0, so a refund total of nothing never reads "TSh -0".
const moneyIn = (label: string) => (n: number) => `${label} ${new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(Math.round(n) + 0)}`;

const HOUR = 3_600_000;

/** Changes in these circuits can start or clear an alert, so alerts are re-checked straight after them. */
const REACTING_CIRCUITS = new Set<CircuitName>(['Orders', 'Quotes', 'Inventory', 'Usage', 'Stock', 'Recipes', 'Messages']);
const TOUCH_EVERY_MS = 60_000;
const SYNC_ITEM_TTL_MS = 7 * 24 * 3_600_000;

export function createPanel(options: PanelOptions = {}): Panel {
  const clock = options.clock ?? systemClock;
  // Every write to shared data is also recorded in the change log, in the same transaction (see changelog.ts).
  const store = withChangeLog(options.store ?? createMemoryStore(), () => clock.now().toISOString());
  const ids = options.ids ?? createIds();
  const secrets = options.secrets ?? createSecrets();
  const hasher = options.hasher ?? createSha256Hasher();
  const terminals = options.terminals ?? {};
  const config: PanelConfig = {
    devicePrefix: options.devicePrefix ?? 'A',
    currencyLabel: options.currencyLabel?.trim() || 'TSh',
    formatMoney: options.formatMoney ?? moneyIn(options.currencyLabel?.trim() || 'TSh'),
    lockoutMaxFailures: options.lockoutMaxFailures ?? 5,
    lockoutMinutes: options.lockoutMinutes ?? [1, 5, 15, 60],
    sessionIdleMs: options.sessionIdleMs ?? 10 * HOUR,
    sessionMaxMs: options.sessionMaxMs ?? 24 * HOUR,
    requireDevice: options.requireDevice ?? false,
    pairingCodeMs: options.pairingCodeMs ?? 10 * 60_000,
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

  let delivering = false;
  const SEND_TIMEOUT_MS = 25_000;
  /** Sends one message through its terminal. Never throws and never hangs: a provider that misbehaves is a retry. */
  async function sendOne(a: Parameters<typeof recordResults>[1][number]['attempt']): Promise<SendResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SendResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, retry: true, error: 'The provider did not answer in time.' }), SEND_TIMEOUT_MS);
    });
    try {
      const run: Promise<SendResult> =
        a.channel === 'push'
          ? terminals.push
            ? terminals.push.send({ endpoint: a.subscription!.endpoint, p256dh: a.subscription!.p256dh, auth: a.subscription!.auth }, a.push)
            : Promise.resolve({ ok: false, retry: false, error: 'Push is not set up on this server.' })
          : terminals.messages
            ? terminals.messages.send({ channel: a.channel, to: a.to, text: a.text })
            : Promise.resolve({ ok: false, retry: false, error: 'No message provider is set up on this server.' });
      return await Promise.race([run, timeout]);
    } catch (err) {
      return { ok: false, retry: true, error: err instanceof Error ? err.message.slice(0, 200) : 'The provider failed.' };
    } finally {
      clearTimeout(timer);
    }
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
    // A sign-in belongs to the device it was made on. Revoke the device and the sign-in stops working at once.
    if (rec.deviceId) {
      const dev = await store.get<Device>('devices', rec.deviceId);
      if (!dev || dev.revokedAt) return null;
    } else if (config.requireDevice) return null;
    if (nowMs - Date.parse(rec.lastSeenAt) > TOUCH_EVERY_MS) await store.put('sessions', { ...rec, lastSeenAt: now() });
    return { userId: staff.id, name: staff.name, role: staff.role };
  }

  /** The registered device behind a secret, or null when it is missing, unknown or revoked. */
  async function resolveDevice(deviceToken: string | undefined): Promise<Device | null> {
    if (!deviceToken || deviceToken.length > 200) return null;
    const hash = await deviceTokenHash(deviceToken);
    const [dev] = await store.find<Device>('devices', { where: { tokenHash: hash }, limit: 1 });
    if (!dev || dev.revokedAt) return null;
    const nowMs = clock.now().getTime();
    if (!dev.lastSeenAt || nowMs - Date.parse(dev.lastSeenAt) > TOUCH_EVERY_MS) await store.put<Device>('devices', { ...dev, lastSeenAt: now() });
    return dev;
  }

  const makeCtx = (session: Session | null, token: string | undefined, device: Device | null = null, deviceToken?: string): HandlerCtx => ({
    store,
    clock,
    ids,
    config,
    terminals,
    hasher,
    secrets,
    session,
    sessionId: token,
    device,
    deviceToken,
    now,
    issueSession: async (s, deviceId) => {
      const issued = secrets.token();
      const at = clock.now().getTime();
      await store.put<SessionRecord>('sessions', {
        id: await sha256Hex(issued),
        userId: s.userId,
        createdAt: new Date(at).toISOString(),
        lastSeenAt: new Date(at).toISOString(),
        expiresAt: new Date(at + config.sessionMaxMs).toISOString(),
        ...(deviceId ? { deviceId } : {}),
      });
      return issued;
    },
    endSession: async (t) => {
      if (t) await store.delete('sessions', await sha256Hex(t));
    },
    revokeDeviceSessions: async (deviceId) => {
      for (const s of await store.find<SessionRecord>('sessions', { where: { deviceId } })) await store.delete('sessions', s.id);
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
    const ctx = makeCtx(session, token, await resolveDevice(opts.deviceToken), opts.deviceToken);

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
    const parsed = schemas[type].safeParse(cleanPayload(payload ?? {}));
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
        const events = [...(res.events ?? [])];
        // Alerts follow the data. If working them out ever fails, the sale or the stock change still goes through,
        // and the next check (which is a full re-read) puts the alerts right.
        if (REACTING_CIRCUITS.has(def.circuit) || type === 'alerts/configure') {
          try {
            events.push(...alertEvents(await reconcileAlerts({ store, ids, clock })));
          } catch (err) {
            options.onError?.(err, { intent: `${type} (alerts)` });
          }
        }
        const result: DispatchResult = { ok: true, data: res.data, warnings: res.warnings ?? [], summary: res.summary };
        if (requestKey) await store.put<RequestRecord>('requests', { id: requestKey, at: now(), result });
        return { result, events, stat: 'handled', actorId: who.actorId, changed: true };
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

  async function feedInner<K extends FeedName>(name: K, params: FeedMap[K]['params'], token: string | undefined, deviceToken?: string): Promise<FeedResult<FeedMap[K]['data']>> {
    const def = feeds[name];
    if (!def) return { ok: false, error: { code: 'invalid', messages: [`Unknown feed ${String(name)}.`] } };
    const parsed = feedSchemas[name].safeParse(params ?? {});
    if (!parsed.success) return { ok: false, error: { code: 'invalid', messages: describeSchemaProblems(parsed.error) } };

    const session = await resolveSession(token);
    if (def.roles !== 'public') {
      if (!session) return { ok: false, error: { code: 'unauthenticated', messages: ['Sign in with your PIN to continue.'] } };
      if (!def.roles.includes(session.role)) return { ok: false, error: { code: 'forbidden', messages: ['Your role cannot see this.'] } };
    }
    const device = await resolveDevice(deviceToken);
    if (def.device === 'required' && config.requireDevice && !device) return { ok: false, error: { code: 'forbidden', messages: [NOT_REGISTERED] } };
    const ctx: FeedCtx = { store, config, clock, terminals, session, device, stats: () => stats };
    try {
      const built = await (def.build as (c: FeedCtx, p: FeedMap[K]['params']) => Promise<FeedMap[K]['data']>)(ctx, parsed.data as FeedMap[K]['params']);
      return { ok: true, data: built };
    } catch (err) {
      if (err instanceof DomainError) return { ok: false, error: { code: 'invalid', messages: err.messages } };
      options.onError?.(err, { feed: name });
      return { ok: false, error: { code: 'error', messages: ['This could not be loaded. Try again.'] } };
    }
  }

  const feed: Panel['feed'] = (name, params, token, deviceToken) => serial(() => feedInner(name, params, token, deviceToken));

  /* ---------- pictures (binary, so they do not travel as intents) ---------- */

  const photoFail = (code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error', message: string) => ({ ok: false as const, error: { code, messages: [message] } });
  const PHOTO_WRITERS: Role[] = ['owner', 'cashier'];
  const PHOTO_READERS: Role[] = ['owner', 'cashier', 'baker'];

  async function uploadPhotoInner(bytes: Uint8Array, token: string | undefined): Promise<PhotoUploadResult> {
    const session = await resolveSession(token);
    if (!session) return photoFail('unauthenticated', 'Sign in with your PIN to continue.');
    if (!PHOTO_WRITERS.includes(session.role)) return photoFail('forbidden', 'Your role cannot do this. Ask the owner.');
    if (bytes.length === 0) return photoFail('invalid', 'That file is empty.');
    if (bytes.length > MAX_PHOTO_BYTES) return photoFail('invalid', 'That picture is too big. Pictures can be up to 5 MB.');
    const mime = sniffImage(bytes);
    if (!mime) return photoFail('invalid', 'Use a JPEG, PNG or WebP picture.');
    try {
      const photo: Photo = { id: ids.next('pho'), mime, size: bytes.length, uploadedBy: session.userId, uploadedAt: now() };
      await store.transaction(async () => {
        await store.put<Photo>('photos', photo);
        await store.put<PhotoData>('photoData', { id: photo.id, data: bytesToBase64(bytes) });
        await writeAudit({ actorId: session.userId, actorName: session.name, role: session.role, intent: 'photos/upload', target: photo.id, summary: 'Uploaded a reference photo', outcome: 'ok' });
      });
      return { ok: true, photoId: photo.id, mime, size: bytes.length };
    } catch (err) {
      options.onError?.(err, { intent: 'photos/upload' });
      return photoFail('error', 'Something went wrong. Nothing was saved, so it is safe to try again.');
    }
  }

  async function readPhotoInner(photoId: string, token: string | undefined): Promise<PhotoReadResult> {
    const session = await resolveSession(token);
    if (!session) return photoFail('unauthenticated', 'Sign in with your PIN to continue.');
    if (!PHOTO_READERS.includes(session.role)) return photoFail('forbidden', 'Your role cannot see this.');
    const [meta, data] = await Promise.all([store.get<Photo>('photos', photoId), store.get<PhotoData>('photoData', photoId)]);
    if (!meta || !data) return photoFail('invalid', 'That picture is no longer available.');
    return { ok: true, mime: meta.mime, bytes: base64ToBytes(data.data) };
  }

  const subscribe: Panel['subscribe'] = (name, params, token, listener, deviceToken) => {
    let alive = true;
    const run = () => {
      void feed(name, params, token, deviceToken).then((r) => {
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
    deviceStatus: (deviceToken) =>
      serial(async () => {
        const device = await resolveDevice(deviceToken);
        return { required: config.requireDevice, registered: !!device, ...(device ? { name: device.name } : {}) };
      }),
    uploadPhoto: (bytes, token) => serial(() => uploadPhotoInner(bytes, token)),
    readPhoto: (photoId, token) => serial(() => readPhotoInner(photoId, token)),
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    exclusive: (fn) => serial(fn),
    syncNow: () => flushChanges(store, terminals.sync),
    deliver: async () => {
      if (delivering) return { sent: 0, failed: 0, retrying: 0 };
      delivering = true;
      try {
        const env = { store, ids, clock, terminals };
        const attempts = await serial(() => store.transaction(() => planDue(env)));
        if (attempts.length === 0) return { sent: 0, failed: 0, retrying: 0 };
        // Network work happens outside the queue. A slow provider never holds up a sale.
        const results: Array<{ attempt: (typeof attempts)[number]; result: SendResult }> = [];
        for (let i = 0; i < attempts.length; i += 8) {
          results.push(...(await Promise.all(attempts.slice(i, i + 8).map(async (attempt) => ({ attempt, result: await sendOne(attempt) })))));
        }
        const tally = await serial(() => store.transaction(() => recordResults(env, results)));
        scheduleRefresh();
        return tally;
      } catch (err) {
        options.onError?.(err, { intent: 'notify/deliver' });
        return { sent: 0, failed: 0, retrying: 0 };
      } finally {
        delivering = false;
      }
    },
    tick: () =>
      serial(async () => {
        try {
          const r = await store.transaction(() => reconcileAlerts({ store, ids, clock }));
          for (const e of alertEvents(r)) {
            const event: PanelEvent = { type: e.type, at: now(), payload: e.payload ?? {} };
            for (const l of eventListeners) l(event);
          }
          if (r.changed) scheduleRefresh();
          return { raised: r.raised.length, resolved: r.resolved.length };
        } catch (err) {
          options.onError?.(err, { intent: 'alerts/tick' });
          return { raised: 0, resolved: 0 };
        }
      }),
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
          for (const c of await store.list<PairingCode>('pairingCodes')) {
            if (nowMs - Date.parse(c.expiresAt) > 24 * HOUR) await store.delete('pairingCodes', c.id);
          }
          let requestsPruned = 0;
          for (const r of await store.list<RequestRecord>('requests')) {
            if (nowMs - Date.parse(r.at) > requestTtlMs) {
              await store.delete('requests', r.id);
              requestsPruned++;
            }
          }
          let photosPruned = 0;
          for (const ph of await store.list<Photo>('photos')) {
            if (!ph.attachedTo && nowMs - Date.parse(ph.uploadedAt) > UNATTACHED_PHOTO_TTL_MS) {
              await store.delete('photos', ph.id);
              await store.delete('photoData', ph.id);
              photosPruned++;
            }
          }
          let alertsPruned = 0;
          for (const a of await store.find<Alert>('alerts', { where: { status: 'resolved' } })) {
            if (a.resolvedAt && nowMs - Date.parse(a.resolvedAt) > RESOLVED_ALERT_TTL_MS) {
              await store.delete('alerts', a.id);
              alertsPruned++;
            }
          }
          let notificationsPruned = 0;
          for (const o of await store.find<OutboxItem>('outbox', { where: { status: ['sent', 'failed'] } })) {
            if (o.kind === 'notify' && nowMs - Date.parse(o.createdAt) > NOTIFY_ITEM_TTL_MS) {
              await store.delete('outbox', o.id);
              notificationsPruned++;
            }
          }
          // Nothing reads `sync` rows (the online copy works from backups), so they are only kept for a week, for diagnosis.
          let syncPruned = 0;
          for (const o of await store.find<OutboxItem>('outbox', { where: { kind: 'sync' }, orderBy: { field: 'createdAt' }, limit: 5000 })) {
            if (nowMs - Date.parse(o.createdAt) <= SYNC_ITEM_TTL_MS) break;
            await store.delete('outbox', o.id);
            syncPruned++;
          }
          // Changes the online database has confirmed are only kept for a week, for diagnosis.
          for (const c of await store.find<Change>('changes', { where: { status: 'sent' }, orderBy: { field: 'seq' }, limit: 5000 })) {
            if (nowMs - Date.parse(c.at) <= SYNC_ITEM_TTL_MS) break;
            await store.delete('changes', c.id);
            syncPruned++;
          }
          return { sessionsPruned, requestsPruned, photosPruned, alertsPruned, notificationsPruned, syncPruned };
        }),
      ),
  };
}
