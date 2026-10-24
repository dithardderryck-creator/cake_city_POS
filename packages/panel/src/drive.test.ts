import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type DriveStatus, type DriveTerminal, type Panel, type Staff, type Store } from './index';

let store: Store;
let panel: Panel;
let calls: string[];
let status: DriveStatus;
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
async function signIn(role: string) {
  const id = (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
  return ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: id, pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}

/** A stand-in for the server's Google accounts that remembers what it was asked. */
const fake: DriveTerminal = {
  status: async () => status,
  saveClient: async (id, secret) => {
    calls.push(`saveClient:${id}`);
    return secret.length < 8 ? { ok: false, error: 'That does not look like a Google client secret.' } : { ok: true };
  },
  startConnect: async () => {
    calls.push('start');
    return { ok: true, userCode: 'ABCD-EFGH', url: 'https://www.google.com/device', expiresAt: '2026-10-23T10:00:00.000Z' };
  },
  cancelConnect: async () => {
    calls.push('cancel');
    return { ok: true };
  },
  remove: async (id) => (id === 'a1' ? (calls.push('remove:a1'), { ok: true, email: 'a@example.com' }) : { ok: false, error: 'That Google account is not connected.' }),
  move: async (id, d) => (calls.push(`move:${id}:${d}`), { ok: true }),
  pause: async (id, p) => (calls.push(`pause:${id}:${p}`), { ok: true, email: 'a@example.com' }),
  test: async (id) => (calls.push(`test:${id ?? 'all'}`), { ok: true }),
};

beforeEach(async () => {
  calls = [];
  status = { clientReady: true, clientFrom: 'saved', folderName: 'Cake POS', accounts: [], connect: null, problem: null };
  store = createMemoryStore();
  panel = createPanel({ store, terminals: { drive: fake } });
  await seedDemo(store, panel);
});

describe('Google accounts from the Owner and IT screens', () => {
  it('lets the owner and IT see and manage them, and nobody else', async () => {
    for (const role of ['owner', 'it']) {
      const t = await signIn(role);
      const f = await panel.feed('drive_accounts', {}, t);
      expect(f.ok && f.data).toMatchObject({ available: true, clientReady: true, accounts: [] });
      ok(await panel.dispatch('drive/connect_start', {}, t));
    }
    for (const role of ['cashier', 'baker', 'inventory']) {
      const t = await signIn(role);
      expect((await panel.feed('drive_accounts', {}, t)).ok).toBe(false);
      expect((await panel.dispatch('drive/connect_start', {}, t)).ok).toBe(false);
      expect((await panel.dispatch('drive/remove_account', { accountId: 'a1' }, t)).ok).toBe(false);
      expect((await panel.dispatch('drive/save_client', { clientId: 'client-id-1234567', clientSecret: 'secret-1234' }, t)).ok).toBe(false);
    }
    expect(calls).toEqual(['start', 'start']);
  });

  it('starts a sign-in and returns the code to show', async () => {
    const t = await signIn('owner');
    expect(ok(await panel.dispatch('drive/connect_start', {}, t))).toEqual({ userCode: 'ABCD-EFGH', url: 'https://www.google.com/device', expiresAt: '2026-10-23T10:00:00.000Z' });
    ok(await panel.dispatch('drive/connect_cancel', {}, t));
    expect(calls).toEqual(['start', 'cancel']);
  });

  it('passes the commands on, and shows the server\'s own refusal in plain words', async () => {
    const t = await signIn('it');
    ok(await panel.dispatch('drive/move_account', { accountId: 'a1', direction: 'up' }, t));
    ok(await panel.dispatch('drive/pause_account', { accountId: 'a1', paused: true }, t));
    ok(await panel.dispatch('drive/test', {}, t));
    ok(await panel.dispatch('drive/test', { accountId: 'a1' }, t));
    ok(await panel.dispatch('drive/remove_account', { accountId: 'a1' }, t));
    const bad = await panel.dispatch('drive/remove_account', { accountId: 'zzz' }, t);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.messages.join(' ')).toMatch(/not connected/);
    const weak = await panel.dispatch('drive/save_client', { clientId: 'client-id-1234567', clientSecret: 'x' }, t);
    expect(weak.ok).toBe(false);
    expect(calls).toEqual(['move:a1:up', 'pause:a1:true', 'test:all', 'test:a1', 'remove:a1', 'saveClient:client-id-1234567']);
    // Junk is refused before it reaches the server.
    expect((await panel.dispatch('drive/move_account', { accountId: 'a1', direction: 'sideways' } as never, t)).ok).toBe(false);
  });

  it('writes who did what to the activity log, and never the secret', async () => {
    const t = await signIn('owner');
    ok(await panel.dispatch('drive/save_client', { clientId: 'client-id-1234567', clientSecret: 'TOPSECRET-value' }, t));
    ok(await panel.dispatch('drive/connect_start', {}, t));
    ok(await panel.dispatch('drive/pause_account', { accountId: 'a1', paused: true }, t));
    const audit = await store.list<{ id: string; summary: string; actorName?: string }>('audit');
    const text = JSON.stringify(audit);
    expect(text).toMatch(/Started connecting a Google account/);
    expect(text).toMatch(/Paused the Google account a@example.com/);
    expect(text).not.toMatch(/TOPSECRET/);
    expect(JSON.stringify(await store.list('requests'))).not.toMatch(/TOPSECRET/);
  });

  it('says plainly when the server has no Google support at all', async () => {
    const bare = createMemoryStore();
    const p = createPanel({ store: bare });
    await seedDemo(bare, p);
    const id = (await bare.list<Staff>('staff')).find((x) => x.role === 'owner')!.id;
    const t = ok<{ sessionId: string }>(await p.dispatch('auth/sign_in', { userId: id, pin: '1111' })).sessionId;
    const f = await p.feed('drive_accounts', {}, t);
    expect(f.ok && f.data).toMatchObject({ available: false, accounts: [] });
    const r = await p.dispatch('drive/connect_start', {}, t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.messages.join(' ')).toMatch(/not available on this server/);
  });
});
