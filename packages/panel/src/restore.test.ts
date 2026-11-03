import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type Panel, type RestorePlan, type RestoreStatus, type Staff, type Store } from './index';
import type { ChangePreview } from './feeds';

let t = Date.UTC(2026, 10, 2, 8, 0, 0);
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
let started: Array<{ file: string; by: string }>;
let backups: number;
let status: RestoreStatus;
let plan: RestorePlan;
const sid: Record<string, string> = {};
const FILE = 'cakepos-20261101-020000.sqlite';
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const bad = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const staff = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!;
const send = (role: string, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const preview = async (role: string, intent: string, payload: object) => {
  const r = await panel.feed('change_preview', { intent, payload } as never, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as ChangePreview;
};

beforeEach(async () => {
  started = [];
  backups = 0;
  status = { state: 'idle', file: null, startedAt: null, finishedAt: null, message: null, discardedDays: [] };
  plan = { ok: true, problem: null, file: FILE, madeAt: new Date(Date.UTC(2026, 10, 1, 2, 0, 0)).toISOString(), sealedThen: 40, sealedNow: 55, discardedRecords: 15, discardedDays: ['2026-11-01', '2026-11-02'], ordersSince: 6, paymentsSince: 5 };
  store = createMemoryStore();
  panel = createPanel({
    store,
    clock,
    terminals: {
      backup: { status: async () => ({ lastOkAt: null, lastError: null, lastFile: null, pendingUploads: 0 }), runNow: async () => void backups++ },
      restore: {
        list: async () => [{ file: FILE, madeAt: plan.madeAt!, sizeKb: 120, sealed: 40 }],
        plan: async (file) => (file === FILE ? plan : { ...plan, ok: false, problem: 'That is not one of the backups on this server.' }),
        start: async (file, by) => void started.push({ file, by }),
        status: async () => status,
      },
    },
  });
  await seedDemo(store, panel);
  for (const r of ['owner', 'cashier', 'it']) sid[r] = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: (await staff(r)).id, pin: DEMO_STAFF.find((s) => s.role === r)!.pin })).sessionId;
});

describe('backing up now', () => {
  it('starts a backup for IT or the owner, and writes it down', async () => {
    ok(await send('it', 'backup/run_now', {}));
    ok(await send('owner', 'backup/run_now', {}));
    expect(backups).toBe(2);
    expect(bad(await send('cashier', 'backup/run_now', {}))).toMatch(/role cannot/);
  });
});

describe('restoring a backup', () => {
  it('lists the backups and the state of the job for IT only', async () => {
    const r = await panel.feed('restore_points', {}, sid.it);
    expect(r.ok && r.data).toMatchObject({ available: true, paused: false, points: [{ file: FILE, sealed: 40 }], status: { state: 'idle' } });
    expect((await panel.feed('restore_points', {}, sid.owner)).ok).toBe(false);
  });

  it('will not start while selling is open', async () => {
    expect(bad(await send('it', 'restore/start', { file: FILE }))).toMatch(/Pause selling first/);
    expect((await preview('it', 'restore/start', { file: FILE })).ok).toBe(false);
    expect(started).toEqual([]);
  });

  it('shows what it would remove, asks for the backup\'s name, and then starts the job', async () => {
    ok(await send('it', 'maintenance/set', { on: true }));
    const p = await preview('it', 'restore/start', { file: FILE });
    expect(p.ok).toBe(true);
    expect(p.confirmName).toBe('cakepos-20261101-020000');
    const text = p.lines.join(' ');
    expect(text).toMatch(/Removes 15 sealed records, 6 orders and 5 payments made since \(2026-11-01, 2026-11-02\)/);
    expect(text).toMatch(/fresh copy of the current records is saved first/);
    expect(started).toEqual([]); // a preview starts nothing
    ok(await send('it', 'restore/start', { file: FILE }));
    expect(started).toEqual([{ file: FILE, by: (await staff('it')).name }]);
    const log = await panel.feed('records_view', {}, sid.it);
    expect(log.ok && log.data.rows[0]!.summary).toBe(`Started a restore from backup ${FILE}`);
  });

  it('says nothing is lost when the backup is the newest state', async () => {
    ok(await send('it', 'maintenance/set', { on: true }));
    plan = { ...plan, discardedRecords: 0, discardedDays: [], ordersSince: 0, paymentsSince: 0 };
    expect((await preview('it', 'restore/start', { file: FILE })).lines.join(' ')).toMatch(/Nothing newer than this backup is lost/);
  });

  it('refuses a backup the server does not have, a second restore at once, and anyone but IT', async () => {
    ok(await send('it', 'maintenance/set', { on: true }));
    expect(bad(await send('it', 'restore/start', { file: 'other.sqlite' }))).toMatch(/not one of the backups/);
    status = { ...status, state: 'running' };
    expect(bad(await send('it', 'restore/start', { file: FILE }))).toMatch(/already running/);
    status = { ...status, state: 'idle' };
    expect(bad(await send('owner', 'restore/start', { file: FILE }))).toMatch(/role cannot/);
    expect(started).toEqual([]);
  });

  it('says so plainly on a server that cannot restore', async () => {
    const bare = createPanel({ store, clock });
    const it = ok<{ sessionId: string }>(await bare.dispatch('auth/sign_in', { userId: (await staff('it')).id, pin: '9999' })).sessionId;
    await bare.dispatch('maintenance/set', { on: true }, it);
    expect(bad(await bare.dispatch('restore/start', { file: FILE }, it))).toMatch(/cannot restore a backup from here/);
    const r = await bare.feed('restore_points', {}, it);
    expect(r.ok && r.data.available).toBe(false);
  });
});
