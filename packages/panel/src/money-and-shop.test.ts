import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type CatalogueGridItem, type DispatchResult, type OrderCardData, type Panel, type PaymentsLedgerData, type ReceiptData, type ShopSettingsData, type Staff, type Store } from './index';

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
const relog = async () => {
  for (const r of ['owner', 'cashier', 'baker', 'inventory', 'it'] as Role[]) await signIn(r);
};
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
const DAY = 86_400_000;
const QTY = 200; // the demo cakes are cheap, so order plenty for round amounts

async function sellable(name: string) {
  const grid = await feed<CatalogueGridItem[]>('cashier', 'catalogue_grid');
  const item = grid.find((g) => g.name === name)!;
  return item.combinations.find((c) => c.sellable)!;
}
async function orderWith(extra: object = {}) {
  const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Mariam', ...extra }));
  const c = await sellable('Red Velvet Cake');
  ok(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: QTY }));
  return { orderId, price: c.price! };
}

beforeEach(async () => {
  t = new Date(2026, 9, 5, 9, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  await relog();
});

describe('customer phone on an order', () => {
  it('is tidied to international form, shown on the order, changed and cleared', async () => {
    const { orderId } = await orderWith({ customerPhone: ' +255 712-345 678 ' });
    expect((await feed<OrderCardData>('cashier', 'order_card', { orderId })).customerPhone).toBe('+255712345678');
    ok(await send('cashier', 'orders/set_delivery', { orderId, customerPhone: '+255 755 000 111' }));
    expect((await feed<OrderCardData>('cashier', 'order_card', { orderId })).customerPhone).toBe('+255755000111');
    ok(await send('cashier', 'orders/set_delivery', { orderId, customerPhone: null }));
    expect((await feed<OrderCardData>('cashier', 'order_card', { orderId })).customerPhone).toBeUndefined();
  });
  it('refuses a number without a country code', async () => {
    expect(errOf(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', customerPhone: '0712345678' }))).toMatch(/country code/);
    const { orderId } = await orderWith();
    expect(errOf(await send('cashier', 'orders/set_delivery', { orderId, customerPhone: '12345' }))).toMatch(/country code/);
  });
});

describe('payments list', () => {
  it('lists today\'s payments, deposits, refunds and totals by method, newest first', async () => {
    const a = await orderWith();
    const total = a.price * QTY;
    const half = total / 2;
    ok(await send('cashier', 'payments/record_payment', { orderId: a.orderId, method: 'cash', amount: half, allowPartial: true }));
    t += 60_000;
    const b = await orderWith({ customerName: 'Hassan' });
    ok(await send('cashier', 'payments/record_payment', { orderId: b.orderId, method: 'mobile_money', amount: b.price * QTY }));
    t += 60_000;
    ok(await send('cashier', 'payments/record_payment', { orderId: a.orderId, method: 'cash', amount: half }));
    t += 6 * 60_000; // past the refund cooldown
    ok(await send('owner', 'payments/approve_refund', { orderId: b.orderId, amount: 1000, reason: 'Cracked base', method: 'mobile_money' }));

    const l = await feed<PaymentsLedgerData>('cashier', 'payments_ledger');
    expect(l.isToday).toBe(true);
    expect(l.rows.map((r) => r.kind)).toEqual(['refund', 'payment', 'payment', 'deposit']);
    expect(l.rows[0]).toMatchObject({ amount: -1000, reason: 'Cracked base', orderNumber: expect.any(String), customerName: 'Hassan', byName: expect.stringContaining('Amina') });
    expect(l.rows[3]).toMatchObject({ kind: 'deposit', amount: half, customerName: 'Mariam', byName: expect.stringContaining('Baraka') });
    const cash = l.byMethod.find((m) => m.method === 'cash')!;
    const momo = l.byMethod.find((m) => m.method === 'mobile_money')!;
    expect(cash.amount).toBe(total);
    expect(momo.amount).toBe(b.price * QTY - 1000);
    expect(cash.share + momo.share).toBeGreaterThanOrEqual(99);
    expect(l.totals).toMatchObject({ count: 4, refunds: 1, net: total + b.price * QTY - 1000 });
    // A refund puts the money back on what the customer owes, so Hassan shows as owing the refunded amount.
    expect(l.outstanding).toHaveLength(1);
    expect(l.outstanding[0]).toMatchObject({ customerName: 'Hassan', balance: 1000 });
  });

  it('lists what is still owed, and leaves out orders still waiting for a price', async () => {
    const a = await orderWith({ customerName: 'Joseph' });
    ok(await send('cashier', 'payments/record_payment', { orderId: a.orderId, method: 'cash', amount: 1000, allowPartial: true }));
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', deliveryDate: '2026-10-20', customerName: 'Grace' }));
    ok(await send('cashier', 'orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Vanilla' } }));
    // A priced item beside the unpriced cake: the order still waits for a price, so it is not yet "owed".
    ok(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: (await sellable('Red Velvet Cake')).combinationId, qty: 5 }));
    const l = await feed<PaymentsLedgerData>('owner', 'payments_ledger');
    expect(l.outstanding).toHaveLength(1);
    expect(l.outstanding[0]).toMatchObject({ customerName: 'Joseph', balance: a.price * QTY - 1000 });
    expect(l.outstandingTotalLabel).toBe(l.outstanding[0]!.balanceLabel);
  });

  it('shows another day on request and is not for the baker', async () => {
    const a = await orderWith();
    ok(await send('cashier', 'payments/record_payment', { orderId: a.orderId, method: 'card', amount: a.price * QTY }));
    t += DAY;
    await relog();
    expect((await feed<PaymentsLedgerData>('cashier', 'payments_ledger')).rows).toHaveLength(0);
    const yesterday = await feed<PaymentsLedgerData>('cashier', 'payments_ledger', { day: '2026-10-05' });
    expect(yesterday).toMatchObject({ isToday: false, rows: [expect.objectContaining({ methodLabel: 'Card' })] });
    const r = await panel.feed('payments_ledger', {}, sid.baker);
    expect(r.ok).toBe(false);
  });
});

describe('receipt', () => {
  it('has the shop details, lines, payments, balance and ready-made links', async () => {
    ok(await send('owner', 'settings/update', { shopName: 'Cake City', shopAddress: '12 Baker Street', shopPhone: '+255 22 000 000', receiptFooter: 'Thank you!' }));
    const a = await orderWith({ customerPhone: '+255712345678' });
    ok(await send('cashier', 'payments/record_payment', { orderId: a.orderId, method: 'cash', amount: 1000, allowPartial: true }));
    const r = await feed<ReceiptData>('cashier', 'receipt', { orderId: a.orderId });
    expect(r).toMatchObject({ shop: { name: 'Cake City', address: '12 Baker Street', footer: 'Thank you!' }, statusLabel: 'Balance due', blockedReason: null, customer: { name: 'Mariam', phone: '+255712345678' } });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ qty: QTY });
    expect(r.text.split('\n')[0]).toBe('Cake City');
    expect(r.text).toContain('Balance due');
    expect(r.text).toContain('Thank you!');
    expect(r.text).not.toContain('undefined');
    expect(r.share.whatsappUrl).toMatch(/^https:\/\/wa\.me\/255712345678\?text=/);
    expect(decodeURIComponent(r.share.whatsappUrl!.split('text=')[1]!)).toBe(r.text);
    expect(r.share.smsUrl).toMatch(/^sms:\+255712345678\?body=/);
    ok(await send('cashier', 'payments/record_payment', { orderId: a.orderId, method: 'card', amount: a.price * QTY - 1000 }));
    expect((await feed<ReceiptData>('cashier', 'receipt', { orderId: a.orderId })).statusLabel).toBe('Paid in full');
  });

  it('has no links without a phone number, and says why a receipt cannot be given yet', async () => {
    const a = await orderWith();
    const r = await feed<ReceiptData>('cashier', 'receipt', { orderId: a.orderId });
    expect(r.share).toEqual({});
    expect(r.blockedReason).toMatch(/Nothing has been paid/);
    expect(r.shop.name).toBe('Cake shop');
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', deliveryDate: '2026-10-20' }));
    ok(await send('cashier', 'orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Vanilla' } }));
    expect((await feed<ReceiptData>('cashier', 'receipt', { orderId })).blockedReason).toMatch(/no price/);
  });

  it('is not for the baker', async () => {
    const a = await orderWith();
    expect((await panel.feed('receipt', { orderId: a.orderId }, sid.baker)).ok).toBe(false);
  });
});

describe('shop details', () => {
  it('are saved by the owner, readable by everyone signed in, and checked', async () => {
    expect(errOf(await send('cashier', 'settings/update', { shopName: 'Mine' }))).toMatch(/not allowed|permission|role/i);
    expect(errOf(await send('owner', 'settings/update', { shopName: '  ' }))).toMatch(/needs a name/);
    expect(errOf(await send('owner', 'settings/update', { shopPhone: 'call me' }))).toMatch(/phone number/);
    expect(errOf(await send('owner', 'settings/update', {}))).toMatch(/Choose a setting/);
    ok(await send('owner', 'settings/update', { shopName: ' Cake City ', shopAddress: ' Mikocheni ' }));
    ok(await send('owner', 'settings/update', { decoratingStage: true }));
    const s = await feed<ShopSettingsData>('baker', 'shop_settings');
    expect(s).toMatchObject({ shopName: 'Cake City', shopAddress: 'Mikocheni', shopPhone: null, decoratingStage: true, can: { edit: false } });
    ok(await send('owner', 'settings/update', { shopAddress: null }));
    expect((await feed<ShopSettingsData>('owner', 'shop_settings')).shopAddress).toBeNull();
  });
});

describe('changing a role', () => {
  it('moves someone to another role, signs them out, and refuses the unsafe cases', async () => {
    const staff = await store.list<Staff>('staff');
    const baker = staff.find((s) => s.role === 'baker')!;
    const owner = staff.find((s) => s.role === 'owner')!;
    ok(await send('owner', 'staff/set_role', { userId: baker.id, role: 'inventory' }));
    expect((await store.get<Staff>('staff', baker.id))!.role).toBe('inventory');
    expect((await panel.feed('me', {}, sid.baker)).ok).toBe(false); // their old sign-in is gone
    expect(errOf(await send('owner', 'staff/set_role', { userId: baker.id, role: 'inventory' }))).toMatch(/already/);
    expect(errOf(await send('owner', 'staff/set_role', { userId: owner.id, role: 'baker' }))).toMatch(/your own role/);
    expect(errOf(await send('owner', 'staff/set_role', { userId: 'nobody', role: 'baker' }))).toMatch(/no longer exists/);
    expect((await panel.dispatch('staff/set_role', { userId: baker.id, role: 'owner' } as never, sid.owner)).ok).toBe(false); // nobody can be made owner this way
    expect((await send('cashier', 'staff/set_role', { userId: baker.id, role: 'cashier' })).ok).toBe(false);
  });
});

describe('hiding a catalogue item', () => {
  it('takes it off the counter, keeps it for the owner, and cannot be sold while hidden', async () => {
    const grid = await feed<CatalogueGridItem[]>('owner', 'catalogue_grid');
    const item = grid.find((g) => g.name === 'Red Velvet Cake')!;
    const c = item.combinations.find((x) => x.sellable)!;
    ok(await send('owner', 'catalogue/set_hidden', { productId: item.productId, hidden: true }));
    expect((await feed<CatalogueGridItem[]>('cashier', 'catalogue_grid')).some((g) => g.name === 'Red Velvet Cake')).toBe(false);
    const own = (await feed<CatalogueGridItem[]>('owner', 'catalogue_grid')).find((g) => g.name === 'Red Velvet Cake')!;
    expect(own).toMatchObject({ hidden: true, sellable: false });
    expect(own.combinations[0]!.reason).toBe('Hidden');
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }));
    expect(errOf(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 1 }))).toMatch(/hidden/);
    expect(errOf(await send('owner', 'catalogue/set_hidden', { productId: item.productId, hidden: true }))).toMatch(/already hidden/);
    ok(await send('owner', 'catalogue/set_hidden', { productId: item.productId, hidden: false }));
    ok(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 1 }));
  });
});

describe('what a baker can see of usage', () => {
  it('shows only their own reports, and cannot confirm', async () => {
    const baker = (await store.list<Staff>('staff')).find((s) => s.role === 'baker')!;
    await store.put('orders', { id: 'o1', number: 'A-0001', customerName: 'X', source: 'phone', fulfilment: 'pickup', partialAllowed: false, createdBy: baker.id, createdAt: new Date(t).toISOString() });
    await store.put('orderLines', { id: 'l1', orderId: 'o1', type: 'custom', qty: 1, status: 'in_production', snapshot: { productName: 'Custom cake', options: {}, unitPrice: 1, allergens: [] }, custom: { spec: { servings: 10, flavor: 'Vanilla', photoIds: [] } } });
    const report = (id: string, by: string, byName: string) => ({ id, orderId: 'o1', lineId: 'l1', status: 'reported', items: [], reportedBy: by, reportedByName: byName, reportedAt: new Date(t).toISOString() });
    await store.put('usageReports', report('r-mine', baker.id, 'Neema'));
    await store.put('usageReports', report('r-other', 'someone-else', 'Another baker'));
    const own = await feed<{ pending: { reportId: string }[]; can: { confirm: boolean } }>('baker', 'usage_inbox');
    expect(own.pending.map((r) => r.reportId)).toEqual(['r-mine']);
    expect(own.can.confirm).toBe(false);
    expect((await feed<{ pending: unknown[] }>('inventory', 'usage_inbox')).pending).toHaveLength(2);
    expect((await feed<{ pending: unknown[] }>('owner', 'usage_inbox')).pending).toHaveLength(2);
    expect((await panel.feed('usage_inbox', {}, sid.cashier)).ok).toBe(false);
  });
});
