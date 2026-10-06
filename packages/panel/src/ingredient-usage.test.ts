import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  createPanel,
  seedDemo,
  DEMO_STAFF,
  type CakeSpecInput,
  type DispatchResult,
  type Panel,
  type PanelEvent,
  type Staff,
  type Store,
  type UsageFormData,
} from './index';
import { generateSuggestionLines, normaliseTag } from './circuits/recipes';
import type { Ingredient, RecipeRule } from './domain';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
let events: PanelEvent[];

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
const warningsOf = (r: DispatchResult) => (r.ok ? r.warnings.join(' | ') : '');

const SPEC: CakeSpecInput = { servings: 12, flavor: 'Chocolate', filling: 'Vanilla cream', layers: 2, dietary: ['Eggless'] };

const ids: Record<string, string> = {};
const rangeOf: Record<string, Record<string, string>> = {};

async function ingredient(name: string, unit: 'g' | 'ml' | 'pcs', openingStock: number, ranges: { label: string; min: number; max: number }[], extra: object = {}) {
  const r = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name, unit, openingStock, ranges, ...extra }));
  ids[name] = r.ingredientId;
  const ing = (await store.get<Ingredient>('ingredients', r.ingredientId))!;
  rangeOf[name] = Object.fromEntries(ing.ranges.map((x) => [x.label, x.id]));
}

/** The shop types these in grams, millilitres and pieces; the system stores kg, l and pcs. */
const TYPED_IN: Record<string, 'g' | 'ml' | 'pcs'> = { Flour: 'g', 'Egg replacer': 'g', Cocoa: 'g', Cream: 'g', Vanilla: 'ml', Eggs: 'pcs', 'Gold leaf': 'pcs' };
const amount = (name: string, qty: number) => ({ ingredientId: ids[name]!, qty, unit: TYPED_IN[name]! });

async function rule(name: string, quantity: number, scaling: 'per_serving' | 'per_layer_gap' | 'fixed', extra: object = {}) {
  ok(await send('baker', 'recipes/save_rule', { ingredientId: ids[name]!, quantity, unit: TYPED_IN[name], scaling, ...extra }));
}

async function setup() {
  await ingredient('Flour', 'g', 5000, [
    { label: 'Light', min: 100, max: 200 },
    { label: 'Medium', min: 200, max: 300 },
    { label: 'Heavy', min: 300, max: 500 },
  ], { reorderLevel: 1000 });
  await ingredient('Eggs', 'pcs', 30, [
    { label: 'Few', min: 1, max: 3 },
    { label: 'Some', min: 4, max: 6 },
  ]);
  await ingredient('Egg replacer', 'g', 500, [
    { label: 'Small', min: 20, max: 50 },
    { label: 'Large', min: 51, max: 100 },
  ]);
  await ingredient('Cocoa', 'g', 800, [{ label: 'Some', min: 20, max: 50 }]);
  await ingredient('Cream', 'g', 400, [
    { label: 'Thin', min: 50, max: 100 },
    { label: 'Thick', min: 101, max: 200 },
  ]);
  await ingredient('Vanilla', 'ml', 100, [{ label: 'Splash', min: 3, max: 8 }]);
  await ingredient('Gold leaf', 'pcs', 10, [{ label: 'One sheet', min: 1, max: 1 }]);

  await rule('Flour', 20, 'per_serving');
  await rule('Eggs', 0.25, 'per_serving', { excludedByDietary: ['eggless'] });
  await rule('Egg replacer', 5, 'per_serving', { needsDietary: ['Eggless'] });
  await rule('Cocoa', 3, 'per_serving', { flavors: ['chocolate'] });
  await rule('Cream', 10, 'per_layer_gap', { fillings: ['vanilla cream'] });
  await rule('Vanilla', 5, 'fixed');
}

async function cakeInProduction(spec: CakeSpecInput = SPEC) {
  const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: 'Zawadi', deliveryDate: '2026-10-05' }));
  const { lineId } = ok<{ lineId: string }>(await send('cashier', 'orders/add_custom_line', { orderId, spec }));
  const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
  ok(await send('owner', 'quotes/provide', { quoteId, price: 100 }));
  const start = await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' });
  ok(start);
  return { orderId, lineId, start };
}

async function form(role: Role, orderId: string, lineId: string) {
  const r = await panel.feed('usage_form', { orderId, lineId }, sid[role]);
  if (!r.ok) throw new Error(`form failed: ${r.error.messages.join(' ')}`);
  return r.data as UsageFormData;
}
const ingredientRows = async (role: Role = 'inventory') => {
  const r = await panel.feed('ingredient_list', {}, sid[role]);
  if (!r.ok) throw new Error('list failed');
  return r.data;
};
const row = async (name: string) => (await ingredientRows()).find((x) => x.name === name)!;

beforeEach(async () => {
  t = Date.UTC(2026, 8, 29, 8, 0, 0);
  events = [];
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  panel.onEvent((e) => events.push(e));
  await seedDemo(store, panel);
  await relog();
  await setup();
});

describe('the recipe generator', () => {
  const ing = (name: string, unit: Ingredient['unit'] = 'kg'): Ingredient => ({ id: name, name, unit, onHand: 0, allergens: [], ranges: [], active: true, createdAt: '' });
  const r = (o: Partial<RecipeRule> & { ingredientId: string; quantity: number; scaling: RecipeRule['scaling'] }): RecipeRule => ({
    id: Math.random().toString(),
    flavors: [],
    fillings: [],
    needsDietary: [],
    excludedByDietary: [],
    ...o,
  });
  const spec = { servings: 10, flavor: 'Vanilla', layers: 1, dietary: [] as string[], photoIds: [] as string[] };

  it('scales by servings, by layer gaps, or not at all, and adds lines for the same ingredient', () => {
    const rules = [
      r({ ingredientId: 'Flour', quantity: 20, scaling: 'per_serving' }),
      r({ ingredientId: 'Flour', quantity: 10, scaling: 'fixed' }),
      r({ ingredientId: 'Cream', quantity: 5, scaling: 'per_layer_gap' }),
    ];
    const ings = [ing('Flour'), ing('Cream')];
    expect(generateSuggestionLines(spec, rules, ings)).toEqual([{ ingredientId: 'Flour', name: 'Flour', unit: 'kg', qty: 210 }]); // one layer: no gap, so no cream
    expect(generateSuggestionLines({ ...spec, layers: 3 }, rules, ings).find((l) => l.name === 'Cream')!.qty).toBe(100); // 5 x 10 servings x 2 gaps
  });

  it('matches flavors, fillings and dietary tags ignoring case, hyphens and spaces', () => {
    expect(normaliseTag(' Gluten-Free ')).toBe(normaliseTag('gluten free'));
    const rules = [
      r({ ingredientId: 'Flour', quantity: 1, scaling: 'per_serving', excludedByDietary: ['gluten-free'] }),
      r({ ingredientId: 'Almond', quantity: 1, scaling: 'per_serving', needsDietary: ['Gluten Free'] }),
      r({ ingredientId: 'Cocoa', quantity: 1, scaling: 'per_serving', flavors: ['CHOCOLATE'] }),
    ];
    const ings = [ing('Flour'), ing('Almond'), ing('Cocoa')];
    const names = (s: typeof spec) => generateSuggestionLines(s, rules, ings).map((l) => l.name);
    expect(names(spec)).toEqual(['Flour']);
    expect(names({ ...spec, dietary: ['gluten-free'] })).toEqual(['Almond']);
    expect(names({ ...spec, flavor: 'chocolate' })).toEqual(['Cocoa', 'Flour']);
  });

  it('rounds whole items up and ignores ingredients that are switched off', () => {
    const eggs = ing('Eggs', 'pcs');
    const rules = [r({ ingredientId: 'Eggs', quantity: 0.25, scaling: 'per_serving' })];
    expect(generateSuggestionLines({ ...spec, servings: 9 }, rules, [eggs])[0]!.qty).toBe(3); // 2.25 -> 3
    expect(generateSuggestionLines(spec, rules, [{ ...eggs, active: false }])).toEqual([]);
  });
});

describe('the suggestion', () => {
  it('is made when baking starts, from the cake and the recipe lines', async () => {
    const { orderId, lineId, start } = await cakeInProduction();
    expect(events.some((e) => e.type === 'UsageSuggested')).toBe(true);
    expect(warningsOf(start)).toBe('Nothing has been paid on order ' + (await store.get<{ id: string; number: string }>('orders', orderId))!.number + ' yet.');
    const f = await form('baker', orderId, lineId);
    expect(f.suggested.map((s) => [s.name, s.suggestedQty])).toEqual([
      ['Cocoa', 0.036],
      ['Cream', 0.12],
      ['Egg replacer', 0.06],
      ['Flour', 0.24],
      ['Vanilla', 0.005],
    ]); // no eggs: the cake is eggless
    // The baker can tap the amount that fits.
    const flour = f.suggested.find((s) => s.name === 'Flour')!;
    expect(flour.suggestedRangeId).toBe(rangeOf.Flour!.Medium); // 240 g is inside 200 g to 300 g
    expect(flour.suggestedText).toBe('240 g');
    expect(f.suggested.find((s) => s.name === 'Cream')!.suggestedRangeId).toBe(rangeOf.Cream!.Thick);
    expect(f.extras.map((e) => e.name)).toEqual(['Eggs', 'Gold leaf']);
    expect(f.canReport).toBe(true);
  });

  it('is not made before baking, and does not change if the recipe changes later', async () => {
    const { orderId, lineId } = await cakeInProduction();
    const before = await form('baker', orderId, lineId);
    const ruleId = (await store.list<RecipeRule>('recipeRules')).find((x) => x.ingredientId === ids.Flour)!.id;
    ok(await send('baker', 'recipes/save_rule', { ruleId, ingredientId: ids.Flour!, quantity: 99, unit: 'g', scaling: 'per_serving' }));
    expect((await form('baker', orderId, lineId)).suggested).toEqual(before.suggested);
  });

  it('says so when no recipe line fits, and the baker can still report', async () => {
    for (const rl of await store.list<RecipeRule>('recipeRules')) ok(await send('baker', 'recipes/remove_rule', { ruleId: rl.id }));
    const { orderId, lineId, start } = await cakeInProduction();
    expect(warningsOf(start)).toMatch(/No ingredient suggestion/);
    const f = await form('baker', orderId, lineId);
    expect(f.suggested).toEqual([]);
    expect(f.extras.length).toBe(7);
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Light! }] }));
  });

  it('shows the readable recipe lines to staff', async () => {
    const r = await panel.feed('recipe_rules', {}, sid.baker);
    if (!r.ok) throw new Error('rules');
    const eggs = r.data.find((x) => x.ingredientName === 'Eggs')!;
    expect(eggs.summary).toBe('0.25 pcs of Eggs per serving, for any cake but not eggless');
    expect(r.data.find((x) => x.ingredientName === 'Cream')!.summary).toBe('10 g of Cream per serving for each gap between layers, for any cake with vanilla cream filling');
  });
});

describe('report, confirm, then stock moves (BR-12, BR-13)', () => {
  async function reportAll(orderId: string, lineId: string) {
    const f = await form('baker', orderId, lineId);
    const items = f.suggested.map((s) => ({ ingredientId: s.ingredientId, rangeId: s.suggestedRangeId! }));
    items.push({ ingredientId: ids['Gold leaf']!, rangeId: rangeOf['Gold leaf']!['One sheet']! }); // an extra
    return ok<{ reportId: string }>(await send('baker', 'usage/report', { orderId, lineId, items, note: 'Used a bit more cream' }));
  }

  it('does not touch stock when the baker reports; it shows as pending', async () => {
    const { orderId, lineId } = await cakeInProduction();
    await reportAll(orderId, lineId);
    const flour = await row('Flour');
    expect(flour.onHand).toBe(5);
    expect(flour.pending).toEqual({ min: 0.2, max: 0.3, text: '200 g to 300 g', reports: 1 });
    expect(await store.list('ingredientMovements')).toHaveLength(7); // only the opening stock
    expect((await form('baker', orderId, lineId)).canReport).toBe(false);
    const q = await panel.feed('bake_queue', {}, sid.baker);
    expect(q.ok && q.data.rows[0]!.usage).toEqual({ state: 'reported', canReport: false });
  });

  it('lets Inventory see the report with the suggestion beside it, and the baker not confirm it', async () => {
    const { orderId, lineId } = await cakeInProduction();
    const { reportId } = await reportAll(orderId, lineId);
    const inbox = await panel.feed('usage_inbox', {}, sid.inventory);
    if (!inbox.ok) throw new Error('inbox');
    expect(inbox.data.pending).toHaveLength(1);
    const rep = inbox.data.pending[0]!;
    expect(rep).toMatchObject({ reportId, reportedByName: 'Neema (Baker)', note: 'Used a bit more cream', cake: { flavor: 'Chocolate' } });
    expect(rep.items.find((i) => i.name === 'Gold leaf')).toMatchObject({ extra: true, suggestedQty: null, rangeLabel: 'One sheet' });
    expect(rep.items.find((i) => i.name === 'Flour')).toMatchObject({ extra: false, suggestedQty: 0.24, suggestedText: '240 g', rangeLabel: 'Medium', rangeText: '200 g to 300 g', onHand: 5, onHandText: '5 kg' });
    const items = rep.items.map((i) => ({ ingredientId: i.ingredientId, qty: i.min }));
    expect(errOf(await send('baker', 'usage/confirm', { reportId, items }))).toMatch(/^forbidden/);
    expect((await panel.feed('usage_inbox', {}, sid.baker)).ok).toBe(false);
  });

  it('takes the exact amounts off stock only when Inventory confirms', async () => {
    const { orderId, lineId } = await cakeInProduction();
    const { reportId } = await reportAll(orderId, lineId);
    const rep = ((await panel.feed('usage_inbox', {}, sid.inventory)) as { ok: true; data: { pending: Array<{ items: Array<{ ingredientId: string; name: string }> }> } }).data.pending[0]!;
    const exact: Record<string, number> = { Flour: 250, Cocoa: 38, Cream: 130, 'Egg replacer': 60, Vanilla: 5, 'Gold leaf': 1 };
    const items = rep.items.map((i) => amount(i.name, exact[i.name]!));

    // Missing an ingredient is refused.
    expect(errOf(await send('inventory', 'usage/confirm', { reportId, items: items.slice(1) }))).toMatch(/every ingredient/);
    expect(await row('Flour').then((x) => x.onHand)).toBe(5);

    const done = await send('inventory', 'usage/confirm', { reportId, items });
    expect(warningsOf(done)).toBe(''); // every exact amount sits inside the range the baker tapped
    expect((await row('Flour')).onHand).toBe(4.75);
    expect((await row('Cocoa')).onHand).toBe(0.762);
    expect((await row('Gold leaf')).onHand).toBe(9);
    expect((await row('Flour')).pending).toBeNull();
    const moves = (await store.list<{ id: string; reason: string; ingredientId: string; qty: number; reportId?: string }>('ingredientMovements')).filter((m) => m.reason === 'usage');
    expect(moves).toHaveLength(6);
    expect(moves.find((m) => m.ingredientId === ids.Flour)).toMatchObject({ qty: -0.25, reportId });
    const after = await panel.feed('usage_inbox', {}, sid.owner);
    expect(after.ok && after.data.pending).toHaveLength(0);
    expect(after.ok && after.data.recent[0]).toMatchObject({ status: 'confirmed', confirmedByName: 'Juma (Inventory)' });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['UsageReported', 'UsageConfirmed', 'StockMoved']));

    // Confirming twice never takes stock twice.
    expect(errOf(await send('inventory', 'usage/confirm', { reportId, items }))).toMatch(/already been dealt with/);
    expect((await row('Flour')).onHand).toBe(4.75);
    // A further report for the same cake is allowed once the first is confirmed.
    expect((await form('baker', orderId, lineId)).canReport).toBe(true);
  });

  it('warns when the exact amount is outside what the baker tapped, and flags a low stock level', async () => {
    const { orderId, lineId } = await cakeInProduction();
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Light! }] }));
    const rid = (await store.list<{ id: string }>('usageReports'))[0]!.id;
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 1100, unit: 'g' }));
    events.length = 0;
    const r = await send('inventory', 'usage/confirm', { reportId: rid, items: [amount('Flour', 250)] });
    expect(warningsOf(r)).toMatch(/Flour: 250 g is outside the "Light" amount the baker chose \(100 g to 200 g\)/);
    expect((await row('Flour')).low).toBe(true); // 850 <= 1000
    expect(events.map((e) => e.type)).toContain('ReorderLevelBreached');
  });

  it('never goes below zero: it takes what there is and records the shortfall', async () => {
    const { orderId, lineId } = await cakeInProduction();
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Vanilla!, rangeId: rangeOf.Vanilla!.Splash! }] }));
    const rid = (await store.list<{ id: string }>('usageReports'))[0]!.id;
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Vanilla!, counted: 2, unit: 'ml' }));
    const r = await send('inventory', 'usage/confirm', { reportId: rid, items: [amount('Vanilla', 5)] });
    expect(warningsOf(r)).toMatch(/only 2 ml was on hand, so the count is 3 ml short/);
    expect((await row('Vanilla')).onHand).toBe(0);
    const m = (await store.list<{ id: string; reason: string; qty: number; shortfall?: number }>('ingredientMovements')).find((x) => x.reason === 'usage')!;
    expect(m).toMatchObject({ qty: -0.002, shortfall: 0.003 });
  });

  it('can be sent back with a reason, then reported again', async () => {
    const { orderId, lineId } = await cakeInProduction();
    const { reportId } = await reportAll(orderId, lineId);
    expect(errOf(await send('inventory', 'usage/send_back', { reportId, reason: ' ' }))).toMatch(/Say what needs fixing/);
    expect(errOf(await send('baker', 'usage/send_back', { reportId, reason: 'x' }))).toMatch(/^forbidden/);
    ok(await send('inventory', 'usage/send_back', { reportId, reason: 'Flour looks too low' }));
    expect((await row('Flour')).pending).toBeNull();
    const f = await form('baker', orderId, lineId);
    expect(f.report).toMatchObject({ status: 'sent_back', sentBackReason: 'Flour looks too low' });
    expect(f.canReport).toBe(true);
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Heavy! }] }));
    expect(errOf(await send('inventory', 'usage/send_back', { reportId, reason: 'again' }))).toMatch(/already been dealt with/);
  });

  it('rejects bad reports in plain words', async () => {
    const { orderId, lineId } = await cakeInProduction();
    const flour = ids.Flour!;
    expect(errOf(await send('baker', 'usage/report', { orderId, lineId, items: [] }))).toMatch(/Tick at least one/);
    expect(errOf(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: flour, rangeId: rangeOf.Eggs!.Few! }] }))).toMatch(/Choose an amount for Flour/);
    expect(errOf(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: flour, rangeId: rangeOf.Flour!.Light! }, { ingredientId: flour, rangeId: rangeOf.Flour!.Heavy! }] }))).toMatch(/listed twice/);
    ok(await send('inventory', 'inventory/update_ingredient', { ingredientId: ids.Cocoa!, active: false }));
    expect(errOf(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Cocoa!, rangeId: rangeOf.Cocoa!.Some! }] }))).toMatch(/switched off/);
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: flour, rangeId: rangeOf.Flour!.Light! }] }));
    expect(errOf(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: flour, rangeId: rangeOf.Flour!.Light! }] }))).toMatch(/already waiting/);
    expect(errOf(await send('cashier', 'usage/report', { orderId, lineId, items: [] }))).toMatch(/^forbidden/);
  });

  it('will not take a report for a cake that has not been started', async () => {
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', deliveryDate: '2026-10-05' }));
    const { lineId } = ok<{ lineId: string }>(await send('cashier', 'orders/add_custom_line', { orderId, spec: SPEC }));
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    ok(await send('owner', 'quotes/provide', { quoteId, price: 50 }));
    expect(errOf(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Light! }] }))).toMatch(/Start baking/);
    const f = await form('baker', orderId, lineId);
    expect(f).toMatchObject({ canReport: false, blockedReason: 'Start baking this cake first.' });
    const q = await panel.feed('bake_queue', {}, sid.baker);
    expect(q.ok && q.data.rows[0]!.usage).toEqual({ state: 'not_started', canReport: false });
  });
});

describe('managing ingredients', () => {
  it('keeps stock changes in the right hands and records every one', async () => {
    expect(errOf(await send('baker', 'inventory/receive', { ingredientId: ids.Flour!, qty: 10 }))).toMatch(/^forbidden/);
    expect(errOf(await send('cashier', 'inventory/count', { ingredientId: ids.Flour!, counted: 10 }))).toMatch(/^forbidden/);
    ok(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 1000, unit: 'g', note: 'Delivery from the mill' }));
    expect((await row('Flour')).onHand).toBe(6);
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Flour!, counted: 5900, unit: 'g', note: 'Spilled a bag' }));
    expect((await row('Flour')).onHand).toBe(5.9);
    expect(errOf(await send('inventory', 'inventory/write_off', { ingredientId: ids.Flour!, qty: 50 }))).toMatch(/Say what happened/);
    expect(errOf(await send('inventory', 'inventory/write_off', { ingredientId: ids.Flour!, qty: 99999, unit: 'g', note: 'x' }))).toMatch(/Only 5.9 kg is on hand/);
    ok(await send('inventory', 'inventory/write_off', { ingredientId: ids.Flour!, qty: 100, unit: 'g', note: 'Weevils' }));
    const kinds = (await store.list<{ id: string; ingredientId: string; reason: string; qty: number }>('ingredientMovements')).filter((m) => m.ingredientId === ids.Flour);
    expect(kinds.map((m) => [m.reason, m.qty]).sort()).toEqual([['correction', -0.1], ['delivery', 1], ['opening', 5], ['waste', -0.1]].sort());
    const audit = await panel.feed('audit_view', {}, sid.owner);
    expect(audit.ok && audit.data.some((a) => a.summary.includes('Weevils'))).toBe(true);
  });

  it('refuses duplicate names and nonsense amounts, and keeps an amount’s identity when it is renamed', async () => {
    expect(errOf(await send('inventory', 'inventory/create_ingredient', { name: ' flour ', unit: 'g' }))).toMatch(/already an ingredient/);
    expect(errOf(await send('inventory', 'inventory/create_ingredient', { name: 'Salt', unit: 'g', ranges: [{ label: 'Pinch', min: 5, max: 1 }] }))).toMatch(/top must not be below/);
    expect(errOf(await send('inventory', 'inventory/create_ingredient', { name: 'Salt', unit: 'g', ranges: [{ label: 'A', min: 1, max: 2 }, { label: 'a', min: 3, max: 4 }] }))).toMatch(/same name/);
    expect(errOf(await send('inventory', 'inventory/create_ingredient', { name: 'Salt', unit: 'g', openingStock: -4 }))).toMatch(/invalid/);
    const keep = rangeOf.Flour!.Medium!;
    ok(await send('inventory', 'inventory/update_ingredient', { ingredientId: ids.Flour!, unit: 'g', ranges: [{ id: keep, label: 'Middle', min: 200, max: 320 }, { label: 'Tiny', min: 1, max: 5 }] }));
    const after = (await row('Flour')).ranges;
    expect(after.find((r) => r.rangeId === keep)).toMatchObject({ label: 'Middle', max: 0.32, text: '200 g to 320 g' });
    expect(after).toHaveLength(2);
    ok(await send('inventory', 'inventory/update_ingredient', { ingredientId: ids.Flour!, reorderLevel: null }));
    expect((await row('Flour')).reorderLevel).toBeNull();
  });

  it('hides switched-off ingredients from lists and suggestions, but keeps them', async () => {
    ok(await send('inventory', 'inventory/update_ingredient', { ingredientId: ids.Cocoa!, active: false }));
    expect((await ingredientRows()).some((x) => x.name === 'Cocoa')).toBe(false);
    const all = await panel.feed('ingredient_list', { includeInactive: true }, sid.owner);
    expect(all.ok && all.data.find((x) => x.name === 'Cocoa')!.active).toBe(false);
    const { orderId, lineId } = await cakeInProduction();
    expect((await form('baker', orderId, lineId)).suggested.some((s) => s.name === 'Cocoa')).toBe(false);
    expect(errOf(await send('baker', 'recipes/save_rule', { ingredientId: ids.Cocoa!, quantity: 1, scaling: 'fixed' }))).toMatch(/switched off/);
  });

  it('only owner and baker edit recipe lines, and never with a zero amount', async () => {
    expect(errOf(await send('inventory', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 1, scaling: 'fixed' }))).toMatch(/^forbidden/);
    expect(errOf(await send('cashier', 'recipes/remove_rule', { ruleId: 'x' }))).toMatch(/^forbidden/);
    expect(errOf(await send('baker', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 0, scaling: 'fixed' }))).toMatch(/greater than zero/);
    expect(errOf(await send('baker', 'recipes/remove_rule', { ruleId: 'nope' }))).toMatch(/no longer exists/);
  });

  it('shows each role the screens it needs', async () => {
    const nav = async (role: Role) => {
      const r = await panel.feed('navigation', {}, sid[role]);
      return r.ok ? r.data.map((n) => n.id) : [];
    };
    expect(await nav('baker')).toEqual(['bake_queue', 'alerts', 'requests', 'recipes', 'ingredients', 'forecast', 'catalogue']);
    expect(await nav('inventory')).toEqual(['usage_inbox', 'alerts', 'requests', 'ingredients', 'forecast', 'catalogue']);
    expect(await nav('owner')).toEqual(expect.arrayContaining(['usage_inbox', 'ingredients', 'recipes']));
  });
});

describe('metric base units and conversions (D-62)', () => {
  it('stores weight in kg, liquid in l and counted things in pcs, whatever unit was typed', async () => {
    ok(await send('inventory', 'inventory/create_ingredient', { name: 'Butter', unit: 'lb', openingStock: 10, reorderLevel: 2, ranges: [{ label: 'A block', min: 1, max: 1 }] }));
    ok(await send('inventory', 'inventory/create_ingredient', { name: 'Milk', unit: 'cup', openingStock: 8 }));
    ok(await send('inventory', 'inventory/create_ingredient', { name: 'Sprinkles', unit: 'dozen', openingStock: 2 }));
    const butter = await row('Butter');
    expect(butter).toMatchObject({ unit: 'kg', onHand: 4.535924, onHandText: '4.536 kg', reorderLevel: 0.907185 });
    expect(butter.ranges[0]).toMatchObject({ min: 0.453592, max: 0.453592, text: '453.6 g' });
    expect(await row('Milk')).toMatchObject({ unit: 'l', onHand: 2, onHandText: '2 l' });
    expect(await row('Sprinkles')).toMatchObject({ unit: 'pcs', onHand: 24, onHandText: '24 pcs' });
    const moves = (await store.list<{ id: string; ingredientId: string; reason: string; qty: number }>('ingredientMovements')).filter((m) => m.ingredientId === butter.ingredientId);
    expect(moves).toEqual([expect.objectContaining({ reason: 'opening', qty: 4.535924 })]);
  });

  it('takes a delivery, a count and a write-off in any unit of the right kind', async () => {
    ok(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 2, unit: 'lb' }));
    expect((await row('Flour')).onHand).toBe(5.907185);
    ok(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 0.5 })); // no unit: kg
    expect((await row('Flour')).onHand).toBe(6.407185);
    ok(await send('inventory', 'inventory/count', { ingredientId: ids.Vanilla!, counted: 3, unit: 'tbsp' }));
    expect(await row('Vanilla')).toMatchObject({ onHand: 0.045, onHandText: '45 ml' });
    ok(await send('inventory', 'inventory/write_off', { ingredientId: ids.Eggs!, qty: 1, unit: 'dozen', note: 'Dropped a tray' }));
    expect((await row('Eggs')).onHand).toBe(18);
  });

  it('refuses a unit that does not fit the ingredient, in plain words, and changes nothing', async () => {
    const before = (await row('Flour')).onHand;
    expect(errOf(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 1, unit: 'l' }))).toMatch(/Flour is weighed.*"l" does not fit/);
    expect(errOf(await send('inventory', 'inventory/count', { ingredientId: ids.Eggs!, counted: 1, unit: 'kg' }))).toMatch(/Eggs is counted/);
    expect(errOf(await send('inventory', 'inventory/write_off', { ingredientId: ids.Vanilla!, qty: 1, unit: 'g', note: 'x' }))).toMatch(/Vanilla is measured by volume/);
    expect(errOf(await send('baker', 'recipes/save_rule', { ingredientId: ids.Flour!, quantity: 1, unit: 'ml', scaling: 'fixed' }))).toMatch(/does not fit/);
    expect(errOf(await send('inventory', 'inventory/update_ingredient', { ingredientId: ids.Flour!, reorderLevel: 1, unit: 'pcs' }))).toMatch(/does not fit/);
    expect(errOf(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 1, unit: 'cubit' as never }))).toMatch(/invalid/);
    expect((await row('Flour')).onHand).toBe(before);
  });

  it('refuses an amount too small to count instead of recording a zero delivery', async () => {
    expect(errOf(await send('inventory', 'inventory/receive', { ingredientId: ids.Flour!, qty: 0.0000001, unit: 'g' }))).toMatch(/too small/);
  });

  it('takes the confirmed usage in any unit and compares it with the range in the same units', async () => {
    const { orderId, lineId } = await cakeInProduction();
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Light! }] }));
    const rid = (await store.list<{ id: string }>('usageReports'))[0]!.id;
    expect(errOf(await send('inventory', 'usage/confirm', { reportId: rid, items: [{ ingredientId: ids.Flour!, qty: 1, unit: 'l' }] }))).toMatch(/does not fit/);
    const done = await send('inventory', 'usage/confirm', { reportId: rid, items: [{ ingredientId: ids.Flour!, qty: 0.4, unit: 'lb' }] }); // 181 g: inside 100 g to 200 g
    expect(warningsOf(done)).toBe('');
    expect((await row('Flour')).onHand).toBe(4.818563);
  });

  it('keeps recipe lines in the base unit and reads them back in plain units', async () => {
    ok(await send('baker', 'recipes/save_rule', { ingredientId: ids.Vanilla!, quantity: 1, unit: 'tsp', scaling: 'fixed', note: 'extra' }));
    const r = await panel.feed('recipe_rules', {}, sid.baker);
    if (!r.ok) throw new Error('rules');
    const line = r.data.find((x) => x.note === 'extra')!;
    expect(line).toMatchObject({ unit: 'l', quantity: 0.005, quantityText: '5 ml' });
    expect(line.summary).toBe('5 ml of Vanilla for every cake, for any cake');
  });

  it('shows the conversion table to the staff who need it, and no one else', async () => {
    const r = await panel.feed('unit_list', {}, sid.baker);
    if (!r.ok) throw new Error('units');
    expect(r.data.baseUnits.map((b) => b.code)).toEqual(['kg', 'l', 'pcs']);
    expect(r.data.units.find((u) => u.code === 'lb')).toMatchObject({ dimension: 'mass', base: 'kg', perUnit: 0.45359237 });
    expect((await panel.feed('unit_list', {}, sid.cashier)).ok).toBe(false);
  });
});

describe('days of stock left (BR-14)', () => {
  it('says there is not enough data at first, then works it out from confirmed use only', async () => {
    const { orderId, lineId } = await cakeInProduction();
    expect((await row('Flour')).daysLeftLabel).toBe('Not enough data yet');

    const useFlour = async (qty: number) => {
      ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Light! }] }));
      const rid = (await store.list<{ id: string; status: string }>('usageReports')).find((r) => r.status === 'reported')!.id;
      ok(await send('inventory', 'usage/confirm', { reportId: rid, items: [amount('Flour', qty)] }));
    };
    await useFlour(100);
    t += 2 * 86_400_000;
    await relog();
    await useFlour(100);
    expect((await row('Flour')).daysLeftLabel).toBe('Not enough data yet'); // two records, two days
    t += 2 * 86_400_000;
    await relog();
    // A report that is only waiting must not count.
    ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Flour!, rangeId: rangeOf.Flour!.Heavy! }] }));
    expect((await row('Flour')).daysLeftLabel).toBe('Not enough data yet');
    const rid = (await store.list<{ id: string; status: string }>('usageReports')).find((r) => r.status === 'reported')!.id;
    ok(await send('inventory', 'usage/confirm', { reportId: rid, items: [amount('Flour', 100)] }));

    // 300 g over a 4-day history = 75 g a day; 4700 g left is 62 days.
    const flour = await row('Flour');
    expect(flour.onHand).toBe(4.7);
    expect(flour.daysLeft).toBe(62.7);
    expect(flour.daysLeftLabel).toBe('About 62 days');
    expect((await row('Cocoa')).daysLeftLabel).toBe('Not enough data yet');
  });

  it('reports no recent use when nothing has been used lately', async () => {
    const { orderId, lineId } = await cakeInProduction();
    for (let i = 0; i < 3; i++) {
      ok(await send('baker', 'usage/report', { orderId, lineId, items: [{ ingredientId: ids.Vanilla!, rangeId: rangeOf.Vanilla!.Splash! }] }));
      const rid = (await store.list<{ id: string; status: string }>('usageReports')).find((r) => r.status === 'reported')!.id;
      ok(await send('inventory', 'usage/confirm', { reportId: rid, items: [amount('Vanilla', 1)] }));
      t += 86_400_000;
      await relog();
    }
    t += 30 * 86_400_000;
    await relog();
    expect((await row('Vanilla')).daysLeftLabel).toBe('No recent use');
  });
});
