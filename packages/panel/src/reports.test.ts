import { beforeEach, describe, expect, it } from 'vitest';
import type { CountDifference, Ingredient, IngredientMovement, Order, OrderLine, UsageReport, UsageSuggestion } from './domain';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type CatalogueGridItem, type DispatchResult, type Panel, type ReportsData, type Staff, type Store } from './index';

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
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const reports = async (days?: 7 | 30, role: Role = 'owner') => {
  const r = await panel.feed('reports', days ? { days } : {}, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as ReportsData;
};
const grid = async () => {
  const r = await panel.feed('catalogue_grid', {}, sid.owner);
  if (!r.ok) throw new Error('grid');
  return r.data as CatalogueGridItem[];
};
const NOON = 12;
/** Move the clock to a day (0 = today) at noon, then sign everybody in again. */
const onDay = async (daysAgo: number, hour = NOON) => {
  t = new Date(2026, 9, 7 - daysAgo, hour, 0, 0).getTime();
  await login();
};
async function order(product: string, qty: number, extra: object = {}) {
  const g = (await grid()).find((x) => x.name === product)!;
  const c = g.combinations.find((x) => x.sellable)!;
  const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Mariam', ...extra }));
  ok(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty }));
  return { orderId, value: c.price! * qty };
}
const pay = (orderId: string, method: string, amount: number) => send('cashier', 'payments/record_payment', { orderId, method, amount, allowPartial: true } as never);

beforeEach(async () => {
  t = new Date(2026, 9, 7, 12, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  await login();
});

describe('who can look', () => {
  it('only the owner', async () => {
    for (const r of ['cashier', 'baker', 'inventory', 'it'] as const) expect((await panel.feed('reports', {}, sid[r])).ok).toBe(false);
    expect((await panel.feed('reports', { days: 14 } as never, sid.owner)).ok).toBe(false);
    expect((await reports()).range.days).toBe(7);
  });
});

describe('sales', () => {
  async function shopWeek() {
    await onDay(8);
    const a = await order('Red Velvet Cake', 10_000);
    ok(await pay(a.orderId, 'cash', 20000));
    await onDay(3);
    const b = await order('Red Velvet Cake', 10_000);
    ok(await pay(b.orderId, 'mobile_money', 30000));
    await onDay(1);
    const c = await order('Lemon Drizzle Cake', 10_000);
    ok(await pay(c.orderId, 'card', 10000));
    await onDay(0);
    const d = await order('Chocolate Fudge Cake', 10_000);
    ok(await pay(d.orderId, 'cash', 25000));
    t += 6 * 60_000; // past the refund cooldown
    ok(await send('owner', 'payments/approve_refund', { orderId: b.orderId, amount: 5000, reason: 'Cracked base', method: 'mobile_money' }));
    return { a, b, c, d };
  }

  it('is the money received less refunds, by day, with the period before for comparison', async () => {
    await shopWeek();
    const r = await reports(7);
    expect(r.range).toEqual({ days: 7, from: '2026-10-01', to: '2026-10-07' });
    expect(r.sales.series.map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(r.sales.series.map((d) => d.total)).toEqual([0, 0, 0, 30000, 0, 10000, 20000]);
    expect(r.sales.series[6].label).toBe('Wed 7');
    expect(r.sales).toMatchObject({ total: 60000, previousTotal: 20000, changePercent: 200, today: 20000, yesterday: 10000, todayChangePercent: 100 });
    expect(r.sales.perDay).toBeCloseTo(8571.43, 2);
    expect(r.sales.bestDay).toMatchObject({ day: '2026-10-04', total: 30000 });
    expect(r.sales.totalLabel).toContain('60,000');
  });

  it('a 30 day period includes the earlier payment, and compares with the 30 days before', async () => {
    await shopWeek();
    const r = await reports(30);
    expect(r.range).toMatchObject({ days: 30, from: '2026-09-08' });
    expect(r.sales.series).toHaveLength(30);
    expect(r.sales.total).toBe(80000);
    expect(r.sales.previousTotal).toBe(0);
    expect(r.sales.changePercent).toBeNull();
  });

  it('says nothing to compare when there was no money yesterday, and no best day when there were no sales', async () => {
    const r = await reports();
    expect(r.sales).toMatchObject({ total: 0, today: 0, yesterday: 0, todayChangePercent: null, changePercent: null, bestDay: null });
    expect(r.methods).toEqual([]);
    expect(r.bestSellers).toEqual([]);
  });

  it('splits by payment method after refunds, with shares', async () => {
    await shopWeek();
    const r = await reports(7);
    expect(r.methods.map((m) => [m.method, m.amount, m.label])).toEqual([
      ['cash', 25000, 'Cash'],
      ['mobile_money', 25000, 'Mobile money'],
      ['card', 10000, 'Card'],
    ]);
    expect(r.methods.map((m) => m.share)).toEqual([0.417, 0.417, 0.167]);
  });

  it('ranks best sellers by value on orders placed in the period, leaving out earlier ones', async () => {
    const w = await shopWeek();
    const r = await reports(7);
    const value: Record<string, number> = { 'Red Velvet Cake': w.b.value, 'Lemon Drizzle Cake': w.c.value, 'Chocolate Fudge Cake': w.d.value };
    expect(r.bestSellers.map((b) => b.name)).toEqual(Object.keys(value).sort((x, y) => value[y] - value[x]));
    // the 10,000 Red Velvet cakes ordered 8 days ago are not counted
    expect(r.bestSellers.find((b) => b.name === 'Red Velvet Cake')).toMatchObject({ amount: w.b.value, units: 10_000 });
    expect(r.bestSellers.reduce((s, b) => s + b.share, 0)).toBeGreaterThan(0.99);
    expect(r.bestSellers.reduce((s, b) => s + b.share, 0)).toBeLessThan(1.01);
  });

  it('a cancelled order does not count as sold', async () => {
    await onDay(0);
    const x = await order('Lemon Drizzle Cake', 100);
    const keep = await order('Red Velvet Cake', 1);
    ok(await send('owner', 'orders/cancel_order', { orderId: x.orderId }));
    expect((await reports()).bestSellers.map((b) => b.name)).toEqual(['Red Velvet Cake']);
    expect(keep.value).toBeGreaterThan(0);
  });

  it('shows the top five and puts the rest under "Everything else", and counts custom cakes together', async () => {
    await onDay(0);
    const o: Order = { id: 'o1', number: 'A-9001', customerName: 'X', source: 'walk_in', fulfilment: 'pickup', partialAllowed: false, createdBy: uid.cashier, createdAt: new Date(t).toISOString() };
    await store.put('orders', o);
    const mk = (i: number, type: 'catalogue' | 'custom', name: string, price: number, qty: number): OrderLine =>
      ({ id: `l${i}`, orderId: 'o1', type, qty, snapshot: { productName: name, options: {}, unitPrice: price, allergens: [] }, status: 'new' }) as OrderLine;
    const lines = [mk(1, 'catalogue', 'P1', 100, 1), mk(2, 'catalogue', 'P2', 90, 1), mk(3, 'catalogue', 'P3', 80, 1), mk(4, 'catalogue', 'P4', 70, 1), mk(5, 'catalogue', 'P5', 60, 1), mk(6, 'catalogue', 'P6', 50, 2), mk(7, 'catalogue', 'P7', 5, 1), mk(8, 'custom', 'Birthday', 150, 1), mk(9, 'custom', 'Wedding', 250, 1), mk(10, 'catalogue', 'Unpriced', 0, 3)];
    for (const l of lines) await store.put('orderLines', l);
    const b = (await reports()).bestSellers;
    expect(b.map((x) => [x.name, x.amount, x.units])).toEqual([
      ['Custom cakes', 400, 2],
      ['P1', 100, 1],
      ['P6', 100, 2],
      ['P2', 90, 1],
      ['P3', 80, 1],
      ['Everything else', 135, 3],
    ]);
  });
});

describe('refunds', () => {
  it('lists the refunds in the period with the order, who it was, and why, and the total', async () => {
    await onDay(2);
    const a = await order('Red Velvet Cake', 10_000, { customerName: 'Salma R.' });
    ok(await pay(a.orderId, 'cash', 30000));
    t += 6 * 60_000; // past the refund cooldown
    ok(await send('owner', 'payments/approve_refund', { orderId: a.orderId, amount: 8000, reason: 'Wrong flavour delivered', method: 'cash' }));
    await onDay(0);
    ok(await send('owner', 'payments/approve_refund', { orderId: a.orderId, amount: 2000, reason: 'Late', method: 'cash' }));
    const r = (await reports(7)).refunds;
    expect(r.total).toBe(10000);
    expect(r.rows.map((x) => [x.amount, x.reason, x.customerName, x.day])).toEqual([
      [2000, 'Late', 'Salma R.', '2026-10-07'],
      [8000, 'Wrong flavour delivered', 'Salma R.', '2026-10-05'],
    ]);
    expect(r.rows[0].orderNumber).toMatch(/^A-/);
    await onDay(0);
    // the first day of the period counts, the day before does not, and nor does a day that has not come yet
    const refund = (id: string, day: number) => ({ id, orderId: a.orderId, amount: 100, reason: id, method: 'cash', approvedBy: uid.owner, at: new Date(2026, 9, day, 9).toISOString() });
    await store.put('refunds', refund('first-day', 1));
    await store.put('refunds', { ...refund('day-before', 1), at: new Date(2026, 8, 30, 9).toISOString() });
    await store.put('refunds', refund('tomorrow', 8));
    expect((await reports(7)).refunds.rows.map((x) => x.reason)).toEqual(['Late', 'Wrong flavour delivered', 'first-day']);
    // refunds before the period are left out
    t = new Date(2026, 9, 20, 12).getTime();
    await login();
    expect((await reports(7)).refunds.rows).toEqual([]);
  });
});

describe('ingredient usage', () => {
  const ing: Record<string, string> = {};
  async function make(name: string, onHand: number) {
    ing[name] = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name, unit: 'kg', openingStock: onHand })).ingredientId;
  }
  const suggestion = (lineId: string, lines: Record<string, number>): UsageSuggestion => ({ id: lineId, orderId: 'o', lineId, generatedAt: new Date(t).toISOString(), generator: 'rules', lines: Object.entries(lines).map(([n, qty]) => ({ ingredientId: ing[n], name: n, unit: 'kg' as const, qty })) });
  const report = (id: string, lineId: string, status: UsageReport['status'], confirmedAt: string, confirmed: Record<string, number>): UsageReport =>
    ({ id, orderId: 'o', lineId, status, items: [], reportedBy: uid.baker, reportedByName: 'B', reportedAt: confirmedAt, confirmedAt, confirmed: Object.entries(confirmed).map(([n, qty]) => ({ ingredientId: ing[n], qty })) });

  it('compares what was suggested with what was confirmed, flags differences over 10%, and ignores other reports', async () => {
    await make('Flour', 20);
    await make('Sugar', 20);
    await make('Butter', 20);
    await onDay(1);
    const iso = (d: number) => new Date(2026, 9, 7 - d, 10).toISOString();
    await store.put('usageSuggestions', suggestion('L1', { Flour: 1, Sugar: 1 }));
    await store.put('usageSuggestions', suggestion('L2', { Flour: 1 }));
    await store.put('usageSuggestions', suggestion('L3', { Flour: 50 }));
    await store.put('usageReports', report('r1', 'L1', 'confirmed', iso(1), { Flour: 1.5, Sugar: 1.05, Butter: 0.2 }));
    await store.put('usageReports', report('r2', 'L2', 'confirmed', iso(2), { Flour: 0.5 }));
    await store.put('usageReports', report('r3', 'L3', 'confirmed', iso(10), { Flour: 99 })); // before the period
    await store.put('usageReports', report('r4', 'L3', 'reported', iso(1), { Flour: 77 })); // not confirmed yet
    const u = (await reports(7)).usage;
    const by = (n: string) => u.find((x) => x.name === n)!;
    expect(by('Flour')).toMatchObject({ suggested: 2, confirmed: 2, differencePercent: 0, flagged: false, direction: null });
    expect(by('Sugar')).toMatchObject({ suggested: 1, confirmed: 1.05, differencePercent: 5, flagged: false });
    expect(by('Butter')).toMatchObject({ suggested: 0, confirmed: 0.2, differencePercent: null, flagged: true, direction: 'more' });
    expect(by('Flour').confirmedText).toBe('2 kg');
    // a bigger gap either way
    await store.put('usageReports', report('r5', 'L1', 'confirmed', iso(1), { Flour: 1 }));
    const f = (await reports(7)).usage.find((x) => x.name === 'Flour')!;
    expect(f).toMatchObject({ suggested: 2, confirmed: 3, differencePercent: 50, flagged: true, direction: 'more' });
    await store.put('usageReports', report('r6', 'L2', 'confirmed', iso(1), { Sugar: -1.1 }));
    expect((await reports(7)).usage.find((x) => x.name === 'Sugar')).toMatchObject({ confirmed: -0.05, flagged: true, direction: 'less' });
  });
});

describe('stock days', () => {
  it('lists the ingredients that will run out first, with a level, and counts those without enough history', async () => {
    const mk = async (name: string, onHand: number) => ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name, unit: 'kg', openingStock: onHand })).ingredientId;
    const [a, b, c] = [await mk('Butter', 10), await mk('Flour', 40), await mk('Sugar', 100)];
    await mk('Saffron', 1);
    const use = async (id: string, perDay: number) => {
      for (let d = 6; d >= 1; d--) {
        const m: IngredientMovement = { id: `m${id}${d}`, ingredientId: id, qty: -perDay, reason: 'usage', by: uid.inventory, at: new Date(2026, 9, 7 - d, 9).toISOString() };
        await store.put('ingredientMovements', m);
      }
    };
    await use(a, 5); // 10 kg at 5/day = 2 days: low
    await use(b, 8); // 5 days: ok
    await use(c, 20); // 5 days
    const ings = await store.list<Ingredient>('ingredients');
    const butter = ings.find((i) => i.name === 'Butter')!;
    await store.put('ingredients', { ...butter, onHand: 4 }); // 0.8 days: critical
    const s = (await reports()).stockDays;
    expect(s.noData).toBe(1);
    expect(s.rows[0]).toMatchObject({ name: 'Butter', level: 'critical' });
    expect(s.rows.map((r) => r.daysLeft)).toEqual([...s.rows.map((r) => r.daysLeft)].sort((x, y) => x - y));
    expect(s.rows.find((r) => r.name === 'Flour')).toMatchObject({ daysLeft: 5.1, level: 'ok' });
    await store.put('ingredients', { ...butter, onHand: 10 });
    expect((await reports()).stockDays.rows.find((r) => r.name === 'Butter')).toMatchObject({ daysLeft: 2, level: 'low' });
    await store.put('ingredients', { ...butter, onHand: 17 }); // about 3.5 days
    expect((await reports()).stockDays.rows.find((r) => r.name === 'Butter')).toMatchObject({ daysLeft: 3.5, level: 'low' });
    await store.put('ingredients', { ...butter, onHand: 25 }); // about 5 days
    expect((await reports()).stockDays.rows.find((r) => r.name === 'Butter')).toMatchObject({ level: 'ok' });
  });

  it('shows at most six', async () => {
    for (let i = 0; i < 8; i++) {
      const id = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name: `Item ${i}`, unit: 'kg', openingStock: 10 + i })).ingredientId;
      for (let d = 6; d >= 1; d--) await store.put('ingredientMovements', { id: `m${i}${d}`, ingredientId: id, qty: -1, reason: 'usage', by: uid.inventory, at: new Date(2026, 9, 7 - d, 9).toISOString() } as IngredientMovement);
    }
    const s = (await reports()).stockDays;
    expect(s.rows).toHaveLength(6);
    expect(s.rows[0].name).toBe('Item 0');
  });
});

describe('count differences and waste', () => {
  it('lists differences from the daily count and from counter items found short, newest first', async () => {
    const flour = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name: 'Flour', unit: 'kg', openingStock: 14 })).ingredientId;
    const sugar = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name: 'Sugar', unit: 'kg', openingStock: 9 })).ingredientId;
    await onDay(2);
    const s = ok<{ sessionId: string }>(await send('inventory', 'count/start', {}));
    ok(await send('inventory', 'count/record', { sessionId: s.sessionId, ingredientId: flour, counted: 10 }));
    ok(await send('inventory', 'count/record', { sessionId: s.sessionId, ingredientId: sugar, counted: 9 }));
    ok(await send('inventory', 'count/submit', { sessionId: s.sessionId }));
    const red = (await grid()).find((g) => g.name === 'Red Velvet Cake')!.combinations[0].combinationId;
    const diff: CountDifference = { id: 'cd1', combinationId: red, expected: 10, counted: 8, difference: -2, reason: 'shortfall_at_completion', at: new Date(2026, 9, 6, 9).toISOString() };
    await store.put('countDifferences', diff);
    await store.put('countDifferences', { ...diff, id: 'cd2', difference: 0, at: new Date(2026, 9, 6, 10).toISOString() });
    await store.put('countDifferences', { ...diff, id: 'cd4', expected: 20, difference: 1, counted: 21, reason: 'daily_count', at: new Date(2026, 9, 6, 11).toISOString() });
    await store.put('countDifferences', { ...diff, id: 'cd3', at: new Date(2026, 8, 1, 10).toISOString() }); // too old
    await onDay(0);
    const d = (await reports(7)).countDifferences;
    expect(d.map((x) => [x.day, x.name, x.gapText, x.big, x.note])).toEqual([
      ['2026-10-06', 'Red Velvet Cake', '+1', false, 'Found in a count'],
      ['2026-10-06', 'Red Velvet Cake', '−2', true, 'Short when an order was completed'],
      ['2026-10-05', 'Flour', '−4 kg', true, expect.stringContaining('Daily count by')],
    ]);
    expect(d[2]).toMatchObject({ expectedText: '14 kg', countedText: '10 kg', gap: -4 });
  });

  it('lists write-offs in the period with what and why', async () => {
    const cream = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name: 'Cream', unit: 'l', openingStock: 5 })).ingredientId;
    await onDay(2);
    ok(await send('inventory', 'inventory/write_off', { ingredientId: cream, qty: 1, note: 'Expired' }));
    await onDay(0);
    ok(await send('inventory', 'inventory/write_off', { ingredientId: cream, qty: 0.5, unit: 'l', note: 'Spilled' }));
    const w = (await reports(7)).waste;
    expect(w.count).toBe(2);
    expect(w.rows.map((r) => [r.name, r.amountText, r.why, r.day, r.time])).toEqual([
      ['Cream', '500 ml', 'Spilled', '2026-10-07', '12:00'],
      ['Cream', '1 l', 'Expired', '2026-10-05', '12:00'],
    ]);
    expect(w.rows[0].byName).toContain('Juma');
    t = new Date(2026, 9, 30, 12).getTime();
    await login();
    expect((await reports(7)).waste).toEqual({ count: 0, rows: [] });
  });
});
