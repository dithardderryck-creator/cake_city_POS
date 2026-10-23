import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';

let store: Store;
let panel: Panel;
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
async function signIn(role: string) {
  const id = (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
  return ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: id, pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}

beforeEach(async () => {
  store = createMemoryStore();
  panel = createPanel({ store });
  await seedDemo(store, panel);
});

describe('screen language', () => {
  it('starts in English, and the owner can switch every screen to Kiswahili and back', async () => {
    const owner = await signIn('owner');
    const read = async (token?: string) => {
      const r = await panel.feed('shop_settings', {}, token);
      if (!r.ok) throw new Error('feed failed');
      return r.data.language;
    };
    expect(await read(owner)).toBe('en');
    expect((await panel.deviceStatus(undefined)).language).toBe('en');
    ok(await panel.dispatch('settings/update', { language: 'sw' }, owner));
    expect(await read(owner)).toBe('sw');
    // The sign-in page asks before anyone is signed in.
    expect((await panel.deviceStatus(undefined)).language).toBe('sw');
    // Other settings are untouched by it.
    ok(await panel.dispatch('settings/update', { lowStockUnits: 4 }, owner));
    expect(await read(owner)).toBe('sw');
    ok(await panel.dispatch('settings/update', { language: 'en' }, owner));
    expect(await read(owner)).toBe('en');
  });

  it('refuses other languages and anyone but the owner', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const bad = await panel.dispatch('settings/update', { language: 'fr' } as never, owner);
    expect(bad.ok).toBe(false);
    const no = await panel.dispatch('settings/update', { language: 'sw' }, cashier);
    expect(no.ok).toBe(false);
    expect((await panel.deviceStatus(undefined)).language).toBe('en');
  });

  it('keeps the records in English: the setting changes no stored text', async () => {
    const owner = await signIn('owner');
    ok(await panel.dispatch('settings/update', { language: 'sw' }, owner));
    const cashier = await signIn('cashier');
    const grid = await panel.feed('catalogue_grid', {}, cashier);
    expect(grid.ok && grid.data[0]!.name).toMatch(/Cake/);
    const bad = await panel.dispatch('orders/add_catalogue_line', { orderId: 'nope', combinationId: 'nope', qty: 1 }, cashier);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.messages.join(' ')).toMatch(/[A-Za-z]/);
  });

  it('lets each person choose their own language, and "shop" follows the shop again', async () => {
    const owner = await signIn('owner');
    const cashier = await signIn('cashier');
    const baker = await signIn('baker');
    const mine = async (token: string) => {
      const r = await panel.feed('my_language', {}, token);
      if (!r.ok) throw new Error('feed failed');
      return r.data;
    };
    expect(await mine(cashier)).toEqual({ mine: null, shop: 'en', effective: 'en' });
    ok(await panel.dispatch('auth/set_language', { language: 'sw' }, cashier));
    expect(await mine(cashier)).toEqual({ mine: 'sw', shop: 'en', effective: 'sw' });
    // Nobody else is affected, and the shop's own setting is untouched.
    expect(await mine(baker)).toEqual({ mine: null, shop: 'en', effective: 'en' });
    expect((await panel.deviceStatus(undefined)).language).toBe('en');
    // When the shop changes its language, people who did not choose follow it; the cashier keeps their own.
    ok(await panel.dispatch('settings/update', { language: 'sw' }, owner));
    ok(await panel.dispatch('auth/set_language', { language: 'en' }, cashier));
    expect(await mine(baker)).toEqual({ mine: null, shop: 'sw', effective: 'sw' });
    expect(await mine(cashier)).toEqual({ mine: 'en', shop: 'sw', effective: 'en' });
    ok(await panel.dispatch('auth/set_language', { language: 'shop' }, cashier));
    expect(await mine(cashier)).toEqual({ mine: null, shop: 'sw', effective: 'sw' });
    // Junk is refused, and the choice is in the activity log.
    expect((await panel.dispatch('auth/set_language', { language: 'fr' } as never, cashier)).ok).toBe(false);
    expect((await store.list<{ id: string; summary: string }>('audit')).some((a) => /chose Kiswahili for their screens/.test(a.summary))).toBe(true);
  });
});
