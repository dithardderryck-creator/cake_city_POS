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
