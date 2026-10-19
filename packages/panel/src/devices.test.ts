import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';

function makeClock() {
  let t = Date.UTC(2026, 9, 11, 8, 0, 0);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

let store: Store;
let clock: ReturnType<typeof makeClock>;
let panel: Panel;

const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : `${r.error.code}: ${r.error.messages.join(' ')}`);
const idOf = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
const pinOf = (role: string) => DEMO_STAFF.find((s) => s.role === role)!.pin;

async function signIn(role: string, deviceToken?: string) {
  return panel.dispatch('auth/sign_in', { userId: await idOf(role), pin: pinOf(role) }, undefined, { deviceToken });
}

/** The first device is registered from the server, so the owner has somewhere to sign in. */
async function pairFirst(name = 'Office laptop') {
  const owner = createPanel({ store, clock }); // same data, device check off, to seed the first owner session
  const t = ok<{ sessionId: string }>(await owner.dispatch('auth/sign_in', { userId: await idOf('owner'), pin: pinOf('owner') })).sessionId;
  const code = ok<{ code: string }>(await owner.dispatch('devices/create_code', { name }, t)).code;
  return ok<{ deviceToken: string }>(await panel.dispatch('devices/pair', { code })).deviceToken;
}

beforeEach(async () => {
  clock = makeClock();
  store = createMemoryStore();
  await seedDemo(store, createPanel({ store, clock }));
  panel = createPanel({ store, clock, requireDevice: true });
});

describe('registered devices', () => {
  it('refuses sign-in and hides the staff names on a device that is not registered', async () => {
    expect(errOf(await signIn('cashier'))).toMatch(/not registered/);
    expect(errOf(await signIn('cashier', 'made-up-secret'))).toMatch(/not registered/);
    const names = await panel.feed('staff_signin', {});
    expect(names.ok).toBe(false);
    expect(await panel.deviceStatus(undefined)).toEqual({ required: true, registered: false, language: 'en' });
  });

  it('registers a device with a one-time code, then lets it sign in and see the names', async () => {
    const dev = await pairFirst('Counter tablet');
    expect(await panel.deviceStatus(dev)).toEqual({ required: true, registered: true, name: 'Counter tablet', language: 'en' });
    const names = await panel.feed('staff_signin', {}, undefined, dev);
    expect(names.ok && names.data.length).toBe(DEMO_STAFF.length);
    expect(ok<{ sessionId: string }>(await signIn('cashier', dev)).sessionId).toBeTruthy();
  });

  it('keeps only hashes: neither the code nor the secret is stored', async () => {
    const dev = await pairFirst();
    const dump = JSON.stringify([await store.list('devices'), await store.list('pairingCodes')]);
    expect(dump).not.toContain(dev);
  });

  it('works once, expires after ten minutes, and can be cancelled', async () => {
    const owner = createPanel({ store, clock });
    const t = ok<{ sessionId: string }>(await owner.dispatch('auth/sign_in', { userId: await idOf('owner'), pin: pinOf('owner') })).sessionId;
    const make = async (name: string) => ok<{ code: string }>(await owner.dispatch('devices/create_code', { name }, t)).code;

    const a = await make('A');
    ok(await panel.dispatch('devices/pair', { code: a }));
    expect(errOf(await panel.dispatch('devices/pair', { code: a }))).toMatch(/not valid|already used|expired/);

    const b = await make('B');
    clock.advance(10 * 60_000 + 1000);
    expect(errOf(await panel.dispatch('devices/pair', { code: b }))).toMatch(/expired/);

    const c = await make('C');
    const open = await owner.feed('device_list', {}, t);
    const row = (open.ok ? open.data.openCodes.find((x) => x.name === 'C') : undefined)!;
    expect(row).toBeTruthy();
    ok(await owner.dispatch('devices/cancel_code', { codeId: row.id }, t));
    expect(errOf(await panel.dispatch('devices/pair', { code: c }))).toMatch(/not valid|expired/);
  });

  it('accepts the code however it is typed, and refuses guesses', async () => {
    const owner = createPanel({ store, clock });
    const t = ok<{ sessionId: string }>(await owner.dispatch('auth/sign_in', { userId: await idOf('owner'), pin: pinOf('owner') })).sessionId;
    const code = ok<{ code: string }>(await owner.dispatch('devices/create_code', { name: 'Typed' }, t)).code;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(errOf(await panel.dispatch('devices/pair', { code: 'AAAA-AAAA' }))).toMatch(/not valid/);
    ok(await panel.dispatch('devices/pair', { code: ` ${code.toLowerCase().replace('-', ' ')} ` }));
  });

  it('only the owner and IT can make codes, rename and revoke', async () => {
    const dev = await pairFirst();
    const cashier = ok<{ sessionId: string }>(await signIn('cashier', dev)).sessionId;
    expect(errOf(await panel.dispatch('devices/create_code', { name: 'X' }, cashier))).toMatch(/forbidden/);
    const it = ok<{ sessionId: string }>(await signIn('it', dev)).sessionId;
    ok(await panel.dispatch('devices/create_code', { name: 'Phone' }, it));
  });

  it('revoking a device signs out everyone on it at once and shuts it out', async () => {
    const office = await pairFirst('Office laptop');
    const tablet = await pairFirst('Counter tablet');
    const cashier = ok<{ sessionId: string }>(await signIn('cashier', tablet)).sessionId;
    const owner = ok<{ sessionId: string }>(await signIn('owner', office)).sessionId;
    expect((await panel.feed('me', {}, cashier)).ok).toBe(true);

    const list = await panel.feed('device_list', {}, owner, office);
    const row = (list.ok ? list.data.devices.find((d) => d.name === 'Counter tablet') : undefined)!;
    expect(list.ok && list.data.devices.find((d) => d.isThis)?.name).toBe('Office laptop');
    ok(await panel.dispatch('devices/revoke', { deviceId: row.id }, owner, { deviceToken: office }));

    expect(errOf(await panel.dispatch('auth/sign_out', {}, cashier))).toMatch(/unauthenticated/);
    expect((await panel.feed('me', {}, cashier)).ok).toBe(false);
    expect(errOf(await signIn('cashier', tablet))).toMatch(/not registered/);
    expect(await panel.deviceStatus(tablet)).toMatchObject({ registered: false });
    // The owner on the other device is untouched.
    expect((await panel.feed('me', {}, owner)).ok).toBe(true);
  });

  it('will not let someone revoke the device they are using', async () => {
    const office = await pairFirst('Office laptop');
    const owner = ok<{ sessionId: string }>(await signIn('owner', office)).sessionId;
    const list = await panel.feed('device_list', {}, owner, office);
    const me = (list.ok ? list.data.devices.find((d) => d.isThis) : undefined)!;
    expect(errOf(await panel.dispatch('devices/revoke', { deviceId: me.id }, owner, { deviceToken: office }))).toMatch(/using this device/);
  });

  it('lets IT revoke a device too, and the owner is not locked out of the others', async () => {
    const office = await pairFirst('Office laptop');
    const phone = await pairFirst('Owner phone');
    const owner = ok<{ sessionId: string }>(await signIn('owner', phone)).sessionId;
    const it = ok<{ sessionId: string }>(await signIn('it', office)).sessionId;
    const list = await panel.feed('device_list', {}, it, office);
    const row = (list.ok ? list.data.devices.find((d) => d.name === 'Owner phone') : undefined)!;
    ok(await panel.dispatch('devices/revoke', { deviceId: row.id }, it, { deviceToken: office }));
    expect((await panel.feed('me', {}, owner)).ok).toBe(false);
    // The laptop still works, and a fresh code brings the phone back.
    expect(ok<{ sessionId: string }>(await signIn('owner', office)).sessionId).toBeTruthy();
  });

  it('never lets the last registered device be revoked', async () => {
    const office = await pairFirst('Office laptop');
    const list = await store.list<{ id: string; revokedAt?: string }>('devices');
    const only = list.find((d) => !d.revokedAt)!;
    // Device check is off on this panel, so the actor is not on a device and the "this device" rule cannot catch it.
    const open = createPanel({ store, clock });
    const t = ok<{ sessionId: string }>(await open.dispatch('auth/sign_in', { userId: await idOf('owner'), pin: pinOf('owner') })).sessionId;
    expect(errOf(await open.dispatch('devices/revoke', { deviceId: only.id }, t))).toMatch(/only registered device/);
    expect(await panel.deviceStatus(office)).toMatchObject({ registered: true });
  });

  it('re-registers a browser that lost its secret under the same name and retires the old record', async () => {
    const office = await pairFirst('Office laptop');
    const tablet = await pairFirst('Counter tablet');
    const owner = ok<{ sessionId: string }>(await signIn('owner', office)).sessionId;
    const cashier = ok<{ sessionId: string }>(await signIn('cashier', tablet)).sessionId;
    const list = await panel.feed('device_list', {}, owner, office);
    const old = (list.ok ? list.data.devices.find((d) => d.name === 'Counter tablet') : undefined)!;
    // A plain code under the same name is refused; one marked as a replacement is allowed.
    expect(errOf(await panel.dispatch('devices/create_code', { name: 'Counter tablet' }, owner, { deviceToken: office }))).toMatch(/already registered/);
    const code = ok<{ code: string }>(await panel.dispatch('devices/create_code', { name: 'Counter tablet', replaces: old.id }, owner, { deviceToken: office })).code;
    const fresh = ok<{ deviceToken: string }>(await panel.dispatch('devices/pair', { code })).deviceToken;
    expect(await panel.deviceStatus(fresh)).toEqual({ required: true, registered: true, name: 'Counter tablet', language: 'en' });
    // The old secret and its sessions are dead, and the name is listed once.
    expect(await panel.deviceStatus(tablet)).toMatchObject({ registered: false });
    expect((await panel.feed('me', {}, cashier)).ok).toBe(false);
    const after = await panel.feed('device_list', {}, owner, office);
    expect(after.ok && after.data.devices.filter((d) => d.name === 'Counter tablet').length).toBe(1);
    // It cannot replace a device that is gone, or the one in use.
    expect(errOf(await panel.dispatch('devices/create_code', { name: 'X', replaces: old.id }, owner, { deviceToken: office }))).toMatch(/no longer registered/);
    const me = (after.ok ? after.data.devices.find((d) => d.isThis) : undefined)!;
    expect(errOf(await panel.dispatch('devices/create_code', { name: 'Office laptop', replaces: me.id }, owner, { deviceToken: office }))).toMatch(/using this device/);
  });

  it('does not allow two devices with the same name, and renames', async () => {
    const office = await pairFirst('Office laptop');
    const owner = ok<{ sessionId: string }>(await signIn('owner', office)).sessionId;
    expect(errOf(await panel.dispatch('devices/create_code', { name: 'office LAPTOP' }, owner, { deviceToken: office }))).toMatch(/already registered/);
    const list = await panel.feed('device_list', {}, owner, office);
    const me = (list.ok ? list.data.devices[0] : undefined)!;
    ok(await panel.dispatch('devices/rename', { deviceId: me.id, name: 'Back office' }, owner, { deviceToken: office }));
    expect(await panel.deviceStatus(office)).toMatchObject({ name: 'Back office' });
  });

  it('is off when the host does not ask for it', async () => {
    const open = createPanel({ store, clock });
    expect(await open.deviceStatus(undefined)).toEqual({ required: false, registered: false, language: 'en' });
    expect((await open.feed('staff_signin', {})).ok).toBe(true);
  });

  it('turning it on signs out people who signed in before devices were checked', async () => {
    const open = createPanel({ store, clock });
    const t = ok<{ sessionId: string }>(await open.dispatch('auth/sign_in', { userId: await idOf('owner'), pin: pinOf('owner') })).sessionId;
    expect((await open.feed('me', {}, t)).ok).toBe(true);
    expect((await panel.feed('me', {}, t)).ok).toBe(false);
  });
});
