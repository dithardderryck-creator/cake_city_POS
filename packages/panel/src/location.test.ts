import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';
import { distanceM, judgePlace } from './circuits/place';

let store: Store;
let panel: Panel;
let nowMs = Date.parse('2026-10-20T09:00:00Z');
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
async function signIn(role: string) {
  const id = (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
  return ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: id, pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}
// The shop is at the equator and the meridian, which keeps the sums easy: 0.001 degrees is about 111 m.
const SHOP = { lat: 0, lng: 0 };
const AT_SHOP = { lat: 0.0003, lng: 0 }; // ~33 m
const AT_SCHOOL = { lat: 0.02, lng: 0.02 }; // ~3 km

beforeEach(async () => {
  store = createMemoryStore();
  nowMs = Date.parse('2026-10-20T09:00:00Z');
  panel = createPanel({ store, clock: { now: () => new Date(nowMs) } });
  await seedDemo(store, panel);
});

describe('distance', () => {
  it('measures metres between two points', () => {
    expect(Math.round(distanceM(0, 0, 0.001, 0))).toBeGreaterThan(105);
    expect(Math.round(distanceM(0, 0, 0.001, 0))).toBeLessThan(117);
    expect(distanceM(1, 1, 1, 1)).toBe(0);
  });
  it('forgives a phone its own stated error, but not a vague position', () => {
    const s = { shopLat: 0, shopLng: 0, locationRadiusM: 100 } as never;
    expect(judgePlace(s, 0.0013, 0, 0).inside).toBe(false); // ~145 m, exact
    expect(judgePlace(s, 0.0013, 0, 60).inside).toBe(true); // ~145 m but it admits +/- 60 m
    expect(judgePlace(s, 0, 0, 800)).toMatchObject({ inside: false, reason: 'vague' });
  });
});

describe('the location check', () => {
  it('is off by default and holds nobody', async () => {
    const cashier = await signIn('cashier');
    const me = await panel.feed('me', {}, cashier);
    expect(me.ok && me.data.lobby).toBeUndefined();
    const s = await panel.feed('shop_settings', {}, cashier);
    expect(s.ok && s.data.locationCheck).toEqual({ enabled: false, radiusM: 150, spotSet: false });
  });

  it('cannot be switched on before the shop spot is set', async () => {
    const owner = await signIn('owner');
    const r = await panel.dispatch('settings/set_location', { enabled: true }, owner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.messages.join(' ')).toMatch(/Set the shop location first/);
  });

  it('lets the owner and IT set it, and nobody else', async () => {
    const owner = await signIn('owner');
    const it = await signIn('it');
    const cashier = await signIn('cashier');
    ok(await panel.dispatch('settings/set_location', { ...SHOP, radiusM: 100 }, owner));
    ok(await panel.dispatch('settings/set_location', { enabled: true }, it));
    expect((await panel.dispatch('settings/set_location', { enabled: false }, cashier)).ok).toBe(false);
    const f = await panel.feed('location_check', {}, it);
    expect(f.ok && f.data).toMatchObject({ enabled: true, radiusM: 100, spotSet: true, setByName: expect.stringContaining('Amina') });
    expect((await panel.feed('location_check', {}, cashier)).ok).toBe(false);
    // The shop's exact spot is never sent to staff.
    const s = await panel.feed('shop_settings', {}, cashier);
    expect(JSON.stringify(s)).not.toMatch(/shopLat|"lat"/);
  });

  it('refuses a half-given spot and silly values', async () => {
    const owner = await signIn('owner');
    expect((await panel.dispatch('settings/set_location', { lat: 1 }, owner)).ok).toBe(false);
    expect((await panel.dispatch('settings/set_location', { lat: 100, lng: 0 }, owner)).ok).toBe(false);
    expect((await panel.dispatch('settings/set_location', { radiusM: 5 }, owner)).ok).toBe(false);
    expect((await panel.dispatch('settings/set_location', {}, owner)).ok).toBe(false);
  });

  describe('with the check on', () => {
    beforeEach(async () => {
      const owner = await signIn('owner');
      ok(await panel.dispatch('settings/set_location', { ...SHOP, radiusM: 150, enabled: true }, owner));
    });

    it('holds staff in the lobby until they report a position at the shop', async () => {
      const cashier = await signIn('cashier');
      const me = await panel.feed('me', {}, cashier);
      expect(me.ok && me.data.lobby).toBe(true);
      // Work is closed: sales, orders and the catalogue are refused with the reason.
      const grid = await panel.feed('catalogue_grid', {}, cashier);
      expect(grid.ok).toBe(false);
      if (!grid.ok) expect(grid.error.messages.join(' ')).toMatch(/outside the shop/);
      const sale = await panel.dispatch('orders/quick_sale', { items: [], method: 'cash' }, cashier);
      expect(sale.ok).toBe(false);
      if (!sale.ok) expect(sale.error.messages.join(' ')).toMatch(/outside the shop/);
      // The lobby's own things work.
      expect((await panel.feed('announcements', {}, cashier)).ok).toBe(true);
      expect((await panel.feed('shop_settings', {}, cashier)).ok).toBe(true);

      const far = ok<{ inside: boolean; reason?: string }>(await panel.dispatch('session/report_place', AT_SCHOOL, cashier));
      expect(far).toMatchObject({ inside: false, reason: 'far' });
      expect((await panel.feed('catalogue_grid', {}, cashier)).ok).toBe(false);

      const near = ok<{ inside: boolean }>(await panel.dispatch('session/report_place', { ...AT_SHOP, accuracyM: 20 }, cashier));
      expect(near.inside).toBe(true);
      const after = await panel.feed('me', {}, cashier);
      expect(after.ok && after.data.lobby).toBeUndefined();
      expect((await panel.feed('catalogue_grid', {}, cashier)).ok).toBe(true);
    });

    it('never holds the owner or IT', async () => {
      for (const role of ['owner', 'it']) {
        const t = await signIn(role);
        const me = await panel.feed('me', {}, t);
        expect(me.ok && me.data.lobby).toBeUndefined();
      }
      const owner = await signIn('owner');
      expect((await panel.feed('catalogue_grid', {}, owner)).ok).toBe(true);
    });

    it('holds someone again when their position goes stale or they walk out', async () => {
      const baker = await signIn('baker');
      ok(await panel.dispatch('session/report_place', AT_SHOP, baker));
      expect((await panel.feed('bake_queue', {}, baker)).ok).toBe(true);
      nowMs += 11 * 60_000; // nobody has reported for 11 minutes
      expect((await panel.feed('bake_queue', {}, baker)).ok).toBe(false);
      ok(await panel.dispatch('session/report_place', AT_SHOP, baker));
      expect((await panel.feed('bake_queue', {}, baker)).ok).toBe(true);
      ok(await panel.dispatch('session/report_place', AT_SCHOOL, baker));
      expect((await panel.feed('bake_queue', {}, baker)).ok).toBe(false);
    });

    it('does not spam the audit trail with position reports', async () => {
      const cashier = await signIn('cashier');
      const before = (await store.list('audit')).length;
      for (let i = 0; i < 5; i++) ok(await panel.dispatch('session/report_place', AT_SHOP, cashier));
      expect((await store.list('audit')).length).toBe(before);
    });

    it('lets the owner or IT switch it off, and then nobody is held', async () => {
      const cashier = await signIn('cashier');
      expect((await panel.feed('catalogue_grid', {}, cashier)).ok).toBe(false);
      const it = await signIn('it');
      ok(await panel.dispatch('settings/set_location', { enabled: false }, it));
      expect((await panel.feed('catalogue_grid', {}, cashier)).ok).toBe(true);
      const audit = (await store.list<{ id: string; summary: string }>('audit')).map((a) => a.summary);
      expect(audit).toContain('Turned off the location check');
    });

    it('counts who is held right now', async () => {
      await signIn('cashier');
      const baker = await signIn('baker');
      ok(await panel.dispatch('session/report_place', AT_SHOP, baker));
      const it = await signIn('it');
      const f = await panel.feed('location_check', {}, it);
      expect(f.ok && f.data.heldNow).toBe(1);
    });
  });
});
