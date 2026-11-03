import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPanel, DEMO_STAFF, seedDemo, verifyChain, createIds, type CatalogueGridItem, type ChainHead, type DispatchResult, type Panel, type RestoreStatus, type Staff } from '@cake-pos/panel';
import { stamp } from './backup';
import type { Logger } from './log';
import { createRestoreService, madeAtOf } from './restore';
import { openSqliteStore, type SqliteStore } from './sqlite-store';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, close() {} };
let t = Date.UTC(2026, 10, 1, 8, 0, 0);
const clock = { now: () => new Date(t) };
let dir: string;
let db: SqliteStore;
let panel: Panel;
const sid: Record<string, string> = {};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const staff = async (role: string) => (await db.list<Staff>('staff')).find((s) => s.role === role)!;
const send = (role: string, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);

async function sell() {
  // People are signed out after a quiet spell, so sign in again whenever the clock has moved on.
  sid.cashier = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: (await staff('cashier')).id, pin: DEMO_STAFF.find((s) => s.role === 'cashier')!.pin })).sessionId;
  const grid = await panel.feed('catalogue_grid', {}, sid.cashier);
  if (!grid.ok) throw new Error('grid');
  const c = (grid.data as CatalogueGridItem[]).flatMap((g) => g.combinations).find((x) => x.sellable)!;
  ok(await send('cashier', 'orders/quick_sale', { items: [{ combinationId: c.combinationId, qty: 1 }], method: 'cash', expectedTotal: c.price ?? undefined }));
}
/** A backup file the way the backup service makes one, named for the moment it was made. */
async function backupNow(): Promise<string> {
  const file = path.join(dir, 'backups', `cakepos-${stamp(clock.now())}.sqlite`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await db.backupTo(file);
  return file;
}
const orders = () => db.list('orders').then((o) => o.length);
let restoredInfo: { keepUpTo: number; at: string } | null;
function service(over: Partial<Parameters<typeof createRestoreService>[0]> = {}) {
  return createRestoreService({
    store: db,
    backupDir: path.join(dir, 'backups'),
    statePath: path.join(dir, 'restore-state.json'),
    workDir: path.join(dir, 'work'),
    exclusive: (fn) => fn(),
    takeBackup: async () => {
      t += 1000;
      return backupNow();
    },
    log,
    now: clock.now,
    onRestored: (i) => void (restoredInfo = i),
    ...over,
  });
}
const done = async (svc: ReturnType<typeof service>) => {
  for (let i = 0; i < 100; i++) {
    const s = await svc.status();
    if (s.state === 'done' || s.state === 'failed') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the restore never finished');
};

beforeEach(async () => {
  t = Date.UTC(2026, 10, 1, 8, 0, 0);
  restoredInfo = null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  db = openSqliteStore(path.join(dir, 'live.sqlite'));
  panel = createPanel({ store: db, clock });
  await seedDemo(db, panel);
  for (const r of ['owner', 'cashier', 'it']) sid[r] = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: (await staff(r)).id, pin: DEMO_STAFF.find((s) => s.role === r)!.pin })).sessionId;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('restoring a backup', () => {
  it('puts the records back as they were, keeps people and settings as they are now, and explains the gap in the chain', async () => {
    await sell();
    t += 3_600_000;
    const backup = await backupNow(); // the state to go back to
    const file = path.basename(backup);
    const thenOrders = await orders();
    const thenHead = (await db.get<ChainHead>('chainHead', 'head'))!.seq;

    // The next day: more sales, a new person, a changed PIN.
    t += 86_400_000;
    await sell();
    await sell();
    sid.it = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: (await staff('it')).id, pin: '9999' })).sessionId;
    ok(await send('it', 'staff/create', { name: 'Later Person', role: 'cashier', pin: '5555' }));
    ok(await send('it', 'maintenance/set', { on: true, message: 'Restoring' }));
    expect(await orders()).toBe(thenOrders + 2);

    const svc = service();
    const plan = await svc.plan(file);
    expect(plan).toMatchObject({ ok: true, sealedThen: thenHead, ordersSince: 2 });
    expect(plan.discardedRecords).toBeGreaterThan(0);
    expect(plan.discardedDays).toEqual(['2026-11-02']);
    expect((await svc.list()).map((p) => p.file)).toContain(file);

    await svc.start(file, 'Ibrahim (IT)');
    expect((await svc.status()).state).toBe('running');
    const end = await done(svc);
    expect(end).toMatchObject({ state: 'done', discardedDays: ['2026-11-02'] });
    expect(end.message).toMatch(/saved as cakepos-/);

    // The records are back; the people and the pause are as they were.
    expect(await orders()).toBe(thenOrders);
    expect((await db.list<Staff>('staff')).map((s) => s.name)).toContain('Later Person');
    expect((await db.get<{ id: string; on: boolean }>('maintenance', 'state'))?.on).toBe(true);

    // The chain continues from the backup's, with one line that explains what happened, and it all checks out.
    const head = (await db.get<ChainHead>('chainHead', 'head'))!;
    expect(head.seq).toBe(thenHead + 1);
    const lastAudit = (await db.list<{ id: string; at: string; summary: string; role?: string; actorName?: string }>('audit')).sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
    expect(lastAudit).toMatchObject({ role: 'it', actorName: 'Ibrahim (IT)' });
    expect(lastAudit.summary).toMatch(new RegExp(`Restored to backup ${file}.*Removed \\d+ sealed records made on 2026-11-02`));
    expect(await verifyChain({ store: db, ids: createIds(), clock }, { full: true })).toMatchObject({ ok: true, problems: [] });
    expect(restoredInfo?.keepUpTo).toBe(thenHead);

    // The records as they were just before are kept, so the restore can be undone by hand.
    const safety = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f !== file && f.endsWith('.sqlite'));
    expect(safety).toHaveLength(1);
  });

  it('leaves everything untouched when the swap cannot happen', async () => {
    await sell();
    const backup = await backupNow();
    t += 3_600_000;
    await sell();
    const before = await orders();
    const svc = service({
      exclusive: async () => {
        throw new Error('the disk is full');
      },
    });
    await svc.start(path.basename(backup), 'Ibrahim');
    const end = await done(svc);
    expect(end.state).toBe('failed');
    expect(end.message).toMatch(/nothing was changed.*disk is full/i);
    expect(await orders()).toBe(before);
    expect(fs.existsSync(path.join(dir, 'work')) ? fs.readdirSync(path.join(dir, 'work')) : []).toEqual([]);
  });

  it('refuses names that are not backups, damaged files, a second job at once, and remembers a job the restart interrupted', async () => {
    const svc = service();
    expect(await svc.plan('../../etc/passwd')).toMatchObject({ ok: false });
    expect(await svc.plan('cakepos-20250101-000000.sqlite')).toMatchObject({ ok: false, problem: expect.stringMatching(/not one of the backups/) });
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', 'cakepos-20250102-000000.sqlite'), 'this is not a database');
    expect(await svc.plan('cakepos-20250102-000000.sqlite')).toMatchObject({ ok: false });
    expect((await svc.list()).map((p) => p.file)).not.toContain('cakepos-20250102-000000.sqlite');
    const backup = await backupNow();
    await svc.start(path.basename(backup), 'x');
    await expect(svc.start(path.basename(backup), 'x')).rejects.toThrow(/already running/);
    await done(svc);
    fs.writeFileSync(path.join(dir, 'restore-state.json'), JSON.stringify({ state: 'running', file: 'x', startedAt: 'a' }));
    expect((await service().status()).state).toBe('failed');
  });

  it('reads when a backup was made from its name', () => {
    expect(madeAtOf('cakepos-20261101-020000.sqlite')).toBe('2026-11-01T02:00:00.000Z');
    expect(madeAtOf('nope.sqlite')).toBeNull();
  });
});

describe('what the record chain says about a restored backup', () => {
  it('does not report the copy on Drive as a mismatch for records the restore replaced', async () => {
    const { createFingerprintService } = await import('./fingerprint');
    const files: { name: string; createdTime: string }[] = [];
    const client = {
      async ensureFolder() {
        return 'f';
      },
      async upload(a: { name: string }) {
        const f = { id: a.name, name: a.name, createdTime: clock.now().toISOString() };
        files.push(f);
        return f;
      },
      async list() {
        return files;
      },
      async find() {
        return undefined;
      },
      async remove() {},
      async check() {
        return {} as never;
      },
    };
    const fp = createFingerprintService({ store: db, drive: () => ({ client: client as never, folderName: 'Cake POS' }), statePath: path.join(dir, 'fp.json'), log, now: clock.now });
    await sell();
    t += 3_600_000;
    const backup = await backupNow();
    const thenHead = (await db.get<ChainHead>('chainHead', 'head'))!.seq;
    t += 3_600_000;
    await sell();
    expect((await fp.run({ force: true })).state).toBe('ok'); // Drive now holds a fingerprint of the newer records
    t += 3_600_000;
    const svc = service({ onRestored: (i) => fp.noteRestore?.(i) });
    await svc.start(path.basename(backup), 'Ibrahim');
    expect((await done(svc)).state).toBe('done');
    t += 1000;
    const after = await fp.run({ force: true });
    expect(after.problems).toEqual([]);
    expect(after.state).not.toBe('mismatch');
    expect((await db.get<ChainHead>('chainHead', 'head'))!.seq).toBe(thenHead + 1);
    void ({} as RestoreStatus);
  });
});
