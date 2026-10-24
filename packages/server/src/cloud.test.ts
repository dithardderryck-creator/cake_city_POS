import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupService, createDriveUploader } from './backup';
import { openDrive } from './cloud';
import { loadConfig, ConfigError } from './config';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { createDriveClient, saveDriveCredentials } from './google-drive';
import { silentLogger } from './log';
import { openSqliteStore } from './sqlite-store';

let g: FakeGoogle;
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-cloud-'));
  dirs.push(d);
  return d;
};
beforeEach(async () => (g = await startFakeGoogle()));
afterEach(async () => {
  await g.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const client = () => createDriveClient({ clientId: 'i', clientSecret: 's', refreshToken: 'r', folderName: 'Cake POS' }, { endpoints: g.endpoints });
const backupNames = () => [...g.files.values()].filter((f) => /^cakepos-.*\.sqlite$/.test(f.name)).map((f) => f.name).sort();

function clockAt(start: Date) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

describe('database copy in Google Drive', () => {
  it('uploads each backup to Cake POS / Backups and keeps only the newest few', async () => {
    const dir = tmp();
    const store = openSqliteStore(path.join(dir, 'db.sqlite'));
    const clock = clockAt(new Date(2026, 9, 6, 3, 0, 0));
    const svc = createBackupService({ store, exclusive: (fn) => fn(), dir: path.join(dir, 'b'), keep: 30, uploaders: [createDriveUploader(client(), 'Cake POS', 2)], hour: 2, minute: 0, log: silentLogger, clock });
    for (let i = 0; i < 3; i++) {
      await svc.runNow();
      clock.advance(60_000);
    }
    expect(backupNames()).toHaveLength(2);
    const folders = [...g.files.values()].filter((f) => f.mimeType.endsWith('folder')).map((f) => f.name);
    expect(folders).toEqual(['Cake POS', 'Backups']);
    // The copy in Drive is byte-for-byte the local file.
    const newest = backupNames().pop()!;
    expect(g.files.size).toBeGreaterThan(0);
    const remote = [...g.files.values()].find((f) => f.name === newest)!;
    expect(remote.body.equals(fs.readFileSync(path.join(dir, 'b', newest)))).toBe(true);
    store.close();
  });

  it('waits when there is no internet and uploads later, without losing the backup', async () => {
    const dir = tmp();
    const store = openSqliteStore(path.join(dir, 'db.sqlite'));
    const svc = createBackupService({ store, exclusive: (fn) => fn(), dir: path.join(dir, 'b'), keep: 30, uploaders: [createDriveUploader(client(), 'Cake POS', 10)], hour: 2, minute: 0, log: silentLogger });
    g.failNext(503, 100);
    await svc.runNow();
    expect(backupNames()).toEqual([]);
    expect((await svc.status()).pendingUploads).toBe(1);
    g.failNext(200, 0);
    await svc.processUploads();
    expect(backupNames()).toHaveLength(1);
    expect((await svc.status()).pendingUploads).toBe(0);
    store.close();
  });

  it('also backs up every few hours when asked, not only at night', async () => {
    const dir = tmp();
    const store = openSqliteStore(path.join(dir, 'db.sqlite'));
    const clock = clockAt(new Date(2026, 9, 6, 9, 0, 0));
    const make = (everyHours?: number) => createBackupService({ store, exclusive: (fn) => fn(), dir: path.join(dir, `b${everyHours ?? 0}`), keep: 30, uploaders: [], hour: 2, minute: 0, everyHours, log: silentLogger, clock });
    const nightlyOnly = make();
    const frequent = make(3);
    // First check of the day, after 02:00: both take the daily one.
    expect(await nightlyOnly.checkSchedule()).toBe(true);
    expect(await frequent.checkSchedule()).toBe(true);
    clock.advance(2 * 3_600_000);
    expect(await nightlyOnly.checkSchedule()).toBe(false);
    expect(await frequent.checkSchedule()).toBe(false); // only 2 hours
    clock.advance(1 * 3_600_000 + 60_000);
    expect(await nightlyOnly.checkSchedule()).toBe(false);
    expect(await frequent.checkSchedule()).toBe(true); // 3 hours have passed
    store.close();
  });
});

describe('connecting Drive', () => {
  const cfg = (file: string) => ({ driveFile: file, googleClient: null, googleEndpoints: null });

  it('is simply off when nobody has signed in', () => {
    const dir = tmp();
    const drive = openDrive(cfg(path.join(dir, 'google-drive.json')), silentLogger);
    expect(drive.active()).toBe(false);
    expect(drive.hasAccounts()).toBe(false);
  });

  it('is on once the sign-in file exists (the first, single-account file still works)', async () => {
    const dir = tmp();
    const file = path.join(dir, 'google-drive.json');
    saveDriveCredentials(file, { clientId: 'i', clientSecret: 's', refreshToken: 'r', folderName: 'My Shop', account: 'owner@example.com' });
    const drive = openDrive(cfg(file), silentLogger);
    expect(drive.active()).toBe(true);
    expect(drive.folderName()).toBe('My Shop');
    const st = await drive.terminal.status();
    expect(st.accounts).toMatchObject([{ email: 'owner@example.com', position: 1 }]);
    expect(st.clientFrom).toBe('saved');
  });
});

describe('settings for the online copy', () => {
  it('has safe defaults', () => {
    const c = loadConfig({ DATA_DIR: '/tmp/shop' });
    expect(c).toMatchObject({ backupEveryHours: 0, cloudBackupKeep: 60, archive: { whenFullMb: 500, minAgeDays: 90, activityDays: 365 } });
    expect(c.archiveDir).toBe(path.resolve('/tmp/shop/archive'));
    expect(c.driveFile).toBe(path.resolve('/tmp/shop/google-drive.json'));
  });

  it('lets the owner choose the spreadsheet folder and limits', () => {
    const c = loadConfig({ DATA_DIR: '/tmp/shop', ARCHIVE_DIR: '/mnt/office/cake-archive', ARCHIVE_WHEN_FULL_MB: '200', ARCHIVE_MIN_AGE_DAYS: '30', BACKUP_EVERY_HOURS: '4' });
    expect(c.archiveDir).toBe(path.resolve('/mnt/office/cake-archive'));
    expect(c).toMatchObject({ backupEveryHours: 4, archive: { whenFullMb: 200, minAgeDays: 30 } });
  });

  it('refuses nonsense with a plain message', () => {
    expect(() => loadConfig({ BACKUP_EVERY_HOURS: '30' })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCHIVE_MIN_AGE_DAYS: '0' })).toThrow(/ARCHIVE_MIN_AGE_DAYS/);
  });
});
