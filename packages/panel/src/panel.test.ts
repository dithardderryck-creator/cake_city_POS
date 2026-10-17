import { beforeEach, describe, expect, it } from 'vitest';
import {
  INTENT_NAMES,
  createMemoryStore,
  createPanel,
  seedDemo,
  DEMO_STAFF,
  type CatalogueGridItem,
  type DispatchResult,
  type Panel,
  type Store,
  type Staff,
} from './index';

let store: Store;
let panel: Panel;
let tick = 0;

const clock = { now: () => new Date(Date.UTC(2026, 8, 29, 8, 0, tick++)) };

async function signIn(role: (typeof DEMO_STAFF)[number]['role']) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
  const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin });
  if (!r.ok) throw new Error('sign in failed');
  return (r.data as { sessionId: string }).sessionId;
}

const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};

async function grid(sid: string) {
  const r = await panel.feed('catalogue_grid', {}, sid);
  if (!r.ok) throw new Error('grid failed');
  return r.data;
}

/** Find a sellable combination by its label, e.g. "8-inch, Chocolate ganache, Eggless". */
async function combo(sid: string, product: string, label: string) {
  const item = (await grid(sid)).find((g) => g.name === product) as CatalogueGridItem;
  const c = item.combinations.find((x) => x.label === label);
  if (!c) throw new Error(`No combination ${label}`);
  return c;
}

async function newOrder(sid: string, fulfilment: 'pickup' | 'delivery' = 'pickup') {
  const data = ok<{ orderId: string }>(
    await panel.dispatch(
      'orders/create_order',
      { source: 'walk_in', fulfilment, deliveryAddress: fulfilment === 'delivery' ? '12 Baker Street' : undefined },
      sid,
    ),
  );
  return data.orderId;
}

beforeEach(async () => {
  tick = 0;
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
});

describe('breakers (BR-21, BR-22)', () => {
  it('has a definition for every intent name', () => {
    expect(INTENT_NAMES.length).toBeGreaterThan(15);
  });

  it('blocks anything but sign-in until someone has signed in', async () => {
    const r = await panel.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unauthenticated');
  });

  it('rejects a wrong PIN without revealing which part was wrong', async () => {
    const staff = (await store.list<Staff>('staff'))[0]!;
    const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin: '0000' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.messages[0]).toMatch(/PIN does not match/);
  });

  it('denies a cashier from changing prices and audits the attempt', async () => {
    const cashier = await signIn('cashier');
    const owner = await signIn('owner');
    const c = await combo(owner, 'Red Velvet Cake', 'Slice, Vanilla cream, Standard');
    const r = await panel.dispatch('catalogue/set_price', { combinationId: c.combinationId, price: 1 }, cashier);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    const audit = await panel.feed('audit_view', {}, owner);
    if (!audit.ok) throw new Error('audit failed');
    expect(audit.data.some((a) => a.outcome === 'denied' && a.intent === 'catalogue/set_price')).toBe(true);
  });

  it('audits every successful change and queues it for sync', async () => {
    const cashier = await signIn('cashier');
    const owner = await signIn('owner');
    const before = (await panel.feed('audit_view', {}, owner)) as { ok: true; data: unknown[] };
    await newOrder(cashier);
    const after = (await panel.feed('audit_view', {}, owner)) as { ok: true; data: { intent: string; who: string }[] };
    expect(after.data.length).toBe(before.data.length + 1);
    expect(after.data[0]).toMatchObject({ intent: 'orders/create_order', who: 'Baraka (Cashier)' });
    const it = await signIn('it');
    const map = await panel.feed('panel_map', {}, it);
    if (!map.ok) throw new Error('map failed');
    expect(map.data.outbox.pending).toBeGreaterThan(0);
  });

  it('tells the UI which screens each role sees, so the UI holds no permission logic', async () => {
    const it = await signIn('it');
    const cashier = await signIn('cashier');
    const owner = await signIn('owner');
    const ids = async (sid: string) => {
      const r = await panel.feed('navigation', {}, sid);
      if (!r.ok) throw new Error('nav failed');
      return r.data.map((n) => n.id);
    };
    expect(await ids(it)).toEqual(['requests', 'panel_map']);
    expect(await ids(cashier)).toEqual(['sell', 'orders', 'quotes', 'alerts', 'requests', 'catalogue']);
    expect(await ids(owner)).toContain('audit');
    const g = await panel.feed('catalogue_grid', {}, cashier);
    if (!g.ok) throw new Error('grid failed');
    expect(g.data[0]!.can).toEqual({ price: false, stock: false, manage: false });
  });

  it('keeps the panel map to IT only', async () => {
    const owner = await signIn('owner');
    const r = await panel.feed('panel_map', {}, owner);
    expect(r.ok).toBe(false);
  });
});

describe('catalogue variation grid (D-26, D-27)', () => {
  it('generates every combination and leaves them unpriced until the owner prices them', async () => {
    const owner = await signIn('owner');
    const { productId } = ok<{ productId: string }>(
      await panel.dispatch('catalogue/create_product', { name: 'Vanilla Sponge' }, owner),
    );
    const item0 = (await grid(owner)).find((g) => g.name === 'Chocolate Fudge Cake')!;
    const valueIds = item0.groups.flatMap((g) => g.values.map((v) => v.valueId));
    ok(await panel.dispatch('catalogue/set_product_options', { productId, valueIds }, owner));
    const gen = ok<{ created: number }>(await panel.dispatch('catalogue/generate_combinations', { productId }, owner));
    expect(gen.created).toBe(3 * 2 * 3); // sizes x fillings x dietary
    const item = (await grid(owner)).find((g) => g.productId === productId)!;
    expect(item.combinations.every((c) => !c.sellable && c.reason === 'No price yet')).toBe(true);
    expect(item.sellable).toBe(false);
  });

  it('never deletes: archiving hides a product but keeps it on past orders (BR-10)', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const c = await combo(owner, 'Lemon Drizzle Cake', 'Slice, Vanilla cream, Standard');
    const orderId = await newOrder(cashier);
    ok(await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 1 }, cashier));
    const item = (await grid(owner)).find((g) => g.name === 'Lemon Drizzle Cake')!;
    ok(await panel.dispatch('catalogue/archive_product', { productId: item.productId }, owner));
    expect((await grid(owner)).some((g) => g.name === 'Lemon Drizzle Cake')).toBe(false);
    const card = await panel.feed('order_card', { orderId }, cashier);
    if (!card.ok) throw new Error('card failed');
    expect(card.data.lines[0]!.title).toBe('Lemon Drizzle Cake');
  });

  it('will not sell a combination that is off the menu today', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const item = (await grid(owner)).find((g) => g.name === 'Red Velvet Cake')!;
    ok(await panel.dispatch('catalogue/toggle_available_today', { productId: item.productId, available: false }, owner));
    const orderId = await newOrder(cashier);
    const r = await panel.dispatch(
      'orders/add_catalogue_line',
      { orderId, combinationId: item.combinations[0]!.combinationId, qty: 1 },
      cashier,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.messages[0]).toMatch(/off the menu today/);
  });

  it('still shows the price of a cake that is only switched off for today, and says it is not sellable', async () => {
    const owner = await signIn('owner');
    const before = (await grid(owner)).find((g) => g.name === 'Red Velvet Cake')!;
    expect(before.priceFromLabel).toBeTruthy();
    ok(await panel.dispatch('catalogue/toggle_available_today', { productId: before.productId, available: false }, owner));
    const after = (await grid(owner)).find((g) => g.name === 'Red Velvet Cake')!;
    expect(after.priceFromLabel).toBe(before.priceFromLabel);
    expect(after.sellable).toBe(false);
    expect(after.availableToday).toBe(false);
  });
});

describe('orders and stock (BR-03, BR-11)', () => {
  it('freezes the price when the item is added (BR-11)', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const c = await combo(owner, 'Chocolate Fudge Cake', 'Slice, Vanilla cream, Standard');
    const orderId = await newOrder(cashier);
    ok(await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 2 }, cashier));
    ok(await panel.dispatch('catalogue/set_price', { combinationId: c.combinationId, price: 99 }, owner));
    const card = await panel.feed('order_card', { orderId }, cashier);
    if (!card.ok) throw new Error('card failed');
    expect(card.data.total).toBe(7000); // still 2 x 3500
  });

  it('drops stock only when the order is completed, and shows committed stock until then (BR-03)', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const c = await combo(owner, 'Chocolate Fudge Cake', 'Slice, Vanilla cream, Standard');
    expect(c.onHand).toBe(4);
    const orderId = await newOrder(cashier);
    const line = ok<{ lineId: string }>(
      await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 3 }, cashier),
    );
    let now = await combo(owner, 'Chocolate Fudge Cake', c.label);
    expect(now.onHand).toBe(4);
    expect(now.committed).toBe(3);

    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'ready' }, cashier));
    now = await combo(owner, 'Chocolate Fudge Cake', c.label);
    expect(now.onHand).toBe(4); // ready is not completed

    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'completed' }, cashier));
    now = await combo(owner, 'Chocolate Fudge Cake', c.label);
    expect(now.onHand).toBe(1);
    expect(now.committed).toBe(0);
  });

  it('allows completing with a shortfall but records it as a count difference', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const c = await combo(owner, 'Chocolate Fudge Cake', 'Slice, Vanilla cream, Standard');
    const orderId = await newOrder(cashier);
    const line = ok<{ lineId: string }>(
      await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 6 }, cashier),
    );
    const warned = await combo(owner, 'Chocolate Fudge Cake', c.label);
    expect(warned.warning).toMatch(/Open orders need 6/);
    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'ready' }, cashier));
    const done = await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'completed' }, cashier);
    expect(done.ok && done.warnings.join(' ')).toMatch(/short by 2/);
    expect((await combo(owner, 'Chocolate Fudge Cake', c.label)).onHand).toBe(0);
    const diffs = await store.list<{ id: string; difference: number }>('countDifferences');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.difference).toBe(-2);
  });

  it('delivery orders must go out for delivery before completing', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const c = await combo(owner, 'Lemon Drizzle Cake', 'Slice, Vanilla cream, Standard');
    const orderId = await newOrder(cashier, 'delivery');
    const line = ok<{ lineId: string }>(
      await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 1 }, cashier),
    );
    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'ready' }, cashier));
    const skip = await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'completed' }, cashier);
    expect(skip.ok).toBe(false);
    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'out_for_delivery' }, cashier));
    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'completed' }, cashier));
  });

  it('numbers orders per device so offline devices never collide (BR-26)', async () => {
    // Two devices, each with its own local copy, both creating "order 1" while offline.
    const storeB = createMemoryStore();
    const panelB = createPanel({ store: storeB, clock, devicePrefix: 'B' });
    await seedDemo(storeB, panelB);
    const cashierB = (await storeB.list<Staff>('staff')).find((s) => s.role === 'cashier')!;
    const signB = await panelB.dispatch('auth/sign_in', { userId: cashierB.id, pin: '2222' });
    const sidB = (signB as { ok: true; data: { sessionId: string } }).data.sessionId;

    const cashierA = await signIn('cashier');
    const a = await newOrder(cashierA);
    const b = ok<{ number: string }>(
      await panelB.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, sidB),
    );

    const listA = await panel.feed('order_list', {}, cashierA);
    if (!listA.ok) throw new Error('list failed');
    expect(listA.data.find((o) => o.orderId === a)!.number).toBe('A-0001');
    expect(b.number).toBe('B-0001');
  });
});

describe('payments (BR-06, BR-07, BR-08)', () => {
  async function orderWithTotal() {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const c = await combo(owner, 'Chocolate Fudge Cake', 'Slice, Vanilla cream, Standard'); // price 3500, so 4 of them come to 14,000
    const orderId = await newOrder(cashier);
    ok(await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 4 }, cashier));
    return { owner, cashier, orderId };
  }
  const card = async (sid: string, orderId: string) => {
    const r = await panel.feed('order_card', { orderId }, sid);
    if (!r.ok) throw new Error('card failed');
    return r.data;
  };

  it('takes full payment in cash and marks the order paid', async () => {
    const { cashier, orderId } = await orderWithTotal();
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 14000 }, cashier));
    const c = await card(cashier, orderId);
    expect(c.paymentStatus).toBe('paid');
    expect(c.canRecordPayment).toBe(false);
  });

  it('needs an explicit exception for a partial payment, then remembers it', async () => {
    const { cashier, orderId } = await orderWithTotal();
    const blocked = await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 8000 }, cashier);
    expect(blocked.ok).toBe(false);
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 8000, allowPartial: true }, cashier));
    expect((await card(cashier, orderId)).paymentStatus).toBe('partial');
    // Later part-payments on the same order no longer need the exception.
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'mobile_money', amount: 5000, reference: 'TX123' }, cashier));
    expect((await card(cashier, orderId)).balance).toBe(1000);
  });

  it('takes whole shillings only', async () => {
    const { cashier, orderId } = await orderWithTotal();
    const cents = await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 100.5, allowPartial: true }, cashier);
    expect(!cents.ok && cents.error.messages.join(' ')).toMatch(/whole number of shillings/);
    expect((await card(cashier, orderId)).totalLabel).toBe('TSh 14,000');
  });

  it('refuses a payment above the balance', async () => {
    const { cashier, orderId } = await orderWithTotal();
    const r = await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 15000 }, cashier);
    expect(r.ok).toBe(false);
  });

  it('only the owner can refund, and a reason is required (BR-08)', async () => {
    const { owner, cashier, orderId } = await orderWithTotal();
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 14000 }, cashier));
    const denied = await panel.dispatch('payments/approve_refund', { orderId, amount: 5000, reason: 'x', method: 'cash' }, cashier);
    expect(denied.ok).toBe(false);
    const noReason = await panel.dispatch('payments/approve_refund', { orderId, amount: 5000, reason: ' ', method: 'cash' }, owner);
    expect(noReason.ok).toBe(false);
    tick += 6 * 60; // past the refund cooldown
    ok(await panel.dispatch('payments/approve_refund', { orderId, amount: 5000, reason: 'Customer changed date', method: 'cash' }, owner));
    const c = await card(owner, orderId);
    expect(c.refundedLabel).toBe('TSh 5,000');
    expect(c.balance).toBe(5000);
  });

  it('a paid order can only be cancelled by the owner', async () => {
    const { owner, cashier, orderId } = await orderWithTotal();
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 14000 }, cashier));
    const denied = await panel.dispatch('orders/cancel_order', { orderId }, cashier);
    expect(denied.ok).toBe(false);
    ok(await panel.dispatch('orders/cancel_order', { orderId }, owner));
    expect((await card(owner, orderId)).status).toBe('cancelled');
  });

  it('warns when an order is handed over with a balance (open question Q-01)', async () => {
    const { cashier, orderId } = await orderWithTotal();
    const c = await card(cashier, orderId);
    const line = c.lines[0]!;
    ok(await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'ready' }, cashier));
    const r = await panel.dispatch('orders/advance_line', { orderId, lineId: line.lineId, to: 'completed' }, cashier);
    expect(r.ok && r.warnings.join(' ')).toMatch(/still has TSh 14,000 unpaid/);
  });
});

describe('offline sync outbox', () => {
  it('keeps changes safe and reports the wait when offline', async () => {
    let online = false;
    const pushed: number[] = [];
    const p = createPanel({
      store,
      clock,
      terminals: { sync: { isOnline: () => online, push: async () => undefined, pushChanges: async (changes) => (pushed.push(changes.length), { ok: true as const }) } },
    });
    const cashier = (await store.list<Staff>('staff')).find((s) => s.role === 'cashier')!;
    const owner = (await store.list<Staff>('staff')).find((s) => s.role === 'owner')!;
    const cs = (await p.dispatch('auth/sign_in', { userId: cashier.id, pin: '2222' })) as { ok: true; data: { sessionId: string } };
    const os = (await p.dispatch('auth/sign_in', { userId: owner.id, pin: '1111' })) as { ok: true; data: { sessionId: string } };
    await p.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, cs.data.sessionId);

    const offline = await p.dispatch('sync/flush', {}, os.data.sessionId);
    expect(offline.ok && offline.warnings.join(' ')).toMatch(/will send when the connection returns/);
    expect(pushed).toHaveLength(0);

    online = true;
    const sent = await p.dispatch('sync/flush', {}, os.data.sessionId);
    expect(sent.ok).toBe(true);
    expect(pushed[0]).toBeGreaterThan(0);
    // The audit line for the first flush is itself a change, so a manual flush right after may carry that one line.
    const again = await p.dispatch('sync/flush', {}, os.data.sessionId);
    expect(again.ok && again.summary).toMatch(/up to date|Sent 1 changes/);
  });
});
