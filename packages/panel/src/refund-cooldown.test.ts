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

describe('refund cooldown', () => {
  async function paidOrder() {
    const c = await sellable('Red Velvet Cake');
    const r = ok<{ orderId: string; total: number }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash' }));
    return r;
  }
  const refund = (orderId: string, amount = 1000) => send('owner', 'payments/approve_refund', { orderId, amount, reason: 'Cracked base', method: 'cash' });

  it('is 5 minutes by default and shown in the shop settings', async () => {
    expect((await feed<{ refundCooldownMinutes: number }>('owner', 'shop_settings')).refundCooldownMinutes).toBe(5);
  });

  it('refuses a refund right after the sale, with a plain message, and allows it once the wait is over', async () => {
    const { orderId } = await paidOrder();
    expect(errOf(await refund(orderId))).toMatch(/too recent.*5 minutes/);
    t += 4 * 60_000;
    expect(errOf(await refund(orderId))).toMatch(/about 1 minute\./);
    t += 61_000;
    ok(await refund(orderId));
  });

  it('counts from the latest payment on the order, not from when the order was made', async () => {
    const { orderId } = await paidOrder();
    t += 10 * 60_000;
    ok(await refund(orderId, 1)); // the first payment is 10 minutes old: allowed
    // a later payment on the same order (written directly: a quick sale is already paid in full) restarts the wait
    await store.put('payments', { id: 'late', orderId, method: 'cash', amount: 500, receivedBy: 'x', receivedAt: new Date(t).toISOString() } as Payment);
    expect(errOf(await refund(orderId, 1))).toMatch(/too recent/);
    t += 5 * 60_000;
    ok(await refund(orderId, 1));
  });

  it('the owner can change it, 0 switches it off, and out-of-range values are refused', async () => {
    const { orderId } = await paidOrder();
    ok(await send('owner', 'settings/update', { refundCooldownMinutes: 0 }));
    ok(await refund(orderId));
    ok(await send('owner', 'settings/update', { refundCooldownMinutes: 20 }));
    const second = await paidOrder();
    expect(errOf(await refund(second.orderId))).toMatch(/20 minutes/);
    expect((await send('owner', 'settings/update', { refundCooldownMinutes: -1 })).ok).toBe(false);
    expect((await send('owner', 'settings/update', { refundCooldownMinutes: 999 })).ok).toBe(false);
    expect((await send('owner', 'settings/update', { refundCooldownMinutes: 2.5 })).ok).toBe(false);
    expect((await send('cashier', 'settings/update', { refundCooldownMinutes: 0 })).ok).toBe(false);
  });
});
