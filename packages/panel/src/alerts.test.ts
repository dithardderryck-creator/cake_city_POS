import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type AlertInboxData, type DispatchResult, type Panel, type PanelEvent, type Staff, type Store } from './index';
import type { Alert, CountDifference, Order, OutboxItem } from './domain';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
let events: PanelEvent[];
let errors: unknown[];

type Role = 'owner' | 'cashier' | 'baker' | 'inventory';
const sid: Record<string, string> = {};
async function signIn(role: Role) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
  const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin });
  if (!r.ok) throw new Error('sign in failed');
  sid[role] = (r.data as { sessionId: string }).sessionId;
}
const relog = async () => {
  for (const r of ['owner', 'cashier', 'baker', 'inventory'] as const) await signIn(r);
};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : `${r.error.code}: ${r.error.messages.join(' ')}`);
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);

const HOUR = 3_600_000;
const ymd = (k: number) => {
  const d = new Date(t + k * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const advance = async (ms: number) => {
  t += ms;
  await relog();
};

const inbox = async (role: Role) => {
  const r = await panel.feed('alert_inbox', {}, sid[role]);
  if (!r.ok) throw new Error(`inbox: ${r.error.messages.join(' ')}`);
  return r.data as AlertInboxData;
};
const titles = async (role: Role) => (await inbox(role)).open.map((a) => a.title);
const pendingNotices = async () => (await store.find<OutboxItem>('outbox', { where: { kind: 'notify' } }));

const ids: Record<string, string> = {};
async function ingredient(name: string, stock: number, extra: object = {}) {
  ids[name] = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name, unit: 'kg', openingStock: stock, ranges: [{ label: 'Some', min: 0.1, max: 1 }], ...extra })).ingredientId;
}

async function cake(deliveryDate: string, price = 100) {
  const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: 'Zawadi', deliveryDate }));
  const { lineId } = ok<{ lineId: string }>(await send('cashier', 'orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Chocolate' } }));
  const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
  return { orderId, lineId, quoteId, price: async () => ok(await send('owner', 'quotes/provide', { quoteId, price })) };
}

beforeEach(async () => {
  t = new Date(2026, 9, 4, 8, 0, 0).getTime();
  events = [];
  errors = [];
  store = createMemoryStore();
  panel = createPanel({ store, clock, onError: (e) => errors.push(e) });
  panel.onEvent((e) => events.push(e));
  await seedDemo(store, panel);
  await relog();
});

describe('stock alerts', () => {
  it('raises "low" when stock is at its reorder level, tells Inventory once, and clears when restocked', async () => {
    await ingredient('Flour', 5, { reorderLevel: 1 });
    expect((await inbox('inventory')).open).toEqual([]);
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.8 }));
    const a = (await inbox('inventory')).open;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'low_stock', severity: 'warning', title: 'Flour is running low', to: ['inventory'], seen: false });
    expect(events.map((e) => e.type)).toContain('AlertRaised');
    expect(await pendingNotices()).toHaveLength(1);

    // BR-23: still one alert, and nobody is told twice.
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.7 }));
    ok(await send('inventory', 'inventory/write_off', { ingredientId: ids.Flour!, qty: 0.1, note: 'spilled' }));
    expect((await inbox('inventory')).open).toHaveLength(1);
    expect(await pendingNotices()).toHaveLength(1);

    ok(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 10 }));
    const after = await inbox('inventory');
    expect(after.open).toEqual([]);
    expect(after.recent[0]).toMatchObject({ title: 'Flour is running low' });
    expect(after.recent[0]!.resolvedAt).toBeTruthy();
    expect(events.map((e) => e.type)).toContain('AlertResolved');

    // A new dip is a new alert, and a new notice.
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.5 }));
    expect((await inbox('inventory')).open).toHaveLength(1);
    expect(await pendingNotices()).toHaveLength(2);
  });

  it('is critical and reaches the owner when an ingredient is out', async () => {
    await ingredient('Butter', 2, { reorderLevel: 1 });
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Butter!, counted: 0 }));
    const inv = (await inbox('inventory')).open;
    expect(inv.map((a) => [a.kind, a.severity, a.title])).toEqual([['stockout', 'critical', 'Butter is out of stock']]);
    expect(inv[0]!.to).toEqual(['inventory', 'owner']);
    const owner = await inbox('owner');
    expect(owner).toMatchObject({ critical: 1, unseen: 1 });
    expect((await inbox('baker')).open).toEqual([]);
    expect((await inbox('cashier')).open).toEqual([]);
  });

  it('warns ahead from the cakes already booked, before the shelf is empty', async () => {
    await ingredient('Flour', 1, { reorderLevel: 0.2 });
    ok(await send('baker', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 0.2, scaling: 'per_serving' })); // 2 kg for a 10-serving cake
    expect(await titles('inventory')).toEqual([]);
    const c = await cake(ymd(1));
    await c.price();
    const inv = (await inbox('inventory')).open;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ kind: 'stockout', severity: 'critical', title: 'Flour will run out today' });
    expect(inv[0]!.body).toMatch(/About 1 kg more is needed/);
    // Receiving enough clears it.
    ok(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 5 }));
    expect(await titles('inventory')).toEqual([]);
  });

  it('follows the owner’s thresholds', async () => {
    await ingredient('Sugar', 2, { reorderLevel: 1 });
    await ingredient('Eggs2', 100); // a second ingredient so the forecast has company
    ok(await send('baker', 'recipes/save_rule', { ingredientId: ids.Sugar!, quantity: 0.01, scaling: 'per_serving' }));
    const c = await cake(ymd(5));
    await c.price();
    expect(await titles('inventory')).toEqual([]);
    ok(await send('owner', 'alerts/configure', { reorderDays: 7, critical: { low_stock: true } }));
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Sugar!, counted: 1 }));
    const a = (await inbox('inventory')).open[0]!;
    expect(a).toMatchObject({ kind: 'low_stock', severity: 'critical' });
    expect(a.to).toContain('owner');
    ok(await send('owner', 'alerts/configure', { critical: { low_stock: false } }));
    expect((await inbox('inventory')).open[0]).toMatchObject({ severity: 'warning' });
  });
});

describe('alerts about people waiting', () => {
  it('tells Inventory when a report waits too long, then the owner, and clears on confirmation', async () => {
    await ingredient('Flour', 5);
    const c = await cake(ymd(3));
    await c.price();
    ok(await send('baker', 'orders/advance_line', { orderId: c.orderId, lineId: c.lineId, to: 'in_production' }));
    ok(await send('baker', 'usage/report', { orderId: c.orderId, lineId: c.lineId, items: [{ ingredientId: ids.Flour!, rangeId: (await store.list<{ id: string; ranges: Array<{ id: string }> }>('ingredients'))[0]!.ranges[0]!.id }] }));
    expect(await titles('inventory')).toEqual([]);
    await advance(5 * HOUR);
    expect((await panel.tick()).raised).toBe(1);
    expect(await titles('inventory')).toEqual(['Usage is waiting to be confirmed']);
    expect(await titles('owner')).toEqual(['Usage is waiting to be confirmed']); // the owner sees everything
    expect(await pendingNotices()).toHaveLength(1);
    await advance(4 * HOUR);
    expect((await panel.tick()).raised).toBe(1);
    const owner = (await inbox('owner')).open.find((a) => a.title === 'Usage has been waiting a long time')!;
    expect(owner.to).toEqual(['owner']);
    expect((await inbox('inventory')).open.map((a) => a.title)).not.toContain('Usage has been waiting a long time');

    const rid = (await store.list<{ id: string }>('usageReports'))[0]!.id;
    ok(await send('inventory', 'usage/confirm', { reportId: rid, items: [{ ingredientId: ids.Flour!, qty: 0.3 }] }));
    expect((await inbox('owner')).open).toEqual([]);
  });

  it('asks for a cake to be started when its day is near, and clears when baking starts', async () => {
    const near = await cake(ymd(2));
    const far = await cake(ymd(9));
    await near.price();
    await far.price();
    expect(await titles('baker')).toEqual(['Cake for Zawadi has not been started']);
    const a = (await inbox('baker')).open[0]!;
    expect(a).toMatchObject({ kind: 'order_not_started', screen: 'bake_queue', targetId: near.lineId, to: ['baker', 'owner'] });
    expect(a.body).toMatch(/10 servings, Chocolate\. Due in 2 days/);
    expect((await inbox('cashier')).open).toEqual([]);
    ok(await send('baker', 'orders/advance_line', { orderId: near.orderId, lineId: near.lineId, to: 'in_production' }));
    expect((await inbox('baker')).open).toEqual([]);
    // Time passing brings the far one into range.
    await advance(7 * 86_400_000);
    await panel.tick();
    expect((await inbox('baker')).open.map((x) => x.targetId)).toEqual([far.lineId]);
  });

  it('asks the owner for a price that is taking too long, and clears when it is given', async () => {
    const c = await cake(ymd(4));
    expect((await inbox('owner')).open).toEqual([]);
    await advance(3 * HOUR);
    await panel.tick();
    const a = (await inbox('owner')).open;
    expect(a.map((x) => x.kind)).toEqual(['quote_waiting']);
    expect(a[0]!.body).toMatch(/asked 3 hours ago/);
    expect((await inbox('cashier')).open).toEqual([]);
    await c.price();
    expect((await inbox('owner')).open).toEqual([]);
  });

  it('flags an order that is past its date and still in the shop, to the cashier and owner', async () => {
    const c = await cake(ymd(1));
    await c.price();
    ok(await send('baker', 'orders/advance_line', { orderId: c.orderId, lineId: c.lineId, to: 'in_production' }));
    await advance(3 * 86_400_000);
    await panel.tick();
    const a = (await inbox('cashier')).open;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'overdue_delivery', screen: 'orders', targetId: c.orderId, to: ['cashier', 'owner'] });
    expect(a[0]!.body).toMatch(/due 2 days ago/);
    expect(await store.get<Order>('orders', c.orderId)).toBeTruthy();
  });

  it('reports a large count difference to the owner once, and an acknowledged one stays closed', async () => {
    const diff: CountDifference = { id: 'cd1', combinationId: (await store.list<{ id: string }>('combinations'))[0]!.id, expected: 5, counted: 1, difference: -4, reason: 'daily_count', at: new Date(t - HOUR).toISOString() };
    await store.put('countDifferences', diff);
    await store.put('countDifferences', { ...diff, id: 'cd2', expected: 5, counted: 4, difference: -1 }); // under the threshold
    await panel.tick();
    const a = (await inbox('owner')).open;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'count_difference', severity: 'critical', to: ['owner'] });
    expect(a[0]!.body).toBe('Expected 5, counted 1 (-4).');
    expect((await inbox('cashier')).open).toEqual([]);
    ok(await send('owner', 'alerts/acknowledge', { alertId: a[0]!.alertId }));
    expect((await inbox('owner')).open).toEqual([]);
    await panel.tick();
    expect((await inbox('owner')).open).toEqual([]); // not raised again
    expect(await store.find('alerts', { where: { dedupeKey: 'count_difference:cd1' } })).toHaveLength(1);
    // Old differences are not news.
    await store.put('countDifferences', { ...diff, id: 'cd3', at: new Date(t - 30 * HOUR).toISOString() });
    await panel.tick();
    expect((await inbox('owner')).open).toEqual([]);
  });
});

describe('seeing, taking and snoozing', () => {
  async function oneAlert() {
    await ingredient('Flour', 2, { reorderLevel: 1 });
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.5 }));
    return (await inbox('inventory')).open[0]!;
  }

  it('shows a number on the menu until the alert has been seen', async () => {
    const a = await oneAlert();
    const badge = async (role: Role) => {
      const r = await panel.feed('navigation', {}, sid[role]);
      return r.ok ? r.data.find((n) => n.id === 'alerts')?.badge : undefined;
    };
    expect(await badge('inventory')).toBe(1);
    expect(await badge('owner')).toBe(1);
    expect(await badge('cashier')).toBeUndefined();
    ok(await send('inventory', 'alerts/mark_seen', { alertIds: [a.alertId] }));
    expect(await badge('inventory')).toBeUndefined();
    expect(await badge('owner')).toBe(1); // seen by Inventory is not seen by the owner
    expect((await inbox('inventory')).open[0]).toMatchObject({ seen: true });
    expect((await inbox('inventory')).unseen).toBe(0);
  });

  it('lets one person take an alert; the others see who has it', async () => {
    const a = await oneAlert();
    ok(await send('inventory', 'alerts/acknowledge', { alertId: a.alertId }));
    expect(errOf(await send('owner', 'alerts/acknowledge', { alertId: a.alertId }))).toMatch(/Juma \(Inventory\) has already taken this/);
    expect((await inbox('owner')).open[0]).toMatchObject({ acknowledgedByName: 'Juma (Inventory)', can: { acknowledge: false, snooze: true } });
    expect((await inbox('inventory')).open).toHaveLength(1); // still true, so still open
  });

  it('hides a snoozed alert from you only, and brings it back after the time', async () => {
    const a = await oneAlert();
    expect(errOf(await send('inventory', 'alerts/snooze', { alertId: a.alertId, hours: 0 }))).toMatch(/invalid/);
    ok(await send('inventory', 'alerts/snooze', { alertId: a.alertId, hours: 2 }));
    expect((await inbox('inventory')).open).toEqual([]);
    expect((await inbox('inventory')).snoozed).toHaveLength(1);
    expect((await inbox('owner')).open).toHaveLength(1);
    await advance(3 * HOUR);
    expect((await inbox('inventory')).open).toHaveLength(1);
  });

  it('keeps alerts private to the people they are for', async () => {
    const a = await oneAlert();
    expect(errOf(await send('cashier', 'alerts/mark_seen', { alertIds: [a.alertId] }))).toMatch(/not available/);
    expect(errOf(await send('baker', 'alerts/acknowledge', { alertId: a.alertId }))).toMatch(/not available/);
    expect(errOf(await send('cashier', 'alerts/snooze', { alertId: a.alertId, hours: 1 }))).toMatch(/not available/);
    expect(errOf(await send('inventory', 'alerts/configure', { reorderDays: 3 }))).toMatch(/^forbidden/);
    expect(errOf(await send('inventory', 'alerts/mark_seen', { alertIds: ['nope'] }))).toMatch(/not available/);
    const it = await panel.feed('alert_inbox', {}, undefined);
    expect(it.ok).toBe(false);
    expect((await panel.feed('alert_settings', {}, sid.inventory)).ok).toBe(false);
  });

  it('validates the owner’s settings in plain words', async () => {
    expect(errOf(await send('owner', 'alerts/configure', {}))).toMatch(/Choose a setting/);
    expect(errOf(await send('owner', 'alerts/configure', { usageWaitHours: 0 }))).toMatch(/invalid/);
    expect(errOf(await send('owner', 'alerts/configure', { critical: { nonsense: true } as never }))).toMatch(/invalid/);
    ok(await send('owner', 'alerts/configure', { stockoutDays: 5, critical: { overdue_delivery: true } }));
    const s = await panel.feed('alert_settings', {}, sid.owner);
    expect(s.ok && s.data).toMatchObject({ stockoutDays: 5, reorderDays: 7, usageWaitHours: 4 });
    expect(s.ok && s.data.kinds.find((k) => k.kind === 'overdue_delivery')).toMatchObject({ critical: true, label: 'Overdue order' });
    expect(s.ok && s.data.kinds.find((k) => k.kind === 'stockout')).toMatchObject({ critical: true });
  });
});

describe('safety', () => {
  it('never blocks a sale or a stock change if working out alerts fails', async () => {
    await ingredient('Flour', 2, { reorderLevel: 1 });
    const real = store.find.bind(store);
    store.find = (async (c: Parameters<Store['find']>[0], o?: Parameters<Store['find']>[1]) => {
      if (c === 'alerts') throw new Error('disk trouble in alerts');
      return real(c, o);
    }) as Store['find'];
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.5 }));
    expect((await store.list<{ id: string; onHand: number }>('ingredients'))[0]!.onHand).toBe(0.5);
    expect(errors.map(String).join()).toMatch(/disk trouble/);
    store.find = real;
    // The next check puts the alerts right.
    await panel.tick();
    expect((await inbox('inventory')).open).toHaveLength(1);
  });

  it('tidies away old cleared alerts and nothing else', async () => {
    await ingredient('Flour', 2, { reorderLevel: 1 });
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.5 }));
    ok(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 5 }));
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.4 })); // open again
    expect(await store.list<Alert>('alerts')).toHaveLength(2);
    expect((await panel.maintain()).alertsPruned).toBe(0);
    t += 31 * 86_400_000;
    await relog();
    expect((await panel.maintain()).alertsPruned).toBe(1);
    expect((await store.list<Alert>('alerts')).map((a) => a.status)).toEqual(['open']);
  });

  it('does not put the alert’s open state at the mercy of repeat checks', async () => {
    await ingredient('Flour', 2, { reorderLevel: 1 });
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 0.5 }));
    for (let i = 0; i < 5; i++) expect(await panel.tick()).toEqual({ raised: 0, resolved: 0 });
    expect(await store.list<Alert>('alerts')).toHaveLength(1);
    expect(await pendingNotices()).toHaveLength(1);
  });
});

describe('the stock forecast screen', () => {
  const forecast = async (role: Role, params: { ingredientId?: string; horizonDays?: number } = {}) => {
    const r = await panel.feed('stock_forecast', params, sid[role]);
    if (!r.ok) throw new Error(r.error.messages.join(' '));
    return r.data;
  };

  it('gives one continuous line per ingredient: real stock up to today, projected after, from bookings and what the chefs use', async () => {
    await ingredient('Flour', 3, { reorderLevel: 0.5 });
    ok(await send('baker', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 0.05, scaling: 'per_serving' })); // 0.5 kg for 10 servings
    const c = await cake(ymd(4));
    await c.price();
    const f = (await forecast('inventory', { ingredientId: ids.Flour! })).rows[0]!;
    const today = f.series.find((p) => p.kind === 'today')!;
    expect(today).toMatchObject({ stock: 3 });
    const baked = f.series.find((p) => p.date === ymd(3))!; // delivery tomorrow-minus-lead: baked the day before the 4th
    expect(baked).toMatchObject({ kind: 'projected', booked: 0.5, usual: 0, stock: 2.5 });
    expect(f.series.at(-1)!.stock).toBe(2.5);
    expect(f).toMatchObject({ status: 'ok', confidence: 'medium', usualPerDay: null, next7Days: 0.5, next7DaysText: '500 g' });
    // The line carries on from today with no gap.
    const days = f.series.map((p) => p.date);
    expect(new Set(days).size).toBe(days.length);
    expect(days[0]).toBe(ymd(-14));
    expect(days.at(-1)).toBe(ymd(14));
  });

  it('learns from what the chefs really used, and says how much it trusts itself', async () => {
    await ingredient('Flour', 20, { reorderLevel: 1 });
    ok(await send('baker', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 0.05, scaling: 'per_serving' }));
    const rangeId = (await store.list<{ id: string; ranges: Array<{ id: string }> }>('ingredients'))[0]!.ranges[0]!.id;
    // Three cakes where the chef used 40% more than suggested (0.5 suggested, 0.7 used).
    for (let i = 0; i < 3; i++) {
      const c = await cake(ymd(10));
      await c.price();
      ok(await send('baker', 'orders/advance_line', { orderId: c.orderId, lineId: c.lineId, to: 'in_production' }));
      ok(await send('baker', 'usage/report', { orderId: c.orderId, lineId: c.lineId, items: [{ ingredientId: ids.Flour!, rangeId }] }));
      const rid = (await store.list<{ id: string; status: string }>('usageReports')).find((r) => r.status === 'reported')!.id;
      ok(await send('inventory', 'usage/confirm', { reportId: rid, items: [{ ingredientId: ids.Flour!, qty: 0.7 }] }));
      await advance(86_400_000);
    }
    const next = await cake(ymd(5));
    await next.price();
    const f = (await forecast('baker', { ingredientId: ids.Flour! })).rows[0]!;
    expect(f.calibration).toEqual({ factor: 1.4, samples: 3, applied: true });
    expect(f.series.find((p) => p.kind === 'projected' && p.booked > 0)!.booked).toBe(0.7); // 0.5 suggested x 1.4
    expect(f.usualPerDay).toBeGreaterThan(0);
    expect(f.confidence).toBe('high');
  });

  it('leaves out cakes whose ingredients are already confirmed, and cakes nobody has priced yet', async () => {
    await ingredient('Flour', 3);
    ok(await send('baker', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 0.05, scaling: 'per_serving' }));
    await cake(ymd(2)); // quote requested, not priced: not on the books
    expect((await forecast('owner', { ingredientId: ids.Flour! })).rows[0]!.next7Days).toBe(0);
  });

  it('is for the kitchen and the owner only, and takes a sensible horizon', async () => {
    expect((await panel.feed('stock_forecast', {}, sid.cashier)).ok).toBe(false);
    expect((await panel.feed('stock_forecast', { horizonDays: 99 }, sid.owner)).ok).toBe(false);
    await ingredient('Flour', 3);
    expect((await forecast('owner', { horizonDays: 7 })).rows[0]!.series.filter((p) => p.kind === 'projected')).toHaveLength(7);
  });
});
