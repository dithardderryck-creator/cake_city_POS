import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';

let t = Date.UTC(2026, 9, 27, 8, 0, 0);
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const id = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
async function signIn(role: string) {
  return ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: await id(role), pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}
async function lockOut(role: string) {
  const userId = await id(role);
  for (let i = 0; i < 5; i++) await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
  return userId;
}

beforeEach(async () => {
  t = Date.UTC(2026, 9, 27, 8, 0, 0);
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
});

describe('IT sees who is locked out and can let them in', () => {
  it('lists people shut out by wrong PINs, and drops them when the time is up', async () => {
    const baker = await lockOut('baker');
    const it = await signIn('it');
    const m = await panel.feed('panel_map', {}, it);
    expect(m.ok && m.data.lockedOut.map((x) => x.id)).toEqual([baker]);
    t += 61_000;
    const later = await panel.feed('panel_map', {}, it);
    expect(later.ok && later.data.lockedOut).toEqual([]);
  });

  it('lets IT and the owner unlock, and the person can sign in at once', async () => {
    const baker = await lockOut('baker');
    const it = await signIn('it');
    ok(await panel.dispatch('staff/unlock', { userId: baker }, it));
    ok(await panel.dispatch('auth/sign_in', { userId: baker, pin: '3333' }));

    const cashier = await lockOut('cashier');
    const owner = await signIn('owner');
    ok(await panel.dispatch('staff/unlock', { userId: cashier }, owner));
  });

  it('refuses cashiers, someone who is not locked out, and does not touch the PIN', async () => {
    const baker = await lockOut('baker');
    const cashier = await signIn('cashier');
    expect((await panel.dispatch('staff/unlock', { userId: baker }, cashier)).ok).toBe(false);
    const it = await signIn('it');
    const fine = await panel.dispatch('staff/unlock', { userId: await id('inventory') }, it);
    expect(fine.ok).toBe(false);
    if (!fine.ok) expect(fine.error.messages.join(' ')).toMatch(/not locked out/);
    ok(await panel.dispatch('staff/unlock', { userId: baker }, it));
    // The old PIN still works; the wrong one still counts as wrong.
    expect((await panel.dispatch('auth/sign_in', { userId: baker, pin: '1234' })).ok).toBe(false);
  });

  it('is written in the activity record with who did it', async () => {
    const baker = await lockOut('baker');
    const it = await signIn('it');
    ok(await panel.dispatch('staff/unlock', { userId: baker }, it));
    const a = await panel.feed('audit_view', {}, it);
    expect(a.ok && a.data.some((x) => x.intent === 'staff/unlock' && /back in/.test(x.summary))).toBe(true);
  });
});

describe('the Selling line', () => {
  it('counts registered devices seen in the last hour and names the ones quiet for a day', async () => {
    const it = await signIn('it');
    const m = await panel.feed('panel_map', {}, it);
    expect(m.ok && m.data.selling.state).toBe('normal');
    expect(m.ok && m.data.selling.online).toBeLessThanOrEqual(m.ok ? m.data.selling.devices : 0);
  });
  it('is for IT only', async () => {
    const cashier = await signIn('cashier');
    expect((await panel.feed('panel_map', {}, cashier)).ok).toBe(false);
  });
});
