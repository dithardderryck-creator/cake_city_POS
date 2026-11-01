import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type FingerprintStatus, type Panel, type Staff, type Store } from './index';

let t = Date.UTC(2026, 10, 1, 8, 0, 0);
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
let fp: FingerprintStatus;
let forced = 0;
const base: FingerprintStatus = { state: 'ok', savedAt: null, savedSeq: null, comparedAt: null, matchedAt: null, matchedToday: true, checked: 1, problems: [], error: null, late: false };
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const id = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
const signIn = async (role: string) => ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: await id(role), pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;

beforeEach(async () => {
  t = Date.UTC(2026, 10, 1, 8, 0, 0);
  fp = { ...base };
  forced = 0;
  store = createMemoryStore();
  panel = createPanel({
    store,
    clock,
    terminals: {
      fingerprint: {
        status: async () => fp,
        run: async (o) => {
          if (o?.force) forced++;
          return fp;
        },
      },
    },
  });
  await seedDemo(store, panel);
});

describe('the Drive copy of the records', () => {
  it('shows the owner and IT whether the records match Drive, and nobody else', async () => {
    for (const role of ['owner', 'it']) {
      const r = await panel.feed('drive_match', {}, await signIn(role));
      expect(r.ok && r.data.state).toBe('ok');
    }
    for (const role of ['cashier', 'baker', 'inventory']) expect((await panel.feed('drive_match', {}, await signIn(role))).ok).toBe(false);
  });

  it('says "off" when this server keeps no copy', async () => {
    const bare = createPanel({ store, clock });
    const sid = ok<{ sessionId: string }>(await bare.dispatch('auth/sign_in', { userId: await id('owner'), pin: '1111' })).sessionId;
    const r = await bare.feed('drive_match', {}, sid);
    expect(r.ok && r.data.state).toBe('off');
  });

  it('lets only IT compare now, writes it down, and returns the answer', async () => {
    const it = await signIn('it');
    const r = ok<FingerprintStatus>(await panel.dispatch('records/drive_check', {}, it));
    expect(r.state).toBe('ok');
    expect(forced).toBe(1);
    const log = await panel.feed('records_view', {}, it);
    expect(log.ok && log.data.rows[0]!.summary).toBe('Compared the records with Drive: they match');
    for (const role of ['owner', 'cashier']) expect((await panel.dispatch('records/drive_check', {}, await signIn(role))).ok).toBe(false);
  });

  it('is refused plainly when this server keeps no copy', async () => {
    const bare = createPanel({ store, clock });
    const sid = ok<{ sessionId: string }>(await bare.dispatch('auth/sign_in', { userId: await id('it'), pin: '9999' })).sessionId;
    const r = await bare.dispatch('records/drive_check', {}, sid);
    expect(!r.ok && r.error.messages.join(' ')).toMatch(/No copy of the records is kept on Drive/);
  });

  it('rings IT (and only IT) when Drive and the records disagree, and clears it when they agree again', async () => {
    fp = { ...base, state: 'mismatch', problems: ['Record 7 does not match the fingerprint saved on Drive on 2026-10-31.'] };
    await panel.tick();
    const titles = async (role: string) => {
      const r = await panel.feed('alert_inbox', {}, await signIn(role));
      return r.ok ? r.data.open.map((a) => a.title) : [];
    };
    expect(await titles('it')).toContain('The records do not match the copy on Drive');
    expect(await titles('owner')).toEqual([]);
    fp = { ...base };
    await panel.tick();
    expect(await titles('it')).not.toContain('The records do not match the copy on Drive');
  });

  it('rings IT when no new fingerprint has reached Drive for a day', async () => {
    fp = { ...base, late: true, error: 'Google needs a new sign-in.' };
    await panel.tick();
    const r = await panel.feed('alert_inbox', {}, await signIn('it'));
    expect(r.ok && r.data.open.map((a) => a.title)).toContain('No new record fingerprint has reached Drive for a day');
  });
});
