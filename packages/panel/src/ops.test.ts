import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type CatalogueGridItem, type DispatchResult, type Panel, type Staff, type Store } from './index';
import type { ChangePreview } from './feeds';

let t = Date.UTC(2026, 10, 2, 8, 0, 0);
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
const sid: Record<string, string> = {};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const bad = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const staff = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!;
async function signIn(role: string) {
  sid[role] = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: (await staff(role)).id, pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}
const send = (role: string, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const preview = async (role: string, intent: string, payload: object) => {
  const r = await panel.feed('change_preview', { intent, payload } as never, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as ChangePreview;
};
beforeEach(async () => {
  t = Date.UTC(2026, 10, 2, 8, 0, 0);
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  for (const r of ['owner', 'cashier', 'baker', 'it']) await signIn(r);
});

describe('previews', () => {
  it('say what would happen, change nothing, and refuse what the person may not do', async () => {
    const neema = await staff('baker');
    const p = await preview('it', 'sessions/end', { userId: neema.id });
    expect(p).toMatchObject({ ok: true, confirmName: null });
    expect(p.lines[0]).toMatch(/Signs Neema \(Baker\) out of 1 sign-in/);
    expect((await panel.feed('me', {}, sid.baker)).ok).toBe(true); // still signed in: a preview does nothing
    expect((await preview('cashier' as never, 'sessions/end', { userId: neema.id }).catch(() => ({ ok: false }))).ok).toBe(false);
    expect(await preview('it', 'sessions/end', { userId: 'nobody' })).toMatchObject({ ok: false, problems: ['That person no longer exists.'] });
    expect(await preview('it', 'sessions/end', { userId: (await staff('it')).id })).toMatchObject({ ok: false });
    expect(await preview('it', 'nope/nothing', {})).toMatchObject({ ok: false });
    expect((await preview('it', 'sessions/end', { wrong: 1 })).ok).toBe(false);
  });
});

describe('ending sessions', () => {
  it('signs a person out everywhere and writes it down', async () => {
    const neema = await staff('baker');
    const r = ok<{ ended: number }>(await send('it', 'sessions/end', { userId: neema.id }));
    expect(r.ended).toBe(1);
    const after = await panel.feed('me', {}, sid.baker);
    expect(after.ok).toBe(false);
    const log = await panel.feed('records_view', {}, sid.it);
    expect(log.ok && log.data.rows.some((x) => /Signed Neema \(Baker\) out of 1 sign-in/.test(x.summary ?? ''))).toBe(true);
  });
  it('is for IT only, and not for yourself or someone who is not signed in', async () => {
    const neema = await staff('baker');
    expect(bad(await send('owner', 'sessions/end', { userId: neema.id }))).toMatch(/role cannot/);
    expect(bad(await send('it', 'sessions/end', { userId: (await staff('it')).id }))).toMatch(/That is you/);
    expect(bad(await send('it', 'sessions/end', { userId: (await staff('inventory')).id }))).toMatch(/is not signed in/);
  });
});

describe('pausing selling', () => {
  const sale = async () => {
    const grid = await panel.feed('catalogue_grid', {}, sid.cashier);
    if (!grid.ok) throw new Error('grid');
    const c = (grid.data as CatalogueGridItem[]).flatMap((g) => g.combinations).find((x) => x.sellable)!;
    return { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash' as const, expectedTotal: c.price ?? undefined };
  };
  it('stops new sales with the reason, lets the rest of the shop work, and resumes', async () => {
    const s = await sale();
    expect((await preview('it', 'maintenance/set', { on: true })).lines.join(' ')).toMatch(/Stops new sales/);
    ok(await send('it', 'maintenance/set', { on: true, message: 'Back at 2 pm' }));
    expect(bad(await send('cashier', 'orders/quick_sale', s))).toMatch(/Selling is paused: Back at 2 pm/);
    const shop = await panel.feed('shop_settings', {}, sid.cashier);
    expect(shop.ok && shop.data.maintenance).toMatchObject({ on: true, message: 'Back at 2 pm' });
    const map = await panel.feed('panel_map', {}, sid.it);
    expect(map.ok && map.data.selling).toMatchObject({ state: 'paused', message: 'Back at 2 pm' });
    expect((await panel.feed('catalogue_grid', {}, sid.cashier)).ok).toBe(true); // looking is fine
    expect(await preview('cashier' as never, 'orders/quick_sale', s).catch(() => ({ ok: false }))).toMatchObject({ ok: false });
    ok(await send('owner', 'maintenance/set', { on: false }));
    ok(await send('cashier', 'orders/quick_sale', s));
  });
  it('refuses a second pause, a long message, and anyone but IT or the owner', async () => {
    ok(await send('it', 'maintenance/set', { on: true }));
    expect(bad(await send('it', 'maintenance/set', { on: true }))).toMatch(/already paused/);
    expect(bad(await send('owner', 'maintenance/set', { on: false, message: 'x'.repeat(200) }))).toMatch(/under 140|too long|140/);
    expect(bad(await send('cashier', 'maintenance/set', { on: false }))).toMatch(/role cannot/);
    ok(await send('it', 'maintenance/set', { on: false }));
    expect(bad(await send('it', 'maintenance/set', { on: false }))).toMatch(/not paused/);
  });
  it('is not synced to the online database', async () => {
    const before = (await store.list('changes')).length;
    ok(await send('it', 'maintenance/set', { on: true }));
    const rows = (await store.list<{ id: string; collection?: string }>('changes')).slice(before);
    expect(rows.some((r) => r.collection === 'maintenance')).toBe(false);
  });
});

describe('IT looks after staff access', () => {
  it('adds people but not another owner, and sees the staff list', async () => {
    ok(await send('it', 'staff/create', { name: 'Zawadi', role: 'cashier', pin: '5555' }));
    expect(bad(await send('it', 'staff/create', { name: 'Boss', role: 'owner', pin: '5556' }))).toMatch(/Only an owner can add another owner/);
    const list = await panel.feed('staff_list', {}, sid.it);
    expect(list.ok && list.data.map((x) => x.name)).toContain('Zawadi');
    expect((await panel.feed('staff_list', {}, sid.cashier)).ok).toBe(false);
  });
  it('resets the owner\'s PIN only after the name is asked for, signs her out and leaves her a note', async () => {
    const owner = await staff('owner');
    const p = await preview('it', 'staff/set_pin', { userId: owner.id, pin: '2468' });
    expect(p.confirmName).toBe(owner.name);
    expect(p.lines.join(' ')).toMatch(/signed out everywhere/);
    expect((await preview('it', 'staff/set_pin', { userId: (await staff('cashier')).id, pin: '2468' })).confirmName).toBeNull();
    ok(await send('it', 'staff/set_pin', { userId: owner.id, pin: '2468' }));
    expect((await panel.feed('me', {}, sid.owner)).ok).toBe(false);
    sid.owner = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: owner.id, pin: '2468' })).sessionId;
    const note = await panel.feed('account_notice', {}, sid.owner);
    expect(note.ok && note.data.pinChanged?.by).toBe((await staff('it')).name);
    ok(await send('owner', 'account/ack_notice', {}));
    const gone = await panel.feed('account_notice', {}, sid.owner);
    expect(gone.ok && gone.data.pinChanged).toBeNull();
  });
  it('leaves no note when the owner changes someone else\'s PIN or IT changes a cashier\'s', async () => {
    ok(await send('it', 'staff/set_pin', { userId: (await staff('cashier')).id, pin: '7777' }));
    ok(await send('owner', 'staff/set_pin', { userId: (await staff('baker')).id, pin: '8888' }));
    const note = await panel.feed('account_notice', {}, sid.owner);
    expect(note.ok && note.data.pinChanged).toBeNull();
  });
  it('turns people off and on, changes roles and removes them, with previews, but keeps the owner safe', async () => {
    const cashier = await staff('cashier');
    expect((await preview('it', 'staff/set_active', { userId: cashier.id, active: false })).lines.join(' ')).toMatch(/can no longer sign in/);
    ok(await send('it', 'staff/set_active', { userId: cashier.id, active: false }));
    ok(await send('it', 'staff/set_active', { userId: cashier.id, active: true }));
    ok(await send('it', 'staff/set_role', { userId: cashier.id, role: 'inventory' }));
    const owner = await staff('owner');
    expect(bad(await send('it', 'staff/set_active', { userId: owner.id, active: false }))).toMatch(/at least one active owner/);
    expect(bad(await send('it', 'staff/delete', { userId: owner.id }))).toMatch(/cannot be removed/);
    expect(bad(await send('it', 'staff/set_role', { userId: owner.id, role: 'cashier' }))).toMatch(/cannot be changed/);
    const del = await preview('it', 'staff/delete', { userId: cashier.id });
    expect(del.confirmName).toBe(cashier.name);
    ok(await send('it', 'staff/delete', { userId: cashier.id }));
  });
});
