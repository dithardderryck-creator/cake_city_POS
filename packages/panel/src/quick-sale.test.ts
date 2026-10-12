import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type CatalogueGridItem, type DispatchResult, type OrderCardData, type Panel, type Staff, type Store } from './index';
import type { Combination, Payment, StockMovement } from './domain';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
const sid: Record<string, string> = {};
async function signIn(role: Role) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
  const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin });
  if (!r.ok) throw new Error('sign in failed');
  sid[role] = (r.data as { sessionId: string }).sessionId;
}
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const feed = async <T>(role: Role, name: Parameters<Panel['feed']>[0], params: object = {}) => {
  const r = await panel.feed(name, params as never, sid[role]);
  if (!r.ok) throw new Error(`${name}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
async function sellable(name: string) {
  const grid = await feed<CatalogueGridItem[]>('cashier', 'catalogue_grid');
  return grid.find((g) => g.name === name)!.combinations.find((c) => c.sellable)!;
}

beforeEach(async () => {
  t = new Date(2026, 9, 5, 9, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  for (const r of ['owner', 'cashier', 'baker', 'inventory', 'it'] as Role[]) await signIn(r);
});

describe('instant sale of ready-made products', () => {
  it('is one step: order completed, stock dropped, paid in full, no ticket to approve', async () => {
    const c = await sellable('Red Velvet Cake');
    const before = (await store.get<Combination>('combinations', c.combinationId))!.stockCount;
    const r = ok<{ orderId: string; total: number }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash' }));
    expect(r.total).toBe(c.price);
    const card = await feed<OrderCardData>('cashier', 'order_card', { orderId: r.orderId });
    expect(card.balance).toBe(0);
    expect(card.lines.every((l) => l.status === 'completed')).toBe(true);
    expect((await store.get<Combination>('combinations', c.combinationId))!.stockCount).toBe(Math.max(0, before - 1));
    const pays = await store.find<Payment>('payments', { where: { orderId: r.orderId } });
    expect(pays).toHaveLength(1);
    expect(pays[0]!.amount).toBe(c.price);
    expect((await store.find<StockMovement>('stockMovements', { where: { orderId: r.orderId } }))).toHaveLength(1);
  });

  it('is flagged instant in the order list, so the boards can keep finished ones off', async () => {
    const c = await sellable('Red Velvet Cake');
    const r = ok<{ orderId: string }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash' }));
    const list = await feed<Array<{ orderId: string; instant: boolean; status: string }>>('cashier', 'order_list');
    expect(list.find((o) => o.orderId === r.orderId)).toMatchObject({ instant: true, status: 'completed' });
    expect(list.filter((o) => o.orderId !== r.orderId).every((o) => o.instant === false)).toBe(true);
  });

  it('is all or nothing: one unsellable item cancels the whole sale and leaves no order, payment or stock change', async () => {
    const c = await sellable('Red Velvet Cake');
    const orders = (await store.list('orders')).length;
    const msg = errOf(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }, { combinationId: 'nope', qty: 1 }], method: 'cash' }));
    expect(msg).toMatch(/no longer in the catalogue/);
    expect((await store.list('orders')).length).toBe(orders);
    expect((await store.list('payments')).length).toBe(0);
  });

  it('refuses an empty sale, a repeated item and anyone who is not owner or cashier', async () => {
    const c = await sellable('Red Velvet Cake');
    expect(errOf(await send('cashier', 'orders/quick_sale', { items: [], method: 'cash' }))).toBeTruthy();
    expect(errOf(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }, { combinationId: c.combinationId, qty: 2 }], method: 'cash' }))).toMatch(/twice/);
    const r = await send('baker', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash' });
    expect(r.ok).toBe(false);
  });

  it('records a shortfall for the daily count when stock is lower than the sale, like handing over from an order does', async () => {
    const c = await sellable('Red Velvet Cake');
    const stock = (await store.get<Combination>('combinations', c.combinationId))!.stockCount;
    const r = await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: stock + 3 }], method: 'cash' });
    const data = ok<{ orderId: string }>(r);
    expect((await store.get<Combination>('combinations', c.combinationId))!.stockCount).toBe(0);
    expect(r.ok && (r.warnings ?? []).join(' ')).toMatch(/short by 3/);
    expect(data.orderId).toBeTruthy();
  });
});
