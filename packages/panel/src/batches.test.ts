import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry, Batch, Combination, StockMovement } from './domain';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type BatchLogData, type CatalogueGridItem, type DispatchResult, type Panel, type Staff, type Store } from './index';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;

type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
const ROLES: Role[] = ['owner', 'cashier', 'baker', 'inventory', 'it'];
const sid: Record<string, string> = {};
const uid: Record<string, string> = {};
const login = async () => {
  for (const role of ROLES) {
    const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
    const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
    uid[role] = staff.id;
    const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin });
    if (!r.ok) throw new Error('sign in failed');
    sid[role] = (r.data as { sessionId: string }).sessionId;
  }
};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const feed = async <T>(role: Role, name: Parameters<Panel['feed']>[0]) => {
  const r = await panel.feed(name, {} as never, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as T;
};
const log = async (role: Role = 'baker') => feed<BatchLogData>(role, 'batch_log');
let combo: string; // Red Velvet Cake
const stock = async (id = combo) => (await store.get<Combination>('combinations', id))!.stockCount;

beforeEach(async () => {
  t = new Date(2026, 9, 7, 8, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  await login();
  const grid = await feed<CatalogueGridItem[]>('owner', 'catalogue_grid');
  combo = grid.find((g) => g.name === 'Red Velvet Cake')!.combinations[0].combinationId;
});

describe('batches', () => {
  it('lists every active product version to choose from, by name, with what is on hand', async () => {
    const d = await log();
    expect(d.can.log).toBe(true);
    const labels = d.options.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels.some((l) => l.startsWith('Red Velvet Cake'))).toBe(true);
    expect(d.options.find((o) => o.combinationId === combo)!.onHand).toBe(await stock());
    expect(d.undoMinutes).toBe(30);
  });

  it('leaves archived products out', async () => {
    const grid = await feed<CatalogueGridItem[]>('owner', 'catalogue_grid');
    const lemon = grid.find((g) => g.name === 'Lemon Drizzle Cake')!;
    ok(await send('owner', 'catalogue/archive_product', { productId: lemon.productId }));
    expect((await log()).options.some((o) => o.label.startsWith('Lemon Drizzle'))).toBe(false);
    expect(errOf(await send('baker', 'batches/log', { combinationId: lemon.combinations[0].combinationId, qty: 3 }))).toMatch(/no longer on the menu/);
  });

  it('adds to counter stock, remembers who and when, and writes a stock movement', async () => {
    const before = await stock();
    const r = ok<{ batchId: string; onHand: number }>(await send('baker', 'batches/log', { combinationId: combo, qty: 24, note: '  One tray slightly dark ' }));
    expect(r.onHand).toBe(before + 24);
    expect(await stock()).toBe(before + 24);
    const b = (await store.get<Batch>('batches', r.batchId))!;
    expect(b).toMatchObject({ qty: 24, note: 'One tray slightly dark', byId: uid.baker });
    expect(b.label).toMatch(/^Red Velvet Cake/);
    const moves = (await store.list<StockMovement>('stockMovements')).filter((m) => m.reason === 'batch');
    expect(moves).toEqual([expect.objectContaining({ combinationId: combo, qty: 24, by: uid.baker })]);
    // the catalogue the cashier sells from shows it
    const grid = await feed<CatalogueGridItem[]>('cashier', 'catalogue_grid');
    expect(grid.find((g) => g.name === 'Red Velvet Cake')!.combinations[0].onHand).toBe(before + 24);
  });

  it('shows the list newest first with times, and today totals', async () => {
    ok(await send('baker', 'batches/log', { combinationId: combo, qty: 10 }));
    t += 45 * 60_000;
    ok(await send('baker', 'batches/log', { combinationId: combo, qty: 5, note: 'Extra' }));
    const d = await log();
    expect(d.rows.map((r) => [r.qty, r.timeText, r.today])).toEqual([
      [5, '08:45', true],
      [10, '08:00', true],
    ]);
    expect(d.rows[0].byName).toContain('Neema');
    expect(d.rows[0].note).toBe('Extra');
    expect(d.today).toEqual({ batches: 2, items: 15 });
    t += 24 * 3_600_000;
    await login();
    const next = await log();
    expect(next.today).toEqual({ batches: 0, items: 0 });
    expect(next.rows[0]).toMatchObject({ today: false, timeText: '2026-10-07 08:45' });
  });

  it('keeps only the latest 40 in the list', async () => {
    for (let i = 0; i < 42; i++) ok(await send('baker', 'batches/log', { combinationId: combo, qty: 1 }));
    expect((await log()).rows).toHaveLength(40);
  });

  it('only the baker and owner can log; the cashier, inventory and IT cannot, though inventory can look', async () => {
    for (const r of ['cashier', 'inventory', 'it'] as const) expect((await send(r, 'batches/log', { combinationId: combo, qty: 1 })).ok).toBe(false);
    expect((await log('inventory')).can.log).toBe(false);
    expect((await log('owner')).can.log).toBe(true);
    ok(await send('owner', 'batches/log', { combinationId: combo, qty: 2 }));
    expect((await panel.feed('batch_log', {}, sid.cashier)).ok).toBe(false);
    expect((await panel.feed('batch_log', {}, sid.it)).ok).toBe(false);
  });

  it('refuses a quantity that is not a whole number from 1 to 1000, a long note, and something that does not exist', async () => {
    for (const qty of [0, -3, 2.5, 1001]) expect((await send('baker', 'batches/log', { combinationId: combo, qty })).ok).toBe(false);
    expect((await send('baker', 'batches/log', { combinationId: combo, qty: 1, note: 'x'.repeat(81) })).ok).toBe(false);
    const before = await stock();
    expect(errOf(await send('baker', 'batches/log', { combinationId: 'nope', qty: 1 }))).toMatch(/Choose what you made/);
    expect(await stock()).toBe(before);
    expect(await store.list('batches')).toHaveLength(0);
  });
});

describe('taking a batch back', () => {
  it('the baker who logged it can within 30 minutes, which takes the stock off and hides it from the list', async () => {
    const before = await stock();
    const { batchId } = ok<{ batchId: string }>(await send('baker', 'batches/log', { combinationId: combo, qty: 24 }));
    t += 30 * 60_000;
    expect((await log()).rows[0].canUndo).toBe(true);
    ok(await send('baker', 'batches/undo', { batchId }));
    expect(await stock()).toBe(before);
    expect((await log()).rows).toHaveLength(0);
    expect((await log()).today).toEqual({ batches: 0, items: 0 });
    const moves = (await store.list<StockMovement>('stockMovements')).filter((m) => m.reason === 'batch').map((m) => m.qty);
    expect(moves.sort()).toEqual([-24, 24]);
    expect(errOf(await send('baker', 'batches/undo', { batchId }))).toMatch(/already taken back/);
  });

  it('after 30 minutes only the owner can, and another baker never can', async () => {
    const { batchId } = ok<{ batchId: string }>(await send('baker', 'batches/log', { combinationId: combo, qty: 5 }));
    t += 31 * 60_000;
    await login();
    expect((await log()).rows[0].canUndo).toBe(false);
    expect(errOf(await send('baker', 'batches/undo', { batchId }))).toMatch(/30 minutes/);
    expect((await log('owner')).rows[0].canUndo).toBe(true);
    ok(await send('owner', 'batches/undo', { batchId }));
  });

  it("a different baker cannot take back someone else's batch", async () => {
    const { batchId } = ok<{ batchId: string }>(await send('owner', 'batches/log', { combinationId: combo, qty: 5 }));
    expect(errOf(await send('baker', 'batches/undo', { batchId }))).toMatch(/Only the person who logged/);
    expect((await log()).rows[0].canUndo).toBe(false);
  });

  it('is refused once some of the batch has been sold, and stock never goes below zero', async () => {
    const { batchId } = ok<{ batchId: string }>(await send('baker', 'batches/log', { combinationId: combo, qty: 10 }));
    ok(await send('owner', 'stock/set_count', { combinationId: combo, count: 4 }));
    expect(errOf(await send('baker', 'batches/undo', { batchId }))).toMatch(/already been sold/);
    expect(await stock()).toBe(4);
    expect(errOf(await send('owner', 'batches/undo', { batchId }))).toMatch(/already been sold/);
  });

  it('cashier, inventory and IT cannot, and an unknown batch is refused', async () => {
    const { batchId } = ok<{ batchId: string }>(await send('baker', 'batches/log', { combinationId: combo, qty: 2 }));
    for (const r of ['cashier', 'inventory', 'it'] as const) expect((await send(r, 'batches/undo', { batchId })).ok).toBe(false);
    expect(errOf(await send('baker', 'batches/undo', { batchId: 'nope' }))).toMatch(/does not exist/);
  });

  it('is audited with who did it', async () => {
    const { batchId } = ok<{ batchId: string }>(await send('baker', 'batches/log', { combinationId: combo, qty: 2 }));
    ok(await send('baker', 'batches/undo', { batchId }));
    const audit = await store.list<AuditEntry>('audit');
    for (const intent of ['batches/log', 'batches/undo']) expect(audit.some((a) => a.intent === intent && a.actorId === uid.baker && a.outcome === 'ok')).toBe(true);
  });
});
