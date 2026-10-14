/**
 * The till's side of offline selling (see docs/offline-queue-design.md).
 *
 * While online and signed in the till holds an offline pass. When the shop server cannot be reached, an instant sale is
 * written to a queue kept on this device, signed with the pass key and chained to the sale before it. Back online, the
 * queue is sent and the server checks every sale again. The queue survives reloads (it lives in the offline store).
 *
 * The pass key is wiped from the device when the person signs out, so the next person at the till cannot sell as them.
 * Sales already queued do not need the key to be sent, so nothing is lost by signing out.
 */
import type { PaymentMethod, QueuedAction, ReplayItemResult, ReplayResult } from '@cake-pos/panel';
// Only the small signing code is pulled in at run time, not the whole panel.
import { GENESIS_TAG, offlineTagSync } from '@cake-pos/panel/src/offline-proof';

export interface OfflineStore {
  get(): string | null;
  set(value: string | null): void;
}

/** What the till is asked to sell. `expectedTotal` is the total the customer was shown. */
export type OfflineSale = {
  items: Array<{ combinationId: string; qty: number }>;
  method: PaymentMethod;
  reference?: string;
  customerName?: string;
  expectedTotal: number;
};

/** A sale that was not dealt with the normal way. Stays until someone clears it, so a refused sale is never forgotten. */
export interface OfflineNotice {
  id: string;
  /** 'held': waiting for the owner. 'refused': the server would not accept it. 'stuck': could not be sent at all. */
  kind: 'held' | 'refused' | 'stuck';
  message: string;
  at: string;
  /** The device's own number for the sale, to find it again on paper. */
  seq: number;
  total: number;
  madeAt: string;
  items: Array<{ combinationId: string; qty: number }>;
  method: string;
}

export interface OfflineStatus {
  /** A pass is held, so a sale can be saved here if the server cannot be reached. */
  canSell: boolean;
  /** Why not, when `canSell` is false and a pass was expected. */
  reason: string | null;
  expiresAt: string | null;
  /** Sales saved on this device and not yet confirmed by the server. */
  waiting: number;
  salesLeft: number | null;
  moneyLeft: number | null;
  notices: OfflineNotice[];
  sending: boolean;
  /** The most recent sales the server accepted after a wait, newest first. */
  sent: Array<{ seq: number; number: string | null; total: number | null; at: string }>;
}

export type QuickSaleResult =
  | { ok: true; queued: false; data: unknown; warnings: string[]; summary: string }
  | { ok: true; queued: true; seq: number; madeAt: string; total: number; waiting: number; message: string }
  | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error' | 'offline'; messages: string[] } };

export interface OfflineTill {
  status(): OfflineStatus;
  /** Sell now, or if the server cannot be reached and the pass allows, save it on this device to send later. */
  quickSale(sale: OfflineSale): Promise<QuickSaleResult>;
  /** Send what is waiting. Safe to call any time, even twice at once. */
  flush(): Promise<{ left: number }>;
  /** Ask for a fresh pass if the one held is missing or close to running out. Needs the server. */
  refreshPass(force?: boolean): Promise<boolean>;
  /** Dismiss the notices once someone has read them. */
  clearNotices(): void;
  onChange(listener: () => void): () => void;
}

interface QueuedSale extends QueuedAction {
  tag: string;
  total: number;
  method: string;
}

interface StoredPass {
  passId: string;
  userId: string;
  /** Gone after sign-out. */
  key?: string;
  issuedAt: string;
  expiresAt: string;
  maxSales: number;
  maxTotal: number;
  /** Server clock minus device clock when the pass was given, so sales are stamped with the shop's time. */
  offset: number;
  nextSeq: number;
  lastTag: string;
  /** Sales saved under this pass so far (sent or not) and their total: what the limits count. */
  sales: number;
  total: number;
  queue: QueuedSale[];
}

interface Stored {
  v: 1;
  passes: Record<string, StoredPass>;
  currentPassId?: string;
  notices: OfflineNotice[];
  sent: OfflineStatus['sent'];
}

const empty = (): Stored => ({ v: 1, passes: {}, notices: [], sent: [] });
const MAX_NOTICES = 100;
const FLUSH_EVERY_MS = 15_000;
const RENEW_WHEN_LEFT_MS = 60 * 60_000;
const DISABLED_RETRY_MS = 10 * 60_000;

export interface OfflineDeps {
  store: OfflineStore;
  /** Who is signed in now, or null. */
  me(): { userId: string } | null;
  /** The ordinary online request, with short limits. Resolves 'offline' when the server could not be reached in time. */
  dispatchNow(type: string, payload: unknown, requestId: string, quick: boolean): Promise<{ status: number; json: unknown } | 'offline'>;
  /** Send a queue to the server. No sign-in needed. */
  replay(body: unknown): Promise<{ status: number; json: unknown } | 'offline'>;
  /** The connection state of the live link, when one exists. */
  connection(): 'connecting' | 'online' | 'offline';
  randomId(): string;
  /** Tell the client its sign-in was refused (401). */
  lostSignIn(): void;
  now?: () => number;
}

export function createOfflineTill(d: OfflineDeps) {
  const nowMs = d.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let sending = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let noPassUntil = 0;
  let lastReason: string | null = null;

  function load(): Stored {
    try {
      const raw = d.store.get();
      if (!raw) return empty();
      const j = JSON.parse(raw) as Stored;
      return j && j.v === 1 && j.passes ? { ...empty(), ...j } : empty();
    } catch {
      return empty();
    }
  }
  /** Reads, changes and writes in one go with nothing awaited in between, so two tabs cannot hand out the same number. */
  function update<T>(fn: (s: Stored) => T): T {
    const s = load();
    const out = fn(s);
    try {
      d.store.set(JSON.stringify(s));
    } catch {
      /* storage full or blocked: the queue still works for this page, but would not survive a reload */
    }
    for (const l of listeners) l();
    ensureTimer();
    return out;
  }

  const waitingOf = (s: Stored) => Object.values(s.passes).reduce((n, p) => n + p.queue.length, 0);

  function ensureTimer() {
    const need = waitingOf(load()) > 0;
    if (need && !timer) timer = setInterval(() => void tick(), FLUSH_EVERY_MS);
    else if (!need && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  async function tick() {
    await flush();
  }

  function current(s: Stored): StoredPass | null {
    const me = d.me();
    const p = s.currentPassId ? s.passes[s.currentPassId] : undefined;
    if (!p || !me || p.userId !== me.userId || !p.key) return null;
    return p;
  }

  function status(): OfflineStatus {
    const s = load();
    const p = current(s);
    const usable = !!p && Date.parse(p.expiresAt) > nowMs() + p.offset;
    return {
      canSell: usable,
      reason: usable ? null : lastReason,
      expiresAt: p?.expiresAt ?? null,
      waiting: waitingOf(s),
      salesLeft: p ? Math.max(0, p.maxSales - p.sales) : null,
      moneyLeft: p ? Math.max(0, p.maxTotal - p.total) : null,
      notices: s.notices,
      sending,
      sent: s.sent,
    };
  }

  async function refreshPass(force = false): Promise<boolean> {
    const me = d.me();
    if (!me) return false;
    const s = load();
    const have = current(s);
    if (!force && have && Date.parse(have.expiresAt) - (nowMs() + have.offset) > RENEW_WHEN_LEFT_MS && have.sales < have.maxSales) return true;
    if (!force && nowMs() < noPassUntil) return !!have;
    // Whatever the old pass still holds goes first, so nothing waits on a pass that is about to be closed.
    await flush();
    const r = await d.dispatchNow('offline/get_pass', {}, d.randomId(), false);
    if (r === 'offline') return !!have;
    if (r.status === 401) {
      d.lostSignIn();
      return false;
    }
    const j = r.json as { ok: boolean; data?: Record<string, unknown>; error?: { messages: string[] } } | null;
    if (!j?.ok || !j.data) {
      lastReason = j?.error?.messages?.[0] ?? 'Offline selling is not available.';
      noPassUntil = nowMs() + DISABLED_RETRY_MS;
      return false;
    }
    const data = j.data as { passId: string; key: string; userId: string; issuedAt: string; expiresAt: string; maxSales: number; maxTotal: number; serverTime: string };
    lastReason = null;
    update((st) => {
      for (const p of Object.values(st.passes)) delete p.key; // one key at a time
      st.passes[data.passId] = {
        passId: data.passId,
        userId: data.userId,
        key: data.key,
        issuedAt: data.issuedAt,
        expiresAt: data.expiresAt,
        maxSales: data.maxSales,
        maxTotal: data.maxTotal,
        offset: Date.parse(data.serverTime) - nowMs(),
        nextSeq: 1,
        lastTag: GENESIS_TAG,
        sales: 0,
        total: 0,
        queue: [],
      };
      st.currentPassId = data.passId;
      // Passes with nothing left to send are no use any more.
      for (const [id, p] of Object.entries(st.passes)) if (id !== data.passId && p.queue.length === 0) delete st.passes[id];
    });
    return true;
  }

  async function quickSale(sale: OfflineSale): Promise<QuickSaleResult> {
    const requestId = d.randomId();
    const payload = { ...sale };
    const canTry = status().canSell;
    const r = await d.dispatchNow('orders/quick_sale', payload, requestId, canTry);
    if (r !== 'offline') {
      if (r.status === 401) d.lostSignIn();
      const j = r.json as { ok: boolean; data?: unknown; warnings?: string[]; summary?: string; error?: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] } } | null;
      if (j?.ok) return { ok: true, queued: false, data: j.data, warnings: j.warnings ?? [], summary: j.summary ?? '' };
      return { ok: false, error: j?.error ?? { code: 'error', messages: ['The server gave an answer this app does not understand.'] } };
    }

    // The server could not be reached. The request may still have arrived, so the queued sale keeps the same request id:
    // if the server already made the sale, replaying it just gets that answer back, and nothing is sold twice.
    const queued = update((st): QuickSaleResult => {
      const p = current(st);
      const no = (message: string): QuickSaleResult => ({ ok: false, error: { code: 'offline', messages: [message] } });
      if (!p) return no('Cannot reach the shop server, and this till is not set up to sell offline. Check the wifi. The last sale may or may not have gone through. Tap Pay again when the wifi is back: it will not be done twice.');
      const at = nowMs() + p.offset;
      if (Date.parse(p.expiresAt) <= at) return no('Cannot reach the shop server, and the offline permission has run out. Ask the owner, or wait for the wifi.');
      if (p.sales + 1 > p.maxSales) return no(`Cannot reach the shop server, and this till has already saved ${p.maxSales} sales offline, which is the limit. Wait for the wifi.`);
      if (p.total + sale.expectedTotal > p.maxTotal) return no('Cannot reach the shop server, and this sale would take the offline total over the limit. Wait for the wifi.');
      const a: QueuedAction = { seq: p.nextSeq, requestId, type: 'orders/quick_sale', payload, queuedAt: new Date(at).toISOString() };
      const tag = offlineTagSync(p.key!, p.passId, p.lastTag, a);
      p.queue.push({ ...a, tag, total: sale.expectedTotal, method: sale.method });
      p.nextSeq += 1;
      p.lastTag = tag;
      p.sales += 1;
      p.total += sale.expectedTotal;
      return { ok: true, queued: true, seq: a.seq, madeAt: a.queuedAt, total: sale.expectedTotal, waiting: waitingOf(st), message: 'Saved on this till. It will be sent when the wifi is back.' };
    });
    return queued;
  }

  async function flush(): Promise<{ left: number }> {
    if (sending) return { left: waitingOf(load()) };
    sending = true;
    for (const l of listeners) l();
    try {
      for (;;) {
        const s = load();
        const p = Object.values(s.passes).find((x) => x.queue.length > 0);
        if (!p) break;
        const batch = p.queue.slice(0, 200);
        const r = await d.replay({ passId: p.passId, actions: batch.map(({ seq, requestId, type, payload, queuedAt, tag }) => ({ seq, requestId, type, payload, queuedAt, tag })) });
        if (r === 'offline') break;
        const j = r.json as ReplayResult | null;
        if (!j || typeof j !== 'object' || !('ok' in j)) break; // an answer we do not understand: keep everything and try later
        if (!j.ok) {
          if (j.error.code === 'error' || r.status >= 500) break;
          // The server refused the whole queue (device, pass or person). The sales are real: keep them on view, never silently drop them.
          update((st) => {
            const sp = st.passes[p.passId];
            if (!sp) return;
            for (const q of batch) addNotice(st, 'stuck', j.error.messages[0] ?? 'The server would not accept this sale.', q);
            sp.queue = sp.queue.filter((q) => !batch.some((b) => b.seq === q.seq));
          });
          continue;
        }
        let progressed = false;
        update((st) => {
          const sp = st.passes[p.passId];
          if (!sp) return;
          for (const res of j.results) {
            const q = batch.find((b) => b.seq === res.seq);
            if (!q || res.status === 'retry') continue;
            progressed = true;
            sp.queue = sp.queue.filter((x) => x.seq !== q.seq);
            if (res.status === 'held') addNotice(st, 'held', res.message, q);
            else if (res.status === 'rejected') addNotice(st, 'refused', res.message, q);
            else rememberSent(st, q, res);
          }
          if (sp.queue.length === 0 && st.currentPassId !== sp.passId) delete st.passes[sp.passId];
        });
        if (!progressed) break; // a server failure: try again on the next round
      }
    } finally {
      sending = false;
      for (const l of listeners) l();
    }
    return { left: waitingOf(load()) };
  }

  function addNotice(st: Stored, kind: OfflineNotice['kind'], message: string, q: QueuedSale) {
    const sale = q.payload as { items?: OfflineSale['items'] };
    st.notices.push({ id: d.randomId(), kind, message, at: new Date(nowMs()).toISOString(), seq: q.seq, total: q.total, madeAt: q.queuedAt, items: Array.isArray(sale?.items) ? sale.items : [], method: q.method });
    if (st.notices.length > MAX_NOTICES) st.notices.splice(0, st.notices.length - MAX_NOTICES);
  }
  function rememberSent(st: Stored, q: QueuedSale, res: ReplayItemResult) {
    st.sent.unshift({ seq: q.seq, number: res.number ?? null, total: res.total ?? q.total, at: new Date(nowMs()).toISOString() });
    st.sent.length = Math.min(st.sent.length, 20);
  }

  return {
    status,
    quickSale,
    flush,
    refreshPass,
    clearNotices: () =>
      update((st) => {
        st.notices = [];
      }),
    onChange: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** Called on sign-out: the key goes, the waiting sales stay. */
    forgetKeys: () =>
      update((st) => {
        for (const p of Object.values(st.passes)) delete p.key;
      }),
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    connectionChanged: () => {
      if (d.connection() === 'online') void flush();
    },
  };
}

