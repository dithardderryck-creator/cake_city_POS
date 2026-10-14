import type { CollectionName, Store, SyncTerminal } from './ports';
import { COLLECTIONS } from './ports';

/**
 * The change log: every record saved or deleted, in order, with its full content.
 * This is what an online database is fed from, so it can be rebuilt or caught up after the connection was down.
 * Changes are written in the same transaction as the work they belong to, so a crash never leaves one without the other.
 */
export interface Change {
  /** Sortable and unique: chg_ plus the sequence number. A resend carries the same id, so the receiver can ignore repeats. */
  id: string;
  seq: number;
  collection: CollectionName;
  recordId: string;
  op: 'put' | 'delete';
  /** The whole record after a put. Absent for a delete. */
  record?: unknown;
  at: string;
  status: 'pending' | 'sent';
}

/** Things that belong to one machine or are only housekeeping. They are never copied online. */
const LOCAL_ONLY: ReadonlySet<string> = new Set(['changes', 'outbox', 'sessions', 'loginState', 'pushSubscriptions', 'photoData', 'devices', 'pairingCodes', 'offlinePasses', 'serverKeys', 'offlineLog']);
export const isSynced = (c: string) => !LOCAL_ONLY.has(c);

interface Counter {
  id: string;
  value: number;
}

async function record(inner: Store, now: () => string, collection: CollectionName, recordId: string, op: 'put' | 'delete', rec?: unknown) {
  const counter = (await inner.get<Counter>('counters', 'change_seq')) ?? { id: 'change_seq', value: 0 };
  counter.value += 1;
  await inner.put('counters', counter);
  const seq = counter.value;
  const change: Change = { id: `chg_${String(seq).padStart(12, '0')}`, seq, collection, recordId, op, ...(op === 'put' ? { record: rec } : {}), at: now(), status: 'pending' };
  await inner.put('changes', change);
}

/** Wraps a store so every write to shared data also lands in the change log. */
export function withChangeLog(inner: Store, now: () => string): Store {
  return {
    get: (c, id) => inner.get(c, id),
    list: (c) => inner.list(c),
    find: (c, o) => inner.find(c, o),
    transaction: (fn) => inner.transaction(fn),
    async put(c, rec) {
      await inner.put(c, rec);
      if (isSynced(c)) await record(inner, now, c, rec.id, 'put', rec);
    },
    async delete(c, id) {
      await inner.delete(c, id);
      if (isSynced(c)) await record(inner, now, c, id, 'delete');
    },
  };
}

/** Queue every record that exists now, for a new online database or one that was lost. Returns how many were queued. */
export async function queueFullCopy(store: Store, now: () => string): Promise<number> {
  let n = 0;
  for (const c of COLLECTIONS) {
    if (!isSynced(c)) continue;
    for (const rec of await store.list<{ id: string }>(c)) {
      await record(store, now, c, rec.id, 'put', rec);
      n++;
    }
  }
  return n;
}

export type FlushState = 'sent' | 'nothing' | 'not_set_up' | 'offline' | 'failed';
export interface FlushResult {
  state: FlushState;
  sent: number;
  pending: number;
  error?: string;
}

const flushing = new WeakSet<Store>();

/**
 * Sends waiting changes in order, a batch at a time. A batch is marked sent only after the receiver confirms it,
 * and the first failure stops the run, so order is kept and nothing is lost: the next run resumes from the same place.
 */
export async function flushChanges(store: Store, terminal: SyncTerminal | undefined, batchSize = 200): Promise<FlushResult> {
  const pendingCount = async () => (await store.find<Change>('changes', { where: { status: 'pending' } })).length;
  if (!terminal?.pushChanges) return { state: 'not_set_up', sent: 0, pending: await pendingCount() };
  if (flushing.has(store)) return { state: 'nothing', sent: 0, pending: await pendingCount() };
  flushing.add(store);
  try {
    if (!terminal.isOnline()) return { state: 'offline', sent: 0, pending: await pendingCount() };
    let sent = 0;
    for (;;) {
      const batch = await store.find<Change>('changes', { where: { status: 'pending' }, orderBy: { field: 'seq', dir: 'asc' }, limit: batchSize });
      if (batch.length === 0) break;
      const res = await terminal.pushChanges(batch);
      if (!res.ok) return { state: 'failed', sent, pending: await pendingCount(), error: res.error };
      await store.transaction(async () => {
        for (const c of batch) await store.put('changes', { ...c, status: 'sent' as const });
      });
      sent += batch.length;
    }
    return { state: sent ? 'sent' : 'nothing', sent, pending: 0 };
  } finally {
    flushing.delete(store);
  }
}
