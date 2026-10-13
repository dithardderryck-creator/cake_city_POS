import { beforeEach, describe, expect, it } from 'vitest';
import { cleanPayload, createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type CatalogueGridItem, type DispatchResult, type OrderCardData, type Panel, type Staff, type Store } from './index';
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

const TECHNICAL = /expected|received|Invalid input|NaN|Infinity|undefined|\[object|zod|Too big|Too small/i;

describe('bad input: refusals are plain words', () => {
  const nums: Array<[string, unknown]> = [['over the limit', 1_000_001_000_000], ['cents', 0.5], ['negative', -1], ['NaN', NaN], ['Infinity', Infinity], ['text', '12'], ['null', null], ['huge', 1e308], ['tiny', 1e-300]];

  it('every wrong number on money, quantity and count fields says what to fix, with no developer wording', async () => {
    const c = await sellable('Red Velvet Cake');
    const attempts: Array<() => Promise<DispatchResult>> = [];
    for (const [, v] of nums) {
      attempts.push(() => send('owner', 'catalogue/set_price', { combinationId: c.combinationId, price: v as number }));
      attempts.push(() => send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: v as number }], method: 'cash' }));
      attempts.push(() => send('cashier', 'payments/record_payment', { orderId: 'nope', method: 'cash', amount: v as number }));
      attempts.push(() => send('owner', 'stock/set_count', { combinationId: c.combinationId, count: v as number }));
      attempts.push(() => send('owner', 'settings/update', { lowStockUnits: v as number }));
    }
    for (const run of attempts) {
      const r = await run();
      expect(r.ok).toBe(false);
      const msg = errOf(r);
      expect(msg.length).toBeGreaterThan(5);
      expect(msg).not.toMatch(TECHNICAL);
    }
    expect(errOf(await send('owner', 'catalogue/set_price', { combinationId: c.combinationId, price: 0.5 }))).toMatch(/whole number of shillings, with no cents/);
    expect(errOf(await send('owner', 'catalogue/set_price', { combinationId: c.combinationId, price: 1e308 }))).toMatch(/at most 1,000,000,000/);
    expect(errOf(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 20_000 }], method: 'cash' }))).toMatch(/"qty": it can be at most 10,000/);
  });

  it('a too-long name says how long it may be, and nothing was saved', async () => {
    const before = (await store.list('products')).length;
    const r = await send('owner', 'catalogue/create_product', { name: 'A'.repeat(121) });
    expect(errOf(r)).toBe('Check "name": it is too long (at most 120 characters).');
    expect((await store.list('products')).length).toBe(before);
  });

  it('a made-up field, a __proto__ key and a missing body are all refused politely', async () => {
    const c = await sellable('Red Velvet Cake');
    expect(errOf(await send('owner', 'catalogue/set_price', { combinationId: c.combinationId, price: 5, extra: 1 } as never))).toMatch(/Unexpected field/);
    const evil = JSON.parse('{"combinationId":"' + c.combinationId + '","price":5,"__proto__":{"admin":true}}');
    expect(errOf(await send('owner', 'catalogue/set_price', evil))).toMatch(/Unexpected field/);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect((await send('owner', 'catalogue/set_price', null as never)).ok).toBe(false);
  });
});

describe('bad input: text is tidied before it is saved', () => {
  it('turns line breaks, tabs and invisible characters in names into one clean line', () => {
    expect(cleanPayload({ name: '  Joe\n\tSmith​  ', customerName: 'a\u0007b\r\nc', pin: ' 12 34 ' })).toEqual({ name: 'Joe Smith', customerName: 'ab c', pin: ' 12 34 ' });
  });

  it('keeps what real names need: emoji (with joiners), Arabic, accents, and angle brackets as plain text', () => {
    const family = '👨‍👩‍👧';
    expect(cleanPayload({ name: `${family} مرحبا café <b>&</b>` })).toEqual({ name: `${family} مرحبا café <b>&</b>` });
  });

  it('removes the bidirectional overrides that disguise text', () => {
    expect(cleanPayload({ name: 'invoice‮gnp.exe' })).toEqual({ name: 'invoicegnp.exe' });
  });

  it('keeps line breaks in notes and reasons, but not runs of blank lines or stray spaces', () => {
    expect(cleanPayload({ note: 'one\r\n\r\n\r\n\r\ntwo \t three  \nfour' })).toEqual({ note: 'one\n\ntwo three\nfour' });
    expect(cleanPayload({ items: [{ note: ' a​ ' }] })).toEqual({ items: [{ note: 'a' }] });
  });

  it('leaves numbers, booleans and nesting alone', () => {
    const x = { a: 1, b: true, c: null, d: { e: [1, 2, { f: 'x' }] } };
    expect(cleanPayload(x)).toEqual(x);
  });

  it('a customer name pasted with a line break is saved on one line, and an all-blank name becomes Walk-in customer', async () => {
    const c = await sellable('Red Velvet Cake');
    const a = ok<{ orderId: string }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash', customerName: 'Grace\nMushi​' }));
    const b = ok<{ orderId: string }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash', customerName: ' \n\t​ ' }));
    const list = await feed<Array<{ orderId: string; customerName: string }>>('cashier', 'order_list');
    expect(list.find((o) => o.orderId === a.orderId)!.customerName).toBe('Grace Mushi');
    expect(list.find((o) => o.orderId === b.orderId)!.customerName).toBe('Walk-in customer');
  });

  it('a name made only of invisible characters is refused where a name is required', async () => {
    expect(errOf(await send('owner', 'catalogue/create_product', { name: '​\n​' }))).toMatch(/name/i);
    expect(errOf(await send('owner', 'staff/create', { name: '​ \t', role: 'cashier', pin: '4821' }))).toMatch(/name/i);
  });
});

describe('bad input: the biggest sale the limits allow', () => {
  it('10,000 of something at TSh 1,000,000,000 is exactly 10,000,000,000,000, with no rounding and no exponent', async () => {
    const c = await sellable('Red Velvet Cake');
    ok(await send('owner', 'catalogue/set_price', { combinationId: c.combinationId, price: 1_000_000_000 }));
    const r = ok<{ orderId: string; total: number }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 10_000 }], method: 'cash' }));
    expect(r.total).toBe(10_000_000_000_000);
    const card = await feed<OrderCardData>('cashier', 'order_card', { orderId: r.orderId });
    expect(card.balance).toBe(0);
    expect(card.totalLabel).toBe('TSh 10,000,000,000,000');
    expect(card.totalLabel).not.toMatch(/e\+/);
    const pays = await store.find<Payment>('payments', { where: { orderId: r.orderId } });
    expect(pays[0]!.amount).toBe(10_000_000_000_000);
  });

  it('a product priced at 0 can be handed over but records no empty payment', async () => {
    const c = await sellable('Red Velvet Cake');
    ok(await send('owner', 'catalogue/set_price', { combinationId: c.combinationId, price: 0 }));
    const r = ok<{ orderId: string; total: number }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash' }));
    expect(r.total).toBe(0);
    expect(await store.find<Payment>('payments', { where: { orderId: r.orderId } })).toHaveLength(0);
    const card = await feed<OrderCardData>('cashier', 'order_card', { orderId: r.orderId });
    expect(card.totalLabel).toBe('TSh 0');
    expect(card.balance).toBe(0);
  });
});
