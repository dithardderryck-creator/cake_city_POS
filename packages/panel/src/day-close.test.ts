import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type CatalogueGridItem, type DispatchResult, type Panel, type Staff, type Store } from './index';
import type { DayReportData } from './index';
import type { AuditEntry, DayClose } from './domain';

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

const DAY = '2026-10-05';
async function later(ms: number) {
  t += ms;
  for (const r of ['owner', 'cashier', 'baker', 'inventory', 'it'] as Role[]) await signIn(r); // sessions do not last a whole day
}
const report = (role: Role = 'owner', day?: string) => feed<DayReportData>(role, 'day_report', day ? { day } : {});
async function sell(name: string, method: 'cash' | 'card' | 'mobile_money' = 'cash', qty = 1) {
  const c = await sellable(name);
  const r = ok<{ orderId: string; total: number }>(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty }], method }));
  return r;
}
const close = (counted: number, extra: Record<string, unknown> = {}, role: Role = 'owner') => send(role, 'day/close', { countedCash: counted, ...extra });

describe('end-of-day report', () => {
  it('starts as a quiet day: nothing taken, an empty drawer, not closed', async () => {
    const r = await report();
    expect(r).toMatchObject({ day: DAY, isToday: true, closed: null, closeBy: 'owner' });
    expect(r.money.net).toBe(0);
    expect(r.cash.expected).toBe(0);
    expect(r.topItems).toEqual([]);
  });

  it('adds up money by method, items sold and the biggest sellers', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    const b = await sell('Red Velvet Cake', 'card', 2);
    const r = await report();
    expect(r.money.taken).toBe(a.total + b.total);
    expect(r.money.byMethod.find((m) => m.method === 'cash')!.taken).toBe(a.total);
    expect(r.money.byMethod.find((m) => m.method === 'card')!.taken).toBe(b.total);
    expect(r.orders).toMatchObject({ withPayments: 2, instantSales: 2, itemsSold: 3 });
    expect(r.topItems[0]).toMatchObject({ name: 'Red Velvet Cake', qty: 3 });
    expect(r.cash.cashIn).toBe(a.total); // card money is not in the drawer
    expect(r.cash.expected).toBe(a.total);
  });

  it('takes cash refunds out of the drawer sum, lists them with reasons, and leaves card refunds out of it', async () => {
    ok(await send('owner', 'settings/update', { refundCooldownMinutes: 0 }));
    const a = await sell('Red Velvet Cake', 'cash');
    const b = await sell('Red Velvet Cake', 'card');
    ok(await send('owner', 'payments/approve_refund', { orderId: a.orderId, amount: 500, reason: 'Cracked base', method: 'cash' }));
    ok(await send('owner', 'payments/approve_refund', { orderId: b.orderId, amount: 700, reason: 'Wrong flavour', method: 'card' }));
    const r = await report();
    expect(r.money.refunded).toBe(1200);
    expect(r.money.net).toBe(a.total + b.total - 1200);
    expect(r.cash.cashRefunded).toBe(500);
    expect(r.cash.expected).toBe(a.total - 500);
    expect(r.refunds.map((x) => x.reason)).toEqual(['Cracked base', 'Wrong flavour']);
  });

  it('shows another day on request and ignores a bad date', async () => {
    await sell('Red Velvet Cake');
    await later(86_400_000);
    expect((await report('owner', DAY)).money.taken).toBeGreaterThan(0);
    expect((await report()).money.taken).toBe(0);
    expect((await report('owner', 'junk' as string).catch(() => null))).toBeNull(); // the schema refuses it
  });
});

describe('closing the day', () => {
  it('records the count; an exact count needs no note', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    ok(await close(a.total));
    const r = await report();
    expect(r.closed).toMatchObject({ countedCash: a.total, difference: 0, byName: expect.any(String), changedSince: false, note: null });
    expect(r.closed!.differenceWords).toMatch(/matches/);
    const rec = (await store.list<DayClose>('dayCloses'))[0]!;
    expect(rec).toMatchObject({ id: DAY, expectedCash: a.total, openingFloat: 0 });
  });

  it('needs a note when the count is off, and says by how much and which way', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    expect(errOf(await close(a.total - 100))).toMatch(/short by .*100.*note/);
    expect(errOf(await close(a.total + 100))).toMatch(/over by/);
    ok(await close(a.total - 100, { note: 'Gave change from my own pocket' }));
    const c = (await report()).closed!;
    expect(c.difference).toBe(-100);
    expect(c.differenceWords).toMatch(/short/);
    expect(c.note).toBe('Gave change from my own pocket');
  });

  it('writes the close to the audit trail', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    ok(await close(a.total));
    const aud = (await store.list<AuditEntry>('audit')).filter((x) => x.intent === 'day/close');
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ outcome: 'ok' });
    expect(aud[0]!.summary).toMatch(/Closed 2026-10-05/);
  });

  it('locks nothing: a later close replaces the count, and a sale after closing shows as a change', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    ok(await close(a.total));
    const b = await sell('Red Velvet Cake', 'cash');
    const r = await report();
    expect(r.closed!.changedSince).toBe(true);
    expect(r.cash.expected).toBe(a.total + b.total);
    ok(await close(a.total + b.total));
    expect((await store.list('dayCloses')).length).toBe(1);
    expect((await report()).closed).toMatchObject({ changedSince: false, countedCash: a.total + b.total });
  });

  it('carries the float left in the drawer into the next day', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    ok(await close(a.total, { floatKept: a.total }));
    await later(86_400_000);
    const b = await sell('Red Velvet Cake', 'cash');
    const r = await report();
    expect(r.cash.openingFloat).toBe(a.total);
    expect(r.cash.expected).toBe(a.total + b.total);
    // Counting one day later starts from the close before it, not from a later one.
    expect((await report('owner', DAY)).cash.openingFloat).toBe(0);
  });

  it('can close an earlier day that was forgotten, but not a day that has not happened', async () => {
    const a = await sell('Red Velvet Cake', 'cash');
    await later(2 * 86_400_000);
    ok(await send('owner', 'day/close', { day: DAY, countedCash: a.total }));
    expect((await report('owner', DAY)).closed).not.toBeNull();
    expect(errOf(await send('owner', 'day/close', { day: '2026-12-01', countedCash: 0 }))).toMatch(/not happened/);
    expect((await send('owner', 'day/close', { day: '2026-13-45', countedCash: 0 })).ok).toBe(false);
  });

  it('refuses a float bigger than the count, and bad money', async () => {
    expect(errOf(await close(1000, { floatKept: 2000, note: 'x' }))).toMatch(/more in the drawer than you counted/);
    expect((await close(-5)).ok).toBe(false);
    expect((await close(10.5)).ok).toBe(false);
  });
});

describe('who may close', () => {
  it('lets only the owner by default: the cashier cannot close or open the report; baker and others cannot at all', async () => {
    expect(errOf(await close(0, {}, 'cashier'))).toMatch(/Only the owner/);
    const f = await panel.feed('day_report', {} as never, sid.cashier);
    expect(f.ok).toBe(false);
    for (const r of ['baker', 'inventory', 'it'] as Role[]) {
      expect((await close(0, {}, r)).ok).toBe(false);
      expect((await panel.feed('day_report', {} as never, sid[r])).ok).toBe(false);
    }
  });

  it('lets the cashier count too once the owner switches it on, and names who closed', async () => {
    ok(await send('owner', 'settings/update', { dayCloseBy: 'cashier_and_owner' }));
    expect((await feed<{ dayCloseBy: string }>('cashier', 'shop_settings')).dayCloseBy).toBe('cashier_and_owner');
    const a = await sell('Red Velvet Cake', 'cash');
    expect((await report('cashier')).closeBy).toBe('cashier_and_owner');
    ok(await close(a.total, {}, 'cashier'));
    const cashierName = DEMO_STAFF.find((s) => s.role === 'cashier')!.name;
    expect((await report('owner')).closed!.byName).toBe(cashierName);
    // The owner can still count it again and replace it.
    ok(await close(a.total, {}, 'owner'));
  });

  it('only the owner can change who closes', async () => {
    expect((await send('cashier', 'settings/update', { dayCloseBy: 'cashier_and_owner' })).ok).toBe(false);
    expect((await send('owner', 'settings/update', { dayCloseBy: 'nobody' as never })).ok).toBe(false);
  });
});
