import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore, type Store } from '@cake-pos/panel';
import { migrate, openSqliteStore, SCHEMA_VERSION, type SqliteStore } from './sqlite-store';
import Database from 'better-sqlite3';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Row {
  id: string;
  kind: string;
  n: number;
  flag?: boolean;
  note?: string | null;
}

/** The behaviour every store must have. Runs against memory and SQLite, so they cannot drift apart. */
function contract(name: string, make: () => Store) {
  describe(`${name} store contract`, () => {
    it('gets, puts (insert and update), deletes and lists', async () => {
      const s = make();
      expect(await s.get('orders', 'nope')).toBeUndefined();
      await s.put('orders', { id: 'a', n: 1 });
      await s.put('orders', { id: 'a', n: 2 });
      await s.put('orders', { id: 'b', n: 3 });
      expect(await s.get('orders', 'a')).toEqual({ id: 'a', n: 2 });
      expect((await s.list('orders')).length).toBe(2);
      await s.delete('orders', 'a');
      await s.delete('orders', 'never-existed');
      expect(await s.get('orders', 'a')).toBeUndefined();
    });

    it('finds by equality, any-of, null and boolean, with order and limit', async () => {
      const s = make();
      const rows: Row[] = [
        { id: 'r1', kind: 'x', n: 3, flag: true },
        { id: 'r2', kind: 'y', n: 1, flag: false },
        { id: 'r3', kind: 'x', n: 2, note: null },
        { id: 'r4', kind: 'z', n: 9 },
      ];
      for (const r of rows) await s.put('orderLines', r);
      const ids = async (o: Parameters<Store['find']>[1]) => (await s.find<Row>('orderLines', o)).map((r) => r.id);
      expect(await ids({ where: { kind: 'x' } })).toEqual(expect.arrayContaining(['r1', 'r3']));
      expect((await ids({ where: { kind: 'x' } })).length).toBe(2);
      expect((await ids({ where: { kind: ['x', 'z'] } })).sort()).toEqual(['r1', 'r3', 'r4']);
      expect(await ids({ where: { kind: [] } })).toEqual([]);
      expect(await ids({ where: { flag: true } })).toEqual(['r1']);
      expect((await ids({ where: { note: null } })).sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
      expect(await ids({ where: { kind: 'x', n: 2 } })).toEqual(['r3']);
      expect(await ids({ orderBy: { field: 'n' } })).toEqual(['r2', 'r3', 'r1', 'r4']);
      expect(await ids({ orderBy: { field: 'n', dir: 'desc' }, limit: 2 })).toEqual(['r4', 'r1']);
      expect(await ids({})).toHaveLength(4);
    });

    it('commits a transaction, and rolls back every write in a failed one', async () => {
      const s = make();
      await s.put('payments', { id: 'keep', n: 1 });
      await s.transaction(async () => {
        await s.put('payments', { id: 'c1', n: 1 });
        await s.put('payments', { id: 'c2', n: 2 });
      });
      expect((await s.list('payments')).length).toBe(3);

      await expect(
        s.transaction(async () => {
          await s.put('payments', { id: 'r1', n: 1 });
          await s.put('payments', { id: 'keep', n: 999 }); // an update inside the failed transaction
          await s.delete('payments', 'c1');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await s.get('payments', 'r1')).toBeUndefined();
      expect(await s.get('payments', 'keep')).toEqual({ id: 'keep', n: 1 });
      expect(await s.get('payments', 'c1')).toEqual({ id: 'c1', n: 1 });
    });

    it('lets a transaction be used again after one fails', async () => {
      const s = make();
      await expect(s.transaction(async () => { await s.put('refunds', { id: 'x', n: 1 }); throw new Error('no'); })).rejects.toThrow();
      await s.transaction(async () => s.put('refunds', { id: 'y', n: 2 }));
      expect((await s.list('refunds')).map((r) => r.id)).toEqual(['y']);
    });

    it('keeps values intact: unicode, nested data, large records', async () => {
      const s = make();
      const big = { id: 'big', text: 'Sponge 🍰 — ürün ケーキ ' + 'x'.repeat(200_000), nested: { a: [1, 2, { b: null }] } };
      await s.put('products', big);
      expect(await s.get('products', 'big')).toEqual(big);
    });

    it('does not let a query sneak SQL through a field name', async () => {
      const s = make();
      await s.put('orders', { id: 'safe', n: 1 });
      if (name === 'sqlite') {
        await expect(s.find('orders', { where: { "n') OR 1=1 --": 1 } })).rejects.toThrow(/Unsafe field/);
        await expect(s.find('orders', { orderBy: { field: 'n; DROP TABLE orders' } })).rejects.toThrow(/Unsafe field/);
      }
      expect(await s.get('orders', 'safe')).toBeDefined();
    });

    it('treats values with quotes and SQL text as plain data', async () => {
      const s = make();
      await s.put('orders', { id: "x'; DROP TABLE orders; --", kind: "O'Brien" });
      expect((await s.find('orders', { where: { kind: "O'Brien" } })).length).toBe(1);
      expect((await s.list('orders')).length).toBe(1);
    });
  });
}

contract('memory', () => createMemoryStore());
contract('sqlite', () => {
  const s = openSqliteStore(path.join(tmp(), 'test.sqlite'));
  return s;
});

describe('sqlite specifics', () => {
  it('keeps data across close and reopen', async () => {
    const file = path.join(tmp(), 'persist.sqlite');
    const a = openSqliteStore(file);
    await a.put('staff', { id: 's1', name: 'Amina' });
    a.close();
    const b = openSqliteStore(file);
    expect(await b.get('staff', 's1')).toEqual({ id: 's1', name: 'Amina' });
    b.close();
  });

  it('uses indexes for the queries the feeds run', async () => {
    const s: SqliteStore = openSqliteStore(path.join(tmp(), 'plan.sqlite'));
    const plan = (sql: string) => (s.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    expect(plan(`SELECT data FROM orderLines WHERE json_extract(data, '$.orderId') = 'x'`)).toMatch(/USING INDEX idx_orderLines_orderId/);
    expect(plan(`SELECT data FROM orders ORDER BY json_extract(data, '$.createdAt') DESC LIMIT 200`)).toMatch(/idx_orders_createdAt/);
    expect(plan(`SELECT data FROM audit ORDER BY json_extract(data, '$.at') DESC LIMIT 200`)).toMatch(/idx_audit_at/);
    s.close();
  });

  it('uses write-ahead logging with full durability', () => {
    const s = openSqliteStore(path.join(tmp(), 'pragmas.sqlite'));
    expect(s.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(s.db.pragma('synchronous', { simple: true })).toBe(2); // FULL
    expect(s.integrityCheck()).toBe('ok');
    s.close();
  });

  it('refuses a database written by a newer version, instead of damaging it', () => {
    const file = path.join(tmp(), 'future.sqlite');
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => openSqliteStore(file)).toThrow(/newer version/);
  });

  it('migrates repeatedly without harm', () => {
    const db = new Database(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });
});

describe('migration 2: grams and millilitres become kg and l', () => {
  const putRaw = (db: Database.Database, table: string, doc: { id: string; [k: string]: unknown }) =>
    db.prepare(`INSERT INTO "${table}" (id, data) VALUES (?, ?)`).run(doc.id, JSON.stringify(doc));
  const getRaw = (db: Database.Database, table: string, id: string) => JSON.parse((db.prepare(`SELECT data FROM "${table}" WHERE id = ?`).get(id) as { data: string }).data);

  /** A database as version 1 of the schema left it, with stock in grams. */
  function legacyDb() {
    const db = new Database(':memory:');
    for (const t of ['ingredients', 'ingredientMovements', 'recipeRules', 'usageSuggestions', 'usageReports'])
      db.exec(`CREATE TABLE "${t}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL) WITHOUT ROWID`);
    db.pragma('user_version = 1');
    putRaw(db, 'ingredients', { id: 'flour', name: 'Flour', unit: 'g', onHand: 4750, reorderLevel: 1000, allergens: [], ranges: [{ id: 'r1', label: 'Light', min: 100, max: 200 }], active: true });
    putRaw(db, 'ingredients', { id: 'vanilla', name: 'Vanilla', unit: 'ml', onHand: 90, allergens: [], ranges: [{ id: 'r2', label: 'Splash', min: 3, max: 8 }], active: true });
    putRaw(db, 'ingredients', { id: 'butter', name: 'Butter', unit: 'kg', onHand: 2.5, allergens: [], ranges: [], active: true });
    putRaw(db, 'ingredients', { id: 'eggs', name: 'Eggs', unit: 'pcs', onHand: 30, allergens: [], ranges: [], active: true });
    putRaw(db, 'ingredientMovements', { id: 'm1', ingredientId: 'flour', qty: -250, reason: 'usage', shortfall: 50 });
    putRaw(db, 'ingredientMovements', { id: 'm2', ingredientId: 'butter', qty: 1, reason: 'delivery' });
    putRaw(db, 'recipeRules', { id: 'rule1', ingredientId: 'flour', quantity: 20, scaling: 'per_serving' });
    putRaw(db, 'recipeRules', { id: 'rule2', ingredientId: 'eggs', quantity: 0.25, scaling: 'per_serving' });
    putRaw(db, 'usageSuggestions', { id: 's1', lines: [{ ingredientId: 'flour', name: 'Flour', unit: 'g', qty: 240 }, { ingredientId: 'eggs', name: 'Eggs', unit: 'pcs', qty: 3 }] });
    putRaw(db, 'usageReports', {
      id: 'rep1',
      items: [{ ingredientId: 'vanilla', unit: 'ml', min: 3, max: 8 }],
      confirmed: [{ ingredientId: 'vanilla', qty: 5 }],
    });
    return db;
  }

  it('divides every gram and millilitre figure by 1000 and relabels the unit, leaving kg, l and pcs alone', () => {
    const db = legacyDb();
    expect(migrate(db)).toEqual({ from: 1, to: SCHEMA_VERSION });
    expect(getRaw(db, 'ingredients', 'flour')).toMatchObject({ unit: 'kg', onHand: 4.75, reorderLevel: 1, ranges: [{ min: 0.1, max: 0.2 }] });
    expect(getRaw(db, 'ingredients', 'vanilla')).toMatchObject({ unit: 'l', onHand: 0.09, ranges: [{ min: 0.003, max: 0.008 }] });
    expect(getRaw(db, 'ingredients', 'butter')).toMatchObject({ unit: 'kg', onHand: 2.5 });
    expect(getRaw(db, 'ingredients', 'eggs')).toMatchObject({ unit: 'pcs', onHand: 30 });
    expect(getRaw(db, 'ingredientMovements', 'm1')).toMatchObject({ qty: -0.25, shortfall: 0.05 });
    expect(getRaw(db, 'ingredientMovements', 'm2')).toMatchObject({ qty: 1 });
    expect(getRaw(db, 'recipeRules', 'rule1').quantity).toBe(0.02);
    expect(getRaw(db, 'recipeRules', 'rule2').quantity).toBe(0.25);
    expect(getRaw(db, 'usageSuggestions', 's1').lines).toEqual([
      expect.objectContaining({ unit: 'kg', qty: 0.24 }),
      expect.objectContaining({ unit: 'pcs', qty: 3 }),
    ]);
    expect(getRaw(db, 'usageReports', 'rep1')).toMatchObject({ items: [{ unit: 'l', min: 0.003, max: 0.008 }], confirmed: [{ qty: 0.005 }] });
    db.close();
  });

  it('runs only once, so a second open does not divide again', () => {
    const db = legacyDb();
    migrate(db);
    migrate(db);
    expect(getRaw(db, 'ingredients', 'flour').onHand).toBe(4.75);
    db.close();
  });

  it('is harmless on a brand-new database with no ingredient tables yet', () => {
    const db = new Database(':memory:');
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});
