import { beforeEach, describe, expect, it } from 'vitest';
import { applyFindOptions, createMemoryStore, createPanel, schemas, seedDemo, sha256Hex, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';

/** A clock the test can move forward. */
function makeClock() {
  let t = Date.UTC(2026, 8, 29, 8, 0, 0);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

/** Adds a real event-loop gap before every operation, so requests genuinely overlap unless the panel prevents it. */
function slowStore(base: Store): Store {
  const gap = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    get: async (c, id) => (await gap(), base.get(c, id)),
    put: async (c, r) => (await gap(), base.put(c, r)),
    delete: async (c, id) => (await gap(), base.delete(c, id)),
    list: async (c) => (await gap(), base.list(c)),
    find: async (c, o) => (await gap(), base.find(c, o)),
    transaction: (fn) => base.transaction(fn),
  } as Store;
}

let store: Store;
let clock: ReturnType<typeof makeClock>;
let panel: Panel;

const newPanel = (s: Store = store, extra: Parameters<typeof createPanel>[0] = {}) => createPanel({ store: s, clock, ...extra });

async function staffId(role: string) {
  return (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
}
async function signIn(role: (typeof DEMO_STAFF)[number]['role'], p: Panel = panel) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const r = await p.dispatch('auth/sign_in', { userId: await staffId(role), pin });
  if (!r.ok) throw new Error(`sign in failed: ${r.error.messages.join(' ')}`);
  return (r.data as { sessionId: string }).sessionId;
}
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : `${r.error.code}: ${r.error.messages.join(' ')}`);

beforeEach(async () => {
  clock = makeClock();
  store = createMemoryStore();
  panel = newPanel();
  await seedDemo(store, panel);
});

describe('PIN lockout', () => {
  it('locks after five wrong PINs, refuses even the right PIN, then unlocks with time', async () => {
    const userId = await staffId('cashier');
    for (let i = 1; i <= 4; i++) {
      const r = await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
      expect(errOf(r)).toMatch(/does not match/);
    }
    const fifth = await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
    expect(errOf(fifth)).toMatch(/Locked for 1 minute/);

    // The right PIN is refused while locked, and says how long to wait.
    const locked = await panel.dispatch('auth/sign_in', { userId, pin: '2222' });
    expect(errOf(locked)).toMatch(/Try again in 1 minute/);

    clock.advance(61_000);
    expect(ok(await panel.dispatch('auth/sign_in', { userId, pin: '2222' }))).toHaveProperty('sessionId');
  });

  it('gets longer each time, and a correct sign-in clears the count', async () => {
    const userId = await staffId('baker');
    for (let i = 0; i < 5; i++) await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
    clock.advance(61_000);
    for (let i = 0; i < 4; i++) await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
    const second = await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
    expect(errOf(second)).toMatch(/Locked for 5 minutes/);
    clock.advance(5 * 60_000 + 1000);
    ok(await panel.dispatch('auth/sign_in', { userId, pin: '3333' }));
    // After success the counter starts again from the shortest lock.
    for (let i = 0; i < 4; i++) await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
    expect(errOf(await panel.dispatch('auth/sign_in', { userId, pin: '0000' }))).toMatch(/Locked for 1 minute/);
  });

  it('owner can see who is locked and reset their PIN, which unlocks them', async () => {
    const userId = await staffId('cashier');
    for (let i = 0; i < 5; i++) await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
    const owner = await signIn('owner');
    const list = await panel.feed('staff_list', {}, owner);
    if (!list.ok) throw new Error('list failed');
    expect(list.data.find((s) => s.id === userId)!.locked).toBe(true);
    ok(await panel.dispatch('staff/set_pin', { userId, pin: '5555' }, owner));
    ok(await panel.dispatch('auth/sign_in', { userId, pin: '5555' }));
  });

  it('does not keep records for people who do not exist', async () => {
    const before = (await store.list('loginState')).length;
    for (let i = 0; i < 10; i++) await panel.dispatch('auth/sign_in', { userId: `ghost_${i}`, pin: '0000' });
    expect((await store.list('loginState')).length).toBe(before);
  });
});

describe('sessions', () => {
  it('survive a server restart, because they live in the store', async () => {
    const token = await signIn('cashier');
    const restarted = newPanel(store); // same data, brand new process
    const r = await restarted.feed('navigation', {}, token);
    expect(r.ok).toBe(true);
  });

  it('are stored hashed, never as the token itself', async () => {
    const token = await signIn('owner');
    const rows = await store.list<{ id: string }>('sessions');
    expect(rows.some((r) => r.id === token)).toBe(false);
    expect(rows.map((r) => r.id)).toContain(await sha256Hex(token));
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('end after sitting idle, and after the absolute limit however busy', async () => {
    const idle = newPanel(store, { sessionIdleMs: 60_000, sessionMaxMs: 10 * 60_000 });
    const token = await signIn('cashier', idle);
    clock.advance(30_000);
    expect((await idle.feed('navigation', {}, token)).ok).toBe(true);
    clock.advance(61_000);
    const after = await idle.feed('navigation', {}, token);
    expect(!after.ok && after.error.code).toBe('unauthenticated');

    const busy = await signIn('owner', idle);
    for (let i = 0; i < 12; i++) {
      clock.advance(55_000);
      await idle.feed('navigation', {}, busy); // keeps it from going idle
    }
    const capped = await idle.feed('navigation', {}, busy);
    expect(!capped.ok && capped.error.code).toBe('unauthenticated');
  });

  it('stop working the moment a person is switched off', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    ok(await panel.dispatch('staff/set_active', { userId: await staffId('cashier'), active: false }, owner));
    const r = await panel.feed('navigation', {}, cashier);
    expect(!r.ok && r.error.code).toBe('unauthenticated');
    expect(errOf(await panel.dispatch('auth/sign_in', { userId: await staffId('cashier'), pin: '2222' }))).toMatch(/does not match/);
  });

  it('are cleaned up by maintain()', async () => {
    const idle = newPanel(store, { sessionIdleMs: 60_000 });
    await signIn('cashier', idle);
    clock.advance(120_000);
    const r = await idle.maintain();
    expect(r.sessionsPruned).toBeGreaterThan(0);
  });
});

describe('retry safety (request ids)', () => {
  async function orderReadyToPay() {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const grid = await panel.feed('catalogue_grid', {}, owner);
    if (!grid.ok) throw new Error('grid');
    const combo = grid.data.find((g) => g.name === 'Chocolate Fudge Cake')!.combinations.find((c) => c.label === 'Slice, Vanilla cream, Standard')!;
    const { orderId } = ok<{ orderId: string }>(await panel.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, cashier));
    ok(await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: combo.combinationId, qty: 4 }, cashier));
    return { cashier, orderId };
  }

  it('answers a repeated request from memory instead of taking the payment twice', async () => {
    const { cashier, orderId } = await orderReadyToPay();
    const pay = { orderId, method: 'cash' as const, amount: 10, allowPartial: true };
    const first = await panel.dispatch('payments/record_payment', pay, cashier, { requestId: 'req-1' });
    const again = await panel.dispatch('payments/record_payment', pay, cashier, { requestId: 'req-1' });
    expect(again).toEqual(first);
    expect((await store.list('payments')).length).toBe(1);
    // A different id is a genuinely new payment.
    ok(await panel.dispatch('payments/record_payment', { ...pay, amount: 5 }, cashier, { requestId: 'req-2' }));
    expect((await store.list('payments')).length).toBe(2);
  });

  it('does not remember failures, so a corrected retry can succeed', async () => {
    const { cashier, orderId } = await orderReadyToPay();
    const bad = await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 999 }, cashier, { requestId: 'req-x' });
    expect(bad.ok).toBe(false);
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 20 }, cashier, { requestId: 'req-x' }));
  });

  it('does not let one person replay another person’s request id', async () => {
    const { cashier, orderId } = await orderReadyToPay();
    const owner = await signIn('owner');
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 5, allowPartial: true }, cashier, { requestId: 'shared' }));
    ok(await panel.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 5 }, owner, { requestId: 'shared' }));
    expect((await store.list('payments')).length).toBe(2);
  });
});

describe('all or nothing', () => {
  it('rolls back everything an instruction wrote if any part fails', async () => {
    // A store whose audit write fails once, to imitate a disk error at the worst moment.
    const base = createMemoryStore();
    let armed = false;
    const flaky: Store = {
      ...base,
      put: async (c, r) => {
        if (armed && c === 'audit') {
          armed = false;
          throw new Error('disk full');
        }
        return base.put(c, r);
      },
    };
    const p = createPanel({ store: flaky, clock, onError: () => undefined });
    await seedDemo(flaky, p);
    const cashierId = (await base.list<Staff>('staff')).find((s) => s.role === 'cashier')!.id;
    const s = await p.dispatch('auth/sign_in', { userId: cashierId, pin: '2222' });
    const token = (ok<{ sessionId: string }>(s)).sessionId;

    const ordersBefore = (await base.list('orders')).length;
    const counterBefore = await base.get<{ id: string; value: number }>('counters', 'order_seq');
    armed = true;
    const r = await p.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, token);
    expect(errOf(r)).toMatch(/error: Something went wrong. Nothing was saved/);
    // No order, and the order number counter did not move.
    expect((await base.list('orders')).length).toBe(ordersBefore);
    expect(await base.get('counters', 'order_seq')).toEqual(counterBefore);
    // And the very next attempt works and takes the number that was never used.
    const again = ok<{ number: string }>(await p.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, token));
    expect(again.number).toMatch(/-0001$/);
  });
});

describe('concurrency', () => {
  let slowPanel: Panel;
  beforeEach(async () => {
    store = slowStore(createMemoryStore());
    slowPanel = newPanel(store);
    await seedDemo(store, slowPanel);
    panel = slowPanel;
  });

  it('gives twenty simultaneous orders twenty different numbers', async () => {
    const cashier = await signIn('cashier');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => panel.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, cashier)),
    );
    const numbers = results.map((r) => ok<{ number: string }>(r).number);
    expect(new Set(numbers).size).toBe(20);
    expect(numbers.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `A-${String(i + 1).padStart(4, '0')}`));
  });

  it('never sells the same last item twice when two completions race', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const grid = await panel.feed('catalogue_grid', {}, owner);
    if (!grid.ok) throw new Error('grid');
    const c = grid.data.find((g) => g.name === 'Lemon Drizzle Cake')!.combinations.find((x) => x.label === 'Slice, Vanilla cream, Standard')!;
    ok(await panel.dispatch('stock/set_count', { combinationId: c.combinationId, count: 1 }, owner));
    const lines: Array<[string, string]> = [];
    for (let i = 0; i < 2; i++) {
      const { orderId } = ok<{ orderId: string }>(await panel.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, cashier));
      const { lineId } = ok<{ lineId: string }>(await panel.dispatch('orders/add_catalogue_line', { orderId, combinationId: c.combinationId, qty: 1 }, cashier));
      ok(await panel.dispatch('orders/advance_line', { orderId, lineId, to: 'ready' }, cashier));
      lines.push([orderId, lineId]);
    }
    await Promise.all(lines.map(([orderId, lineId]) => panel.dispatch('orders/advance_line', { orderId, lineId, to: 'completed' }, cashier)));
    const after = (await store.get<{ id: string; stockCount: number }>('combinations', c.combinationId))!;
    expect(after.stockCount).toBe(0); // never negative
    const diffs = await store.list<{ id: string; difference: number }>('countDifferences');
    expect(diffs.map((d) => d.difference)).toEqual([-1]); // exactly one of the two was a shortfall
  });
});

describe('malformed requests never reach a circuit', () => {
  it('rejects wrong types, unknown fields, and absurd sizes, and stays up', async () => {
    const owner = await signIn('owner');
    const grid = await panel.feed('catalogue_grid', {}, owner);
    if (!grid.ok) throw new Error('grid');
    const combinationId = grid.data[0]!.combinations[0]!.combinationId;

    const badType = await panel.dispatch('catalogue/set_price', { combinationId, price: 'free' as never }, owner);
    expect(errOf(badType)).toMatch(/^invalid: Check "price"/);
    const extra = await panel.dispatch('catalogue/set_price', { combinationId, price: 5, sneaky: true } as never, owner);
    expect(errOf(extra)).toMatch(/Unexpected field/);
    const huge = await panel.dispatch('catalogue/create_product', { name: 'x'.repeat(5000) }, owner);
    expect(huge.ok).toBe(false);
    const nan = await panel.dispatch('catalogue/set_price', { combinationId, price: Number.NaN }, owner);
    expect(nan.ok).toBe(false);
    const nothing = await panel.dispatch('catalogue/set_price', undefined as never, owner);
    expect(nothing.ok).toBe(false);
    const unknown = await panel.dispatch('catalogue/drop_everything' as never, {} as never, owner);
    expect(errOf(unknown)).toMatch(/Unknown instruction/);
    // Still alive and well.
    expect((await panel.feed('navigation', {}, owner)).ok).toBe(true);
  });

  it('rejects malformed feed parameters too', async () => {
    const owner = await signIn('owner');
    const r = await panel.feed('order_card', { orderId: { $ne: null } } as never, owner);
    expect(!r.ok && r.error.code).toBe('invalid');
    const unknown = await panel.feed('secrets' as never, {} as never, owner);
    expect(!unknown.ok && unknown.error.code).toBe('invalid');
  });

  it('has a schema for every instruction', async () => {
    const { INTENT_NAMES } = await import('./index');
    expect(Object.keys(schemas).sort()).toEqual([...INTENT_NAMES].sort());
  });
});

describe('staff management', () => {
  it('lets only the owner manage staff', async () => {
    const cashier = await signIn('cashier');
    const r = await panel.dispatch('staff/create', { name: 'Zed', role: 'baker', pin: '1234' }, cashier);
    expect(errOf(r)).toMatch(/^forbidden/);
  });

  it('creates staff who can sign in, with a hashed PIN', async () => {
    const owner = await signIn('owner');
    const { userId } = ok<{ userId: string }>(await panel.dispatch('staff/create', { name: 'Zawadi', role: 'cashier', pin: '7777' }, owner));
    const saved = (await store.get<Staff>('staff', userId))!;
    expect(saved.pinHash).not.toContain('7777');
    ok(await panel.dispatch('auth/sign_in', { userId, pin: '7777' }));
  });

  it('protects the last owner and the owner’s own account', async () => {
    const owner = await signIn('owner');
    const ownerId = await staffId('owner');
    expect(errOf(await panel.dispatch('staff/set_active', { userId: ownerId, active: false }, owner))).toMatch(/your own account/);
    const { userId } = ok<{ userId: string }>(await panel.dispatch('staff/create', { name: 'Second Owner', role: 'owner', pin: '8888' }, owner));
    const second = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId, pin: '8888' })).sessionId;
    // Now there are two owners: the first can be switched off by the second, but not the last one left.
    ok(await panel.dispatch('staff/set_active', { userId: ownerId, active: false }, second));
    expect(errOf(await panel.dispatch('staff/set_active', { userId, active: false }, second))).toMatch(/own account/);
  });

  it('changing your own PIN needs the current one and signs out your other devices', async () => {
    const phone = await signIn('cashier');
    const tablet = await signIn('cashier');
    expect(errOf(await panel.dispatch('auth/change_pin', { currentPin: '0000', newPin: '4321' }, phone))).toMatch(/does not match/);
    ok(await panel.dispatch('auth/change_pin', { currentPin: '2222', newPin: '4321' }, phone));
    expect((await panel.feed('navigation', {}, phone)).ok).toBe(true);
    const gone = await panel.feed('navigation', {}, tablet);
    expect(!gone.ok && gone.error.code).toBe('unauthenticated');
    ok(await panel.dispatch('auth/sign_in', { userId: await staffId('cashier'), pin: '4321' }));
  });
});

describe('store find()', () => {
  const rows = [
    { id: 'a', kind: 'x', n: 3 },
    { id: 'b', kind: 'y', n: 1 },
    { id: 'c', kind: 'x', n: 2 },
  ];
  it('filters, matches any-of, sorts and limits', () => {
    expect(applyFindOptions(rows, { where: { kind: 'x' } }).map((r) => r.id)).toEqual(['a', 'c']);
    expect(applyFindOptions(rows, { where: { id: ['a', 'b'] } }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(applyFindOptions(rows, { orderBy: { field: 'n' } }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(applyFindOptions(rows, { orderBy: { field: 'n', dir: 'desc' }, limit: 2 }).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('API reference', () => {
  it('matches the committed docs/api-reference.md, so the documentation cannot go stale', async () => {
    const { renderApiReference } = await import('./index');
    const { readFileSync, existsSync } = await import('node:fs');
    const file = new URL('../../../docs/api-reference.md', import.meta.url);
    expect(existsSync(file), 'docs/api-reference.md is missing. Run: npm run docs:api').toBe(true);
    expect(readFileSync(file, 'utf8'), 'docs/api-reference.md is out of date. Run: npm run docs:api').toBe(renderApiReference());
  });
});
