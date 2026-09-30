import type { OutboxItem } from './domain';

/** Every collection the panel persists. Add new ones here and in the IndexedDB adapter. */
export const COLLECTIONS = [
  'staff',
  'optionGroups',
  'optionValues',
  'products',
  'combinations',
  'orders',
  'orderLines',
  'payments',
  'refunds',
  'stockMovements',
  'countDifferences',
  'audit',
  'outbox',
  'counters',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** Terminal: local storage. Swap the implementation without touching any circuit. */
export interface Store {
  get<T extends { id: string }>(collection: CollectionName, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(collection: CollectionName, record: T): Promise<void>;
  list<T extends { id: string }>(collection: CollectionName): Promise<T[]>;
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(prefix: string): string;
}

/** Terminal: cloud sync. Not built yet; the panel works without it and queues in the outbox. */
export interface SyncTerminal {
  isOnline(): boolean;
  push(items: OutboxItem[]): Promise<void>;
}

export interface Terminals {
  sync?: SyncTerminal;
}

export function createMemoryStore(): Store {
  const data = new Map<CollectionName, Map<string, unknown>>();
  const bucket = (c: CollectionName) => {
    let b = data.get(c);
    if (!b) {
      b = new Map();
      data.set(c, b);
    }
    return b;
  };
  return {
    async get<T extends { id: string }>(c: CollectionName, id: string) {
      const v = bucket(c).get(id);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async put<T extends { id: string }>(c: CollectionName, record: T) {
      bucket(c).set(record.id, structuredClone(record));
    },
    async list<T extends { id: string }>(c: CollectionName) {
      return [...bucket(c).values()].map((v) => structuredClone(v) as T);
    },
  };
}

export function createIds(): Ids {
  return {
    next: (prefix) => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
  };
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Demo-grade PIN hashing (salted with the user id). Good enough to keep PINs out of plain text
 * on a device; real deployments should verify PINs server-side once the cloud terminal exists.
 */
export async function hashPin(userId: string, pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${userId}:${pin}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
