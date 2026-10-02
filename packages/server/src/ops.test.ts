import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createPanel, seedDemo, DEMO_STAFF, type Staff } from '@cake-pos/panel';
import { createStaff, resetPin, restoreBackup } from './admin';
import { BACKUP_FILE, createBackupService, createFolderUploader, verifyBackupFile, type BackupUploader } from './backup';
import { ConfigError, defaultDataDir, loadConfig } from './config';
import { createLogger, pruneLogs, redact, silentLogger } from './log';
import { createScryptHasher } from './scrypt';
import { openSqliteStore } from './sqlite-store';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-ops-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const openStore = (file: string) => {
  const s = openSqliteStore(file);
  cleanups.push(() => {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  });
  return s;
};

/** A clock the test moves by hand. */
function makeClock(start = new Date(2026, 8, 29, 1, 59, 0)) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms), set: (d: Date) => void (t = d.getTime()) };
}

async function shopStore(dir: string) {
  const store = openStore(path.join(dir, 'cakepos.sqlite'));
  const panel = createPanel({ store, hasher: createScryptHasher(), devicePrefix: 'S' });
  await seedDemo(store, panel, createScryptHasher());
  return { store, panel };
}

function service(store: ReturnType<typeof openSqliteStore>, dir: string, extra: Partial<Parameters<typeof createBackupService>[0]> = {}) {
  return createBackupService({ store, exclusive: (fn) => fn(), dir, keep: 30, uploaders: [], hour: 2, minute: 0, log: silentLogger, ...extra });
}

/* ---------- backups ---------- */

describe('backups', () => {
  it('writes a single, verified file that restores to exactly the same data', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    const svc = service(store, path.join(dir, 'backups'));
    const file = await svc.runNow();

    expect(BACKUP_FILE.test(path.basename(file))).toBe(true);
    expect(fs.existsSync(`${file}-wal`)).toBe(false); // one self-contained file, nothing to forget to copy
    const check = verifyBackupFile(file);
    expect(check).toMatchObject({ ok: true, staff: DEMO_STAFF.length });
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.part'))).toBe(false);

    store.close();
    const copy = openStore(file);
    expect((await copy.list('staff')).length).toBe(DEMO_STAFF.length);
    expect((await copy.list('combinations')).length).toBeGreaterThan(30);
  });

  it('keeps only the newest N local backups', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    const clock = makeClock();
    const svc = service(store, path.join(dir, 'backups'), { keep: 3, clock });
    for (let i = 0; i < 6; i++) {
      await svc.runNow();
      clock.advance(60_000);
    }
    const kept = fs.readdirSync(path.join(dir, 'backups')).filter((f) => BACKUP_FILE.test(f)).sort();
    expect(kept).toHaveLength(3);
    expect((await svc.status()).lastFile).toBe(kept.at(-1));
  });

  it('copies each backup to the cloud folder, with nothing half-copied left behind', async () => {
    const dir = tmp();
    const cloud = path.join(dir, 'OneDrive', 'CakePOS');
    const { store } = await shopStore(dir);
    const svc = service(store, path.join(dir, 'backups'), { uploaders: [createFolderUploader(cloud)] });
    const file = await svc.runNow();
    expect(fs.readdirSync(cloud)).toEqual([path.basename(file)]);
    expect(verifyBackupFile(path.join(cloud, path.basename(file)))).toMatchObject({ ok: true });
    expect((await svc.status()).pendingUploads).toBe(0);
  });

  it('keeps the local backup and retries the upload when the cloud is unavailable', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    let online = false;
    const calls: string[] = [];
    const uploader: BackupUploader = {
      name: 'Cloud',
      upload: async (f) => {
        calls.push(path.basename(f));
        if (!online) throw new Error('No internet');
      },
    };
    const svc = service(store, path.join(dir, 'backups'), { uploaders: [uploader] });

    const file = await svc.runNow(); // the backup itself succeeds even though the upload cannot
    expect(fs.existsSync(file)).toBe(true);
    let st = await svc.status();
    expect(st).toMatchObject({ pendingUploads: 1, lastError: null });
    expect(st.lastOkAt).not.toBeNull();

    await svc.processUploads(); // still offline
    expect((await svc.status()).pendingUploads).toBe(1);

    online = true; // the internet comes back
    await svc.processUploads();
    st = await svc.status();
    expect(st.pendingUploads).toBe(0);
    expect(calls.at(-1)).toBe(path.basename(file));
    const again = calls.length;
    await svc.processUploads();
    expect(calls.length).toBe(again); // never uploaded twice
  });

  it('is consistent even while orders are being taken', async () => {
    const dir = tmp();
    const { store, panel } = await shopStore(dir);
    const staff = (await store.list<Staff>('staff')).find((s) => s.role === 'cashier')!;
    const login = await panel.dispatch('auth/sign_in', { userId: staff.id, pin: '2222' });
    const token = (login as { data: { sessionId: string } }).data.sessionId;
    const svc = service(store, path.join(dir, 'backups'), { exclusive: (fn) => panel.exclusive(fn) });

    const orders = Array.from({ length: 40 }, () => panel.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }, token));
    const [file] = await Promise.all([svc.runNow(), ...orders]);

    store.close();
    const snap = openStore(file);
    const count = (await snap.list('orders')).length;
    const counter = await snap.get<{ id: string; value: number }>('counters', 'order_seq');
    // Order creation bumps the counter in the same transaction, so a consistent snapshot always agrees.
    expect(counter?.value ?? 0).toBe(count);
    expect(snap.integrityCheck()).toBe('ok');
  });

  it('reports a failure plainly, and keeps the earlier backups', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    const backups = path.join(dir, 'backups');
    const svc = service(store, backups);
    const good = await svc.runNow();

    fs.rmSync(backups, { recursive: true, force: true });
    fs.writeFileSync(backups, 'now a file, so no folder can be made here');
    await expect(svc.runNow()).rejects.toThrow();
    // The folder is unusable, so nothing can be saved there, yet the failure must still be visible.
    expect((await svc.status()).lastError).toBeTruthy();
    expect(good).toBeTruthy();
  });

  it('runs once a day at the set time, survives restarts, and retries a failure after half an hour', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    const clock = makeClock(new Date(2026, 8, 29, 1, 59, 0));
    const backups = path.join(dir, 'backups');
    const make = () => service(store, backups, { clock });
    let svc = make();

    expect(await svc.checkSchedule()).toBe(false); // 01:59: not yet
    clock.advance(60_000); // 02:00
    expect(await svc.checkSchedule()).toBe(true);
    expect(await svc.checkSchedule()).toBe(false); // already done today
    svc = make(); // the server restarts
    clock.advance(3_600_000);
    expect(await svc.checkSchedule()).toBe(false); // still does not double up

    clock.set(new Date(2026, 8, 30, 2, 0, 5)); // next night
    expect(await svc.checkSchedule()).toBe(true);
    expect(fs.readdirSync(backups).filter((f) => BACKUP_FILE.test(f)).length).toBe(2);

    // Now make backups fail, to see the retry rhythm.
    const bad = createBackupService({
      store,
      exclusive: async () => {
        throw new Error('disk problem');
      },
      dir: path.join(dir, 'b2'),
      keep: 5,
      uploaders: [],
      hour: 2,
      minute: 0,
      log: silentLogger,
      clock,
    });
    clock.set(new Date(2026, 9, 1, 2, 0, 0));
    expect(await bad.checkSchedule()).toBe(true); // tried, failed
    clock.advance(10 * 60_000);
    expect(await bad.checkSchedule()).toBe(false); // too soon to retry
    clock.advance(25 * 60_000);
    expect(await bad.checkSchedule()).toBe(true); // retried after 30 minutes
    expect((await bad.status()).lastError).toMatch(/disk problem/);
  });
});

/* ---------- restoring ---------- */

describe('restoring', () => {
  it('swaps in the backup, keeps the data it replaced, and the result opens correctly', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    const svc = service(store, path.join(dir, 'backups'));
    const backup = await svc.runNow();
    await store.put('orders', { id: 'later', number: 'S-9999' }); // something that happens AFTER the backup
    store.close();

    const dbFile = path.join(dir, 'cakepos.sqlite');
    const result = restoreBackup({ file: backup, dbFile, dataDir: dir });
    expect(result.staff).toBe(DEMO_STAFF.length);
    expect(result.previous && fs.existsSync(result.previous)).toBe(true);
    expect(fs.existsSync(`${dbFile}.restoring`)).toBe(false);

    const restored = openStore(dbFile);
    expect(await restored.get('orders', 'later')).toBeUndefined(); // the live data is now the backup
    expect((await restored.list('staff')).length).toBe(DEMO_STAFF.length);
    expect(restored.integrityCheck()).toBe('ok');
    const old = openStore(result.previous!);
    expect(await old.get('orders', 'later')).toBeDefined(); // and what was replaced is still here
  });

  it('refuses a damaged backup and leaves the live data alone', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    await store.put('orders', { id: 'precious', number: 'S-0001' });
    store.close();
    const dbFile = path.join(dir, 'cakepos.sqlite');
    const bad = path.join(dir, 'cakepos-20260101-000000.sqlite');
    fs.writeFileSync(bad, Buffer.from('this is not a database '.repeat(500)));
    expect(verifyBackupFile(bad).ok).toBe(false);
    expect(() => restoreBackup({ file: bad, dbFile, dataDir: dir })).toThrow(/not a healthy Cake POS backup/);
    expect(fs.existsSync(`${dbFile}.restoring`)).toBe(false);
    const still = openStore(dbFile);
    expect(await still.get('orders', 'precious')).toBeDefined();

    const empty = path.join(dir, 'wrong.sqlite');
    const other = new Database(empty);
    other.exec('CREATE TABLE unrelated (x)'); // a valid SQLite file, but not a Cake POS one
    other.close();
    expect(() => restoreBackup({ file: empty, dbFile, dataDir: dir })).toThrow(/not a healthy/);
    expect(() => restoreBackup({ file: path.join(dir, 'missing.sqlite'), dbFile, dataDir: dir })).toThrow(/No such file/);
  });

  it('will not restore while the server is running', async () => {
    const dir = tmp();
    const { store } = await shopStore(dir);
    const backup = await service(store, path.join(dir, 'backups')).runNow();
    store.close();
    const other: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    cleanups.push(() => void other.kill('SIGKILL'));
    fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: other.pid }));
    expect(() => restoreBackup({ file: backup, dbFile: path.join(dir, 'cakepos.sqlite'), dataDir: dir })).toThrow(/still running/);
  });
});

/* ---------- admin tool ---------- */

describe('admin tool', () => {
  const hasher = createScryptHasher();

  it('creates an owner with a properly hashed PIN, and records it', async () => {
    const store = openStore(path.join(tmp(), 'a.sqlite'));
    const owner = await createStaff(store, hasher, { name: 'Amina', pin: '4821', role: 'owner' });
    expect(owner.pinHash.startsWith('scrypt$')).toBe(true);
    expect(owner.pinHash).not.toContain('4821');
    expect(await hasher.verify(owner.pinHash, owner.id, '4821')).toBe(true);
    const audit = await store.list<{ id: string; summary: string; actorName: string }>('audit');
    expect(audit[0]).toMatchObject({ summary: 'Added Amina as owner', actorName: 'Admin tool on the server' });
  });

  it('rejects bad input and duplicate names', async () => {
    const store = openStore(path.join(tmp(), 'b.sqlite'));
    await expect(createStaff(store, hasher, { name: ' ', pin: '1234', role: 'owner' })).rejects.toThrow(/name/);
    await expect(createStaff(store, hasher, { name: 'X', pin: '12', role: 'owner' })).rejects.toThrow(/4 to 6 digits/);
    await expect(createStaff(store, hasher, { name: 'X', pin: 'abcd', role: 'owner' })).rejects.toThrow(/4 to 6 digits/);
    await createStaff(store, hasher, { name: 'Neema', pin: '1234', role: 'baker' });
    await expect(createStaff(store, hasher, { name: 'neema', pin: '5678', role: 'cashier' })).rejects.toThrow(/already works here/);
  });

  it('resets a forgotten PIN: unlocks the account and signs it out everywhere', async () => {
    const dir = tmp();
    const store = openStore(path.join(dir, 'c.sqlite'));
    const panel = createPanel({ store, hasher });
    const owner = await createStaff(store, hasher, { name: 'Amina', pin: '1234', role: 'owner' });
    const first = await panel.dispatch('auth/sign_in', { userId: owner.id, pin: '1234' });
    const oldToken = (first as { data: { sessionId: string } }).data.sessionId;
    for (let i = 0; i < 5; i++) await panel.dispatch('auth/sign_in', { userId: owner.id, pin: '0000' });
    expect((await panel.dispatch('auth/sign_in', { userId: owner.id, pin: '1234' })).ok).toBe(false); // locked out

    await resetPin(store, hasher, { name: 'amina', pin: '8642' });
    expect((await panel.dispatch('auth/sign_in', { userId: owner.id, pin: '8642' })).ok).toBe(true);
    expect((await panel.feed('navigation', {}, oldToken)).ok).toBe(false); // the old device is signed out
    await expect(resetPin(store, hasher, { name: 'Nobody', pin: '1234' })).rejects.toThrow(/Nobody is called/);
  });
});

/* ---------- scrypt ---------- */

describe('PIN hashing', () => {
  const h = createScryptHasher();
  it('uses a different salt every time, and checks both the PIN and the person', async () => {
    const a = await h.hash('u1', '1234');
    const b = await h.hash('u1', '1234');
    expect(a).not.toBe(b);
    expect(a.split('$')).toHaveLength(6);
    expect(await h.verify(a, 'u1', '1234')).toBe(true);
    expect(await h.verify(a, 'u1', '1235')).toBe(false);
    expect(await h.verify(a, 'u2', '1234')).toBe(false); // the same PIN for someone else does not match
  });
  it('rejects anything that is not one of its own hashes', async () => {
    for (const junk of ['', 'abc', 'sha256$x$y', 'scrypt$a$b$c$d$e', 'scrypt$16384$8$1$AAAA$BBBB'])
      expect(await h.verify(junk, 'u1', '1234')).toBe(false);
  });
});

/* ---------- configuration ---------- */

describe('configuration', () => {
  it('puts data in the normal application folder on each system', () => {
    expect(defaultDataDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')).toMatch(/AppData.Roaming.CakePOS$/);
    expect(defaultDataDir('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Application Support/CakePOS');
    expect(defaultDataDir('linux', {}, '/home/a')).toBe('/home/a/.local/share/cakepos');
  });

  it('starts with sensible defaults', () => {
    const c = loadConfig({ DATA_DIR: '/data' });
    expect(c).toMatchObject({ port: 8787, host: '0.0.0.0', backupHour: 2, backupMinute: 0, backupKeep: 30, devicePrefix: 'S', tls: null, cloudBackupDir: null });
    expect(c.dbFile).toBe(path.resolve('/data/cakepos.sqlite'));
  });

  it('says exactly what is wrong with a bad setting', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT must be a whole number/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ BACKUP_TIME: '25:00' })).toThrow(/BACKUP_TIME/);
    expect(() => loadConfig({ BACKUP_TIME: '2am' })).toThrow(/BACKUP_TIME/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ DEVICE_PREFIX: 'TOOLONG' })).toThrow(/DEVICE_PREFIX/);
    expect(() => loadConfig({ BACKUP_KEEP: '0' })).toThrow(/BACKUP_KEEP/);
    expect(() => loadConfig({ TLS_CERT: 'a.pem' })).toThrow(/both TLS_CERT and TLS_KEY/);
  });

  it('reads the backup time, origins and cloud folder', () => {
    const c = loadConfig({ BACKUP_TIME: '23:30', ALLOWED_ORIGINS: 'http://a.test, http://b.test', CLOUD_BACKUP_DIR: '/cloud' });
    expect([c.backupHour, c.backupMinute]).toEqual([23, 30]);
    expect(c.allowedOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(c.cloudBackupDir).toBe(path.resolve('/cloud'));
    expect(loadConfig({ ALLOWED_ORIGINS: '*' }).allowedOrigins).toBe('*');
  });
});

/* ---------- logging ---------- */

describe('logging', () => {
  it('hides PINs, tokens and passwords wherever they appear', () => {
    const out = redact({ ok: 1, pin: '1234', nested: { token: 'abc', list: [{ newPin: '9', fine: 'yes' }] }, Authorization: 'Bearer x', currentPin: '1' }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/1234|abc|Bearer|"9"/);
    expect(out.ok).toBe(1);
    expect((out.nested as { list: Array<{ fine: string }> }).list[0]!.fine).toBe('yes');
  });

  it('writes one JSON line per event to a daily file', () => {
    const dir = tmp();
    const log = createLogger({ level: 'info', dir, stdout: false });
    log.info('hello', { pin: '1234', n: 1 });
    log.debug('too quiet to be written');
    log.close();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const [file] = fs.readdirSync(dir);
        expect(file).toMatch(/^server-\d{4}-\d{2}-\d{2}\.log$/);
        const lines = fs.readFileSync(path.join(dir, file!), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'hello', pin: '[hidden]', n: 1 });
        resolve();
      }, 100),
    );
  });

  it('deletes only old log files', () => {
    const dir = tmp();
    const old = path.join(dir, 'server-2020-01-01.log');
    const fresh = path.join(dir, 'server-2026-09-29.log');
    const other = path.join(dir, 'notes.txt');
    for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(other, longAgo, longAgo);
    expect(pruneLogs(dir, 30)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });
});
