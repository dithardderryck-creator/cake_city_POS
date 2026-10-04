import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { convertToMetric } from './metric-migration';
import { COLLECTIONS, type CollectionName, type FindOptions, type Store } from '@cake-pos/panel';

/** Fields queried often. Each becomes an index, so feeds stay fast after years of orders. */
export const INDEXES: Partial<Record<CollectionName, string[]>> = {
  orders: ['createdAt'],
  orderLines: ['orderId', 'combinationId', 'status'],
  payments: ['orderId'],
  refunds: ['orderId'],
  stockMovements: ['combinationId'],
  countDifferences: ['combinationId'],
  combinations: ['productId'],
  optionValues: ['groupId'],
  audit: ['at'],
  outbox: ['status', 'createdAt'],
  sessions: ['userId'],
  requests: ['at'],
  quotes: ['status', 'orderId'],
  photos: ['attachedTo'],
  ingredientMovements: ['ingredientId', 'at'],
  usageReports: ['status', 'lineId'],
  alerts: ['status', 'dedupeKey'],
};

/**
 * Structural changes, in order. Never edit one that has shipped: add a new one at the end.
 * The database remembers how many have run (PRAGMA user_version).
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // 1: the first layout is created by ensureCollections below.
  () => undefined,
  // 2: stock quantities move from g / ml to the metric base units kg / l.
  (db) => void convertToMetric(db),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const FIELD = /^[A-Za-z][A-Za-z0-9_]*$/;
const assertField = (f: string) => {
  if (!FIELD.test(f)) throw new Error(`Unsafe field name "${f}"`);
  return f;
};
const expr = (field: string) => `json_extract(data, '$.${assertField(field)}')`;

function ensureCollections(db: Database.Database) {
  for (const c of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS "${c}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL) WITHOUT ROWID`);
    for (const f of INDEXES[c] ?? []) db.exec(`CREATE INDEX IF NOT EXISTS "idx_${c}_${f}" ON "${c}"(${expr(f)})`);
  }
}

export function migrate(db: Database.Database): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number;
  if (from > SCHEMA_VERSION) {
    throw new Error(`This database was written by a newer version of Cake POS (schema ${from}, this server knows ${SCHEMA_VERSION}). Update the server before opening it.`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = from; v < SCHEMA_VERSION; v++) MIGRATIONS[v]!(db);
    ensureCollections(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { from, to: SCHEMA_VERSION };
}

export interface SqliteStore extends Store {
  readonly db: Database.Database;
  readonly file: string;
  backupTo(dest: string): Promise<void>;
  integrityCheck(): string;
  sizeBytes(): number;
  close(): void;
}

export function openSqliteStore(file: string): SqliteStore {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL lets readers and the writer work together. FULL makes every commit reach the disk
  // before we say "saved", which matters for money. A power cut loses at most a half-done change.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  migrate(db);

  const cache = new Map<string, Database.Statement>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const table = (c: CollectionName) => `"${c}"`;

  let depth = 0;

  const store: SqliteStore = {
    db,
    file,
    async get<T extends { id: string }>(c: CollectionName, id: string) {
      const row = stmt(`SELECT data FROM ${table(c)} WHERE id = ?`).get(id) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as T) : undefined;
    },
    async put<T extends { id: string }>(c: CollectionName, record: T) {
      stmt(`INSERT INTO ${table(c)} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(record.id, JSON.stringify(record));
    },
    async delete(c, id) {
      stmt(`DELETE FROM ${table(c)} WHERE id = ?`).run(id);
    },
    async list<T extends { id: string }>(c: CollectionName) {
      return (stmt(`SELECT data FROM ${table(c)}`).all() as Array<{ data: string }>).map((r) => JSON.parse(r.data) as T);
    },
    async find<T extends { id: string }>(c: CollectionName, options: FindOptions = {}) {
      const params: Array<string | number> = [];
      const clauses: string[] = [];
      for (const [field, want] of Object.entries(options.where ?? {})) {
        const e = expr(field);
        if (Array.isArray(want)) {
          if (want.length === 0) clauses.push('0');
          else {
            clauses.push(`${e} IN (${want.map(() => '?').join(',')})`);
            params.push(...want);
          }
        } else if (want === null) clauses.push(`${e} IS NULL`);
        else {
          clauses.push(`${e} = ?`);
          params.push(typeof want === 'boolean' ? (want ? 1 : 0) : want);
        }
      }
      let sql = `SELECT data FROM ${table(c)}`;
      if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
      if (options.orderBy) sql += ` ORDER BY ${expr(options.orderBy.field)} ${options.orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`;
      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('limit must be a whole number');
        sql += ` LIMIT ${options.limit}`;
      }
      return (stmt(sql).all(...params) as Array<{ data: string }>).map((r) => JSON.parse(r.data) as T);
    },
    async transaction<T>(fn: () => Promise<T>) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    async backupTo(dest) {
      await db.backup(dest);
    },
    integrityCheck: () => (db.pragma('integrity_check', { simple: true }) as string) ?? 'unknown',
    sizeBytes: () => (file === ':memory:' ? 0 : fs.statSync(file).size),
    close() {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* closing anyway */
      }
      db.close();
    },
  };
  return store;
}
