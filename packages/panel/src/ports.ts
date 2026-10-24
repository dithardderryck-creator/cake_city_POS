import type { OutboxItem } from './domain';

/** Every collection the panel persists. Add new ones here; the storage adapters pick them up. */
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
  'sessions',
  'loginState',
  'requests',
  'quotes',
  'photos',
  'photoData',
  'settings',
  'ingredients',
  'ingredientMovements',
  'recipeRules',
  'usageSuggestions',
  'usageReports',
  'alerts',
  'pushSubscriptions',
  'staffRequests',
  'announcements',
  'countSessions',
  'batches',
  'changes',
  'devices',
  'pairingCodes',
  'offlinePasses',
  'heldActions',
  'serverKeys',
  'offlineLog',
  'dayCloses',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

export type WhereValue = string | number | boolean | null | Array<string | number>;
export interface FindOptions {
  /** Equality on top-level fields. An array means "any of these". */
  where?: Record<string, WhereValue>;
  orderBy?: { field: string; dir?: 'asc' | 'desc' };
  limit?: number;
}

/**
 * Terminal: storage. The panel never knows what is behind this.
 *
 * transaction(): everything written inside `fn` is committed together, or none of it is.
 * The panel runs one transaction per instruction and serialises them, so adapters do not
 * need to handle two transactions at once.
 */
export interface Store {
  get<T extends { id: string }>(collection: CollectionName, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(collection: CollectionName, record: T): Promise<void>;
  delete(collection: CollectionName, id: string): Promise<void>;
  list<T extends { id: string }>(collection: CollectionName): Promise<T[]>;
  find<T extends { id: string }>(collection: CollectionName, options?: FindOptions): Promise<T[]>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(prefix: string): string;
}

/** Long, unguessable tokens for sessions. 256 bits from the platform's secure random source. */
export interface Secrets {
  token(): string;
}

/** How PINs are stored and checked. The server uses scrypt; the browser demo uses a salted SHA-256. */
export interface PinHasher {
  hash(userId: string, pin: string): Promise<string>;
  verify(stored: string, userId: string, pin: string): Promise<boolean>;
}

/** Terminal: cloud sync. Not built yet; the panel works without it and queues in the outbox. */
export interface SyncTerminal {
  isOnline(): boolean;
  push(items: OutboxItem[]): Promise<void>;
  /**
   * Send changes, oldest first, to the online database. Resolve ok only once the receiver has stored them all;
   * the same change may arrive twice after a failure, so the receiver must ignore ids it already has. Must give up after its own timeout.
   */
  pushChanges?(changes: import('./changelog').Change[]): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface BackupStatus {
  lastOkAt: string | null;
  lastError: string | null;
  pendingUploads: number;
  lastFile: string | null;
}

/** Terminal: backups. Read-only view for the panel map. */
export interface BackupTerminal {
  status(): Promise<BackupStatus>;
}

/** Terminal: facts about the machine the panel runs on, for the IT panel map. */
export interface SystemTerminal {
  info(): Promise<Array<{ label: string; value: string }>>;
}

/** What a terminal says after trying to send. `retry` says whether trying again later could help. */
export type SendResult = { ok: true; id?: string } | { ok: false; retry: boolean; error: string; gone?: boolean };

/** Terminal: SMS and WhatsApp through a provider. Must give up after its own timeout. */
export interface MessageTerminal {
  /** Which channels this provider can send. */
  channels(): Array<'sms' | 'whatsapp'>;
  send(message: { channel: 'sms' | 'whatsapp'; to: string; text: string }): Promise<SendResult>;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag instead of piling up. */
  tag: string;
  severity: 'warning' | 'critical' | 'test';
  /** The screen to open when it is tapped. */
  screen: string;
  alertId?: string;
}

/** Terminal: Web Push to phones and browsers that subscribed. Must give up after its own timeout. */
export interface PushTerminal {
  /** The public key a browser needs to subscribe. */
  publicKey: string;
  send(subscription: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload): Promise<SendResult>;
}

/** How one connected Google account is doing. `full` and `needs_signin` are the ones a person has to act on. */
export type DriveAccountState = 'ok' | 'full' | 'needs_signin' | 'unreachable' | 'error' | 'paused' | 'unknown';

export interface DriveAccountView {
  id: string;
  /** The Google account's address, once Google has told us. */
  email: string | null;
  connectedAt: string;
  state: DriveAccountState;
  usedBytes: number | null;
  /** Null for accounts with unlimited storage. */
  limitBytes: number | null;
  checkedAt: string | null;
  lastOkAt: string | null;
  /** Plain words about what is wrong, when something is. */
  problem: string | null;
  /** 1 is used first; the next one takes over when this one is full. */
  position: number;
}

/** A sign-in waiting for someone to type a code on google.com/device, or how the last one ended. */
export interface DriveConnectView {
  state: 'waiting' | 'done' | 'failed';
  userCode?: string;
  url?: string;
  expiresAt?: string;
  email?: string;
  message?: string;
  at: string;
}

export interface DriveStatus {
  /** Whether the Google client ID and secret are known, so a sign-in can be started. */
  clientReady: boolean;
  clientFrom: 'environment' | 'saved' | null;
  folderName: string;
  accounts: DriveAccountView[];
  connect: DriveConnectView | null;
  /** Something wrong with the saved sign-in file itself. */
  problem: string | null;
}

export type DriveResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Terminal: the shop's Google Drive accounts, used for online copies of the backups and the archive. */
export interface DriveTerminal {
  status(): Promise<DriveStatus>;
  saveClient(clientId: string, clientSecret: string): Promise<DriveResult>;
  startConnect(): Promise<DriveResult<{ userCode: string; url: string; expiresAt: string }>>;
  cancelConnect(): Promise<DriveResult>;
  remove(accountId: string): Promise<DriveResult<{ email: string | null }>>;
  move(accountId: string, direction: 'up' | 'down'): Promise<DriveResult>;
  pause(accountId: string, paused: boolean): Promise<DriveResult<{ email: string | null }>>;
  /** Checks one account (or all of them) now and updates what the status says. */
  test(accountId?: string): Promise<DriveResult>;
}

export interface Terminals {
  drive?: DriveTerminal;
  messages?: MessageTerminal;
  push?: PushTerminal;
  sync?: SyncTerminal;
  backup?: BackupTerminal;
  system?: SystemTerminal;
}

/* ---------- Helpers shared by adapters ---------- */

export function matchesWhere(record: unknown, where: FindOptions['where']): boolean {
  if (!where) return true;
  const r = record as Record<string, unknown>;
  return Object.entries(where).every(([field, want]) => {
    const have = r[field];
    if (Array.isArray(want)) return want.includes(have as string | number);
    if (want === null) return have === null || have === undefined;
    return have === want;
  });
}

export function applyFindOptions<T>(rows: T[], options: FindOptions = {}): T[] {
  let out = rows.filter((r) => matchesWhere(r, options.where));
  if (options.orderBy) {
    const { field, dir = 'asc' } = options.orderBy;
    const sign = dir === 'desc' ? -1 : 1;
    out = [...out].sort((a, b) => {
      const av = (a as Record<string, unknown>)[field] as string | number | undefined;
      const bv = (b as Record<string, unknown>)[field] as string | number | undefined;
      if (av === bv) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return av < bv ? -sign : sign;
    });
  }
  if (options.limit !== undefined) out = out.slice(0, options.limit);
  return out;
}

/** In-memory store for tests and the browser demo. Transactions roll back through a change journal. */
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
  type JournalEntry = { c: CollectionName; id: string; before: unknown };
  let journal: JournalEntry[] | null = null;
  const remember = (c: CollectionName, id: string) => {
    if (journal) journal.push({ c, id, before: bucket(c).get(id) });
  };

  const store: Store = {
    async get<T extends { id: string }>(c: CollectionName, id: string) {
      const v = bucket(c).get(id);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async put<T extends { id: string }>(c: CollectionName, record: T) {
      remember(c, record.id);
      bucket(c).set(record.id, structuredClone(record));
    },
    async delete(c, id) {
      remember(c, id);
      bucket(c).delete(id);
    },
    async list<T extends { id: string }>(c: CollectionName) {
      return [...bucket(c).values()].map((v) => structuredClone(v) as T);
    },
    async find<T extends { id: string }>(c: CollectionName, options?: FindOptions) {
      return applyFindOptions([...bucket(c).values()], options).map((v) => structuredClone(v) as T);
    },
    async transaction<T>(fn: () => Promise<T>) {
      if (journal) return fn();
      const entries: JournalEntry[] = [];
      journal = entries;
      try {
        const result = await fn();
        journal = null;
        return result;
      } catch (err) {
        for (const { c, id, before } of entries.reverse()) {
          if (before === undefined) bucket(c).delete(id);
          else bucket(c).set(id, before);
        }
        journal = null;
        throw err;
      }
    },
  };
  return store;
}

/* ---------- Bytes <-> base64 (works in browsers and Node) ---------- */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ---------- Ids, secrets, hashing (all work in browsers and in Node) ---------- */

export function createIds(): Ids {
  return {
    next: (prefix) => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
  };
}

export function createSecrets(): Secrets {
  return {
    token: () => {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };
}

export const systemClock: Clock = { now: () => new Date() };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Salted SHA-256. Fine for the browser demo, where the PIN never leaves the device.
 * The shop server uses scrypt instead (see packages/server).
 */
export function createSha256Hasher(): PinHasher {
  const hash = (userId: string, pin: string) => sha256Hex(`${userId}:${pin}`);
  return { hash, verify: async (stored, userId, pin) => stored === (await hash(userId, pin)) };
}

/** Kept for existing callers. Prefer a PinHasher. */
export const hashPin = (userId: string, pin: string) => createSha256Hasher().hash(userId, pin);
