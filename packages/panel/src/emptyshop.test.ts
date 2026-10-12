import { describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type Ingredient, type Staff } from './index';

async function demoPanel() {
  const store = createMemoryStore();
  const panel = createPanel({ store });
  await seedDemo(store, panel);
  const staff = await store.list<Staff>('staff');
  const sign = async (role: string) => {
    const r = await panel.dispatch('auth/sign_in', { userId: staff.find((s) => s.role === role)!.id, pin: DEMO_STAFF.find((s) => s.role === role)!.pin });
    if (!r.ok) throw new Error('sign in failed');
    return (r.data as { sessionId: string }).sessionId;
  };
  return { store, panel, sign };
}

describe('a shop with nothing to count', () => {
  it('refuses to start a daily count and says why, instead of opening an empty one', async () => {
    const { store, panel, sign } = await demoPanel();
    const t = await sign('inventory');
    for (const i of await store.list<Ingredient>('ingredients')) await store.delete('ingredients', i.id);
    const r = await panel.dispatch('count/start', {}, t);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.messages.join(' ')).toMatch(/nothing to count yet/i);
    expect(await store.list('countSessions')).toHaveLength(0);
  });

  it('still starts and resumes a count when there are ingredients', async () => {
    const { panel, sign } = await demoPanel();
    const t = await sign('inventory');
    expect((await panel.dispatch('inventory/create_ingredient', { name: 'Flour', unit: 'kg', openingStock: 5 }, t)).ok).toBe(true);
    const a = await panel.dispatch('count/start', {}, t);
    expect(a.ok).toBe(true);
    const b = await panel.dispatch('count/start', {}, t);
    expect(b.ok && (b.data as { resumed: boolean }).resumed).toBe(true);
  });
});

describe('money labels', () => {
  it('never shows a minus sign for nothing', async () => {
    const { panel, sign } = await demoPanel();
    const t = await sign('cashier');
    const r = await panel.feed('payments_ledger', {}, t);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.totals.refundedLabel).not.toMatch(/-/);
      expect(r.data.totals.netLabel).not.toMatch(/-/);
    }
  });
});

describe('the shop decides, not the code', () => {
  it('starts with every payment method, 3 low-stock units and a 10% big difference, all changeable by the owner', async () => {
    const { panel, sign } = await demoPanel();
    const owner = await sign('owner');
    const before = await panel.feed('shop_settings', {}, owner);
    expect(before.ok && before.data.paymentMethods.map((m) => m.key)).toEqual(['cash', 'mobile_money', 'card', 'bank_transfer']);
    expect(before.ok && [before.data.lowStockUnits, before.data.bigDifferencePercent, before.data.currencyLabel]).toEqual([3, 10, 'TSh']);
    expect((await panel.dispatch('settings/update', { paymentMethods: ['cash'], lowStockUnits: 8, bigDifferencePercent: 25 }, owner)).ok).toBe(true);
    const after = await panel.feed('shop_settings', {}, owner);
    expect(after.ok && after.data.paymentMethods.map((m) => m.key)).toEqual(['cash']);
    expect(after.ok && [after.data.lowStockUnits, after.data.bigDifferencePercent]).toEqual([8, 25]);
  });

  it('refuses a payment method that is switched off, and an empty list of methods', async () => {
    const { panel, sign } = await demoPanel();
    const owner = await sign('owner');
    expect((await panel.dispatch('settings/update', { paymentMethods: [] }, owner)).ok).toBe(false);
    await panel.dispatch('settings/update', { paymentMethods: ['cash'] }, owner);
    const r = await panel.dispatch('orders/quick_sale', { items: [{ combinationId: 'nope', qty: 1 }], method: 'card' }, owner);
    expect(!r.ok && r.error.messages.join(' ')).toMatch(/does not take that kind of payment/);
  });

  it('writes amounts in the currency the server was given', async () => {
    const store = createMemoryStore();
    const panel = createPanel({ store, currencyLabel: 'KSh' });
    await seedDemo(store, panel);
    const staff = await store.list<Staff>('staff');
    const r = await panel.dispatch('auth/sign_in', { userId: staff.find((s) => s.role === 'owner')!.id, pin: DEMO_STAFF.find((s) => s.role === 'owner')!.pin });
    const t = (r as { data: { sessionId: string } }).data.sessionId;
    const feed = await panel.feed('shop_settings', {}, t);
    expect(feed.ok && feed.data.currencyLabel).toBe('KSh');
    const ledger = await panel.feed('payments_ledger', {}, t);
    expect(ledger.ok && ledger.data.totals.netLabel).toMatch(/^KSh /);
  });

  it('flags a count as big using the owner\'s percentage', async () => {
    const { panel, sign } = await demoPanel();
    const inv = await sign('inventory');
    const owner = await sign('owner');
    await panel.dispatch('inventory/create_ingredient', { name: 'Flour', unit: 'kg', openingStock: 10 }, inv);
    const list = await panel.feed('ingredient_list', {}, inv);
    const id = list.ok ? list.data[0]!.ingredientId : '';
    await panel.dispatch('settings/update', { bigDifferencePercent: 30 }, owner);
    const s = await panel.dispatch('count/start', {}, inv);
    const sid = (s as { data: { sessionId: string } }).data.sessionId;
    await panel.dispatch('count/record', { sessionId: sid, ingredientId: id, counted: 8, unit: 'kg' }, inv); // 20% off
    const view = await panel.feed('count_session', {}, inv);
    expect(view.ok && view.data.session?.items[0]?.big).toBe(false);
    await panel.dispatch('settings/update', { bigDifferencePercent: 10 }, owner);
    const again = await panel.feed('count_session', {}, inv);
    expect(again.ok && again.data.session?.items[0]?.big).toBe(true);
  });
});
