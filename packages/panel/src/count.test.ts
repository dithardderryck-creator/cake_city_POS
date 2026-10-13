import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry, CountSession, Ingredient, IngredientMovement, StaffRequest } from './domain';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type AlertInboxData, type CountSessionData, type DispatchResult, type IngredientRow, type Panel, type RequestInboxData, type Staff, type Store } from './index';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;

type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
const ROLES: Role[] = ['owner', 'cashier', 'baker', 'inventory', 'it'];
const sid: Record<string, string> = {};
const uid: Record<string, string> = {};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const data = async <T>(r: ReturnType<Panel['feed']>) => {
  const x = await r;
  if (!x.ok) throw new Error(x.error.messages.join(' '));
  return x.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const feed = async (role: Role = 'inventory') => {
  const r = await panel.feed('count_session', {}, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as CountSessionData;
};
const ing: Record<string, string> = {};
const make = async (name: string, unit: 'kg' | 'pcs' | 'l', openingStock: number, extra: Record<string, unknown> = {}) => {
  ing[name] = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name, unit, openingStock, ...extra })).ingredientId;
};
const onHand = async (name: string) => (await store.get<Ingredient>('ingredients', ing[name]))!.onHand;
const start = async (role: Role = 'inventory') => ok<{ sessionId: string; resumed: boolean }>(await send(role, 'count/start', {}));
const record = (sessionId: string, name: string, counted: number | null, unit?: string, role: Role = 'inventory') =>
  send(role, 'count/record', { sessionId, ingredientId: ing[name], counted, ...(unit ? { unit } : {}) } as never);

beforeEach(async () => {
  t = new Date(2026, 9, 7, 8, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  for (const role of ROLES) {
    const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
    const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
    uid[role] = staff.id;
    sid[role] = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: staff.id, pin })).sessionId;
  }
  await make('Flour', 'kg', 14);
  await make('Sugar', 'kg', 9);
  await make('Eggs', 'pcs', 50);
  await make('Cake boxes', 'pcs', 40, { kind: 'packaging' });
});

describe('packaging', () => {
  it('is a kind of stock item with no baker usage amounts, and shows in the stock list', async () => {
    const r = await panel.feed('ingredient_list', {}, sid.inventory);
    const rows = (r.ok ? r.data : []) as IngredientRow[];
    expect(rows.find((x) => x.name === 'Cake boxes')!.kind).toBe('packaging');
    expect(rows.find((x) => x.name === 'Flour')!.kind).toBe('ingredient');
    expect(errOf(await send('inventory', 'inventory/create_ingredient', { name: 'Ribbon', unit: 'pcs', kind: 'packaging', ranges: [{ label: 'Some', min: 1, max: 2 }] }))).toMatch(/no usage amounts/);
  });

  it('cannot be turned into packaging while a recipe uses it, or while it has usage amounts', async () => {
    ok(await send('owner', 'recipes/save_rule', { ingredientId: ing.Flour, quantity: 0.2, scaling: 'fixed', flavors: [], fillings: [], needsDietary: [], excludedByDietary: [] } as never));
    expect(errOf(await send('inventory', 'inventory/update_ingredient', { ingredientId: ing.Flour, kind: 'packaging' }))).toMatch(/recipe rule/);
    await make('Cocoa', 'kg', 2, { ranges: [{ label: 'Light', min: 0.1, max: 0.2 }] });
    expect(errOf(await send('inventory', 'inventory/update_ingredient', { ingredientId: ing.Cocoa, kind: 'packaging' }))).toMatch(/Remove its usage amounts/);
    ok(await send('inventory', 'inventory/update_ingredient', { ingredientId: ing.Sugar, kind: 'packaging' }));
    expect((await store.get<Ingredient>('ingredients', ing.Sugar))!.kind).toBe('packaging');
  });
});

describe('the daily count', () => {
  it('only the owner and inventory can count', async () => {
    for (const r of ['cashier', 'baker', 'it'] as const) {
      expect((await send(r, 'count/start', {})).ok).toBe(false);
      expect((await panel.feed('count_session', {}, sid[r])).ok).toBe(false);
    }
  });

  it('starts with nothing in progress and "not counted today"', async () => {
    expect(await feed()).toMatchObject({ countedToday: null, session: null, history: [], bigDifferencePercent: 10, can: { start: true } });
  });

  it('lists ingredients first then packaging, each by name, with a sensible step', async () => {
    await start();
    const items = (await feed()).session!.items;
    expect(items.map((i) => i.name)).toEqual(['Eggs', 'Flour', 'Sugar', 'Cake boxes']);
    expect(items.find((i) => i.name === 'Eggs')).toMatchObject({ step: 1, expected: 50, expectedText: '50 pcs', kind: 'ingredient' });
    expect(items.find((i) => i.name === 'Flour')!.step).toBe(0.5);
    expect(items.find((i) => i.name === 'Cake boxes')!.kind).toBe('packaging');
    await make('Saffron', 'kg', 0.5);
    expect((await feed()).session!.items.find((i) => i.name === 'Saffron')!.step).toBe(0.05);
  });

  it('keeps counts on the server without changing stock, and picking it up again finds them', async () => {
    const { sessionId, resumed } = await start();
    expect(resumed).toBe(false);
    ok(await record(sessionId, 'Flour', 13));
    expect(await onHand('Flour')).toBe(14);
    // another person (the owner) picks up the same count
    const again = await start('owner');
    expect(again).toEqual({ sessionId, resumed: true });
    const s = (await feed('owner')).session!;
    expect(s).toMatchObject({ total: 4, done: 1, skipped: 3, differences: 1, big: 0, startedByName: expect.stringContaining('Juma') });
    expect(s.items.find((i) => i.name === 'Flour')).toMatchObject({ counted: 13, countedText: '13 kg', difference: -1, differenceText: '−1 kg', big: false });
    expect(s.items.find((i) => i.name === 'Sugar')).toMatchObject({ counted: null, difference: null, differenceText: null });
  });

  it('accepts a count in grams and converts it, and refuses a unit that does not fit', async () => {
    const { sessionId } = await start();
    ok(await record(sessionId, 'Flour', 13500, 'g'));
    expect((await feed()).session!.items.find((i) => i.name === 'Flour')!.counted).toBe(13.5);
    expect(errOf(await record(sessionId, 'Flour', 3, 'l'))).toBeTruthy();
    expect(errOf(await record(sessionId, 'Flour', -1))).toMatch(/at least 0|negative/);
  });

  it('skipping clears a count already written', async () => {
    const { sessionId } = await start();
    ok(await record(sessionId, 'Flour', 12));
    ok(await record(sessionId, 'Flour', null));
    expect((await feed()).session).toMatchObject({ done: 0, skipped: 4 });
  });

  it('flags a difference of 10% or more as big, and a smaller one as not', async () => {
    const { sessionId } = await start();
    ok(await record(sessionId, 'Flour', 12.6)); // 10% of 14 exactly: big
    ok(await record(sessionId, 'Sugar', 8.2)); // 8.9%: not big
    ok(await record(sessionId, 'Eggs', 50)); // matches
    ok(await record(sessionId, 'Cake boxes', 36)); // 4 of 40: exactly 10%
    const items = (await feed()).session!.items;
    expect(items.find((i) => i.name === 'Flour')!.big).toBe(true);
    expect(items.find((i) => i.name === 'Sugar')!.big).toBe(false);
    expect(items.find((i) => i.name === 'Eggs')).toMatchObject({ big: false, differenceText: 'matches' });
    expect(items.find((i) => i.name === 'Cake boxes')!.big).toBe(true);
    expect((await feed()).session).toMatchObject({ done: 4, differences: 3, big: 2 });
  });

  it('refuses to submit with nothing counted, and refuses a count that is no longer open', async () => {
    const { sessionId } = await start();
    expect(errOf(await send('inventory', 'count/submit', { sessionId }))).toMatch(/at least one/);
    ok(await send('inventory', 'count/discard', { sessionId }));
    expect(errOf(await record(sessionId, 'Flour', 1))).toMatch(/no longer open/);
    expect(errOf(await send('inventory', 'count/submit', { sessionId }))).toMatch(/no longer open/);
    expect(errOf(await send('inventory', 'count/discard', { sessionId }))).toMatch(/no longer open/);
  });

  it('applies only what was counted, leaves skipped items alone, and writes a correction for each', async () => {
    const { sessionId } = await start();
    ok(await record(sessionId, 'Flour', 13));
    ok(await record(sessionId, 'Eggs', 50));
    t += 60_000;
    const r = ok<{ counted: number; differences: number; big: number; ownerNotified: boolean }>(await send('inventory', 'count/submit', { sessionId }));
    expect(r).toMatchObject({ counted: 2, differences: 1, big: 0, ownerNotified: false });
    expect(await onHand('Flour')).toBe(13);
    expect(await onHand('Sugar')).toBe(9);
    const moves = (await store.list<IngredientMovement>('ingredientMovements')).filter((m) => m.reason === 'correction');
    expect(moves).toEqual([expect.objectContaining({ ingredientId: ing.Flour, qty: -1, note: 'Daily count' })]);
    expect((await store.get<Ingredient>('ingredients', ing.Flour))!.countedAt).toBeTruthy();
    expect((await store.get<Ingredient>('ingredients', ing.Sugar))!.countedAt).toBeUndefined();
  });

  it('records the result, shows it in the history, and says counted today', async () => {
    const { sessionId } = await start();
    ok(await record(sessionId, 'Flour', 10));
    ok(await record(sessionId, 'Sugar', 9));
    t += 15 * 60_000;
    ok(await send('inventory', 'count/submit', { sessionId }));
    const f = await feed();
    expect(f.session).toBeNull();
    expect(f.countedToday).toBe('08:15');
    expect(f.history).toEqual([expect.objectContaining({ sessionId, items: 2, differences: 1, big: 1, byName: expect.stringContaining('Juma') })]);
    const stored = (await store.get<CountSession>('countSessions', sessionId))!;
    expect(stored.status).toBe('submitted');
    expect(stored.results!.find((r) => r.name === 'Flour')).toMatchObject({ expected: 14, counted: 10, difference: -4, big: true });
    // a new count can start afterwards and is fresh
    expect((await start()).resumed).toBe(false);
  });

  it('tells the owner about big differences with a request, but not when the owner counted, and not for small ones', async () => {
    const a = await start();
    ok(await record(a.sessionId, 'Flour', 10));
    ok(await record(a.sessionId, 'Sugar', 5));
    const r = ok<{ ownerNotified: boolean }>(await send('inventory', 'count/submit', { sessionId: a.sessionId }));
    expect(r.ownerNotified).toBe(true);
    const inbox = await data<RequestInboxData>(panel.feed('request_inbox', {}, sid.owner));
    const req = inbox.rows.find((x) => x.title === 'Count differences need a look')!;
    expect(req).toMatchObject({ category: 'Stock and supplies', needsYou: true, from: { role: 'inventory' }, to: { role: 'owner' }, urgent: false });
    expect(req.body).toContain('Flour (expected 14 kg, counted 10 kg)');
    expect(req.body).toContain('Sugar');
    const stored = (await store.list<StaffRequest>('staffRequests')).filter((x) => x.title === 'Count differences need a look');
    expect(stored).toHaveLength(1);

    // small difference only: no request
    const b = await start();
    ok(await record(b.sessionId, 'Flour', 9.5)); // 10 -> 9.5 is 5%
    expect(ok<{ ownerNotified: boolean }>(await send('inventory', 'count/submit', { sessionId: b.sessionId })).ownerNotified).toBe(false);
    // owner counts with a big difference: no request to themselves
    const c = await start('owner');
    ok(await record(c.sessionId, 'Eggs', 10, undefined, 'owner'));
    expect(ok<{ ownerNotified: boolean }>(await send('owner', 'count/submit', { sessionId: c.sessionId })).ownerNotified).toBe(false);
    expect((await store.list<StaffRequest>('staffRequests')).filter((x) => x.title === 'Count differences need a look')).toHaveLength(1);
  });

  it('a count that drops an item to its reorder level raises the low-stock alert straight away', async () => {
    await make('Butter', 'kg', 6, { reorderLevel: 3 });
    const { sessionId } = await start();
    ok(await record(sessionId, 'Butter', 2.5));
    ok(await send('inventory', 'count/submit', { sessionId }));
    const a = await data<AlertInboxData>(panel.feed('alert_inbox', {}, sid.inventory));
    expect(a.open.some((x) => x.kind === 'low_stock' || x.kind === 'stockout')).toBe(true);
  });

  it('a single count also remembers when the item was counted', async () => {
    ok(await send('inventory', 'inventory/count', { ingredientId: ing.Flour, counted: 13 }));
    expect((await store.get<Ingredient>('ingredients', ing.Flour))!.countedAt).toBeTruthy();
    const rows = await data<IngredientRow[]>(panel.feed('ingredient_list', {}, sid.inventory));
    expect(rows.find((r) => r.name === 'Flour')!.countedAt).toBeTruthy();
    expect(rows.find((r) => r.name === 'Sugar')!.countedAt).toBeNull();
  });

  it('shows when each item was last counted, as a time today or a date', async () => {
    const a = await start();
    ok(await record(a.sessionId, 'Flour', 14));
    ok(await send('inventory', 'count/submit', { sessionId: a.sessionId }));
    expect((await store.get<Ingredient>('ingredients', ing.Flour))!.countedAt).toBeTruthy();
    expect((await feed()).countedToday).toBe('08:00');
    t += 24 * 3_600_000;
    for (const role of ROLES) sid[role] = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: uid[role], pin: DEMO_STAFF.find((x) => x.role === role)!.pin })).sessionId;
    await start();
    const items = (await feed()).session!.items;
    expect(items.find((i) => i.name === 'Flour')!.lastCountedText).toBe('2026-10-07');
    expect(items.find((i) => i.name === 'Sugar')!.lastCountedText).toBeNull();
  });

  it('keeps the last 10 counts in the history, newest first', async () => {
    for (let i = 0; i < 11; i++) {
      const a = await start();
      ok(await record(a.sessionId, 'Flour', 14));
      t += 60_000;
      ok(await send('inventory', 'count/submit', { sessionId: a.sessionId }));
    }
    const h = (await feed()).history;
    expect(h).toHaveLength(10);
    expect(h[0].at > h[9].at).toBe(true);
  });

  it('says "today" with the time when an item was counted earlier today', async () => {
    const a = await start();
    ok(await record(a.sessionId, 'Flour', 14));
    t += 5 * 60_000;
    ok(await send('inventory', 'count/submit', { sessionId: a.sessionId }));
    await start();
    expect((await feed()).session!.items.find((i) => i.name === 'Flour')!.lastCountedText).toBe('today 08:05');
  });

  it('leaves out items that are switched off and is audited', async () => {
    ok(await send('inventory', 'inventory/update_ingredient', { ingredientId: ing.Sugar, active: false }));
    const { sessionId } = await start();
    expect((await feed()).session!.items.map((i) => i.name)).not.toContain('Sugar');
    expect(errOf(await record(sessionId, 'Sugar', 3))).toMatch(/not in the count/);
    ok(await record(sessionId, 'Flour', 14));
    ok(await send('inventory', 'count/submit', { sessionId }));
    const audit = await store.list<AuditEntry>('audit');
    expect(audit.some((x) => x.intent === 'count/submit' && x.actorId === uid.inventory && x.outcome === 'ok')).toBe(true);
  });
});
