import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { systemClock, type BackupStatus, type BackupTerminal, type Clock } from '@cake-pos/panel';
import { errorFields, type Logger } from './log';
import type { SqliteStore } from './sqlite-store';

export const BACKUP_FILE = /^cakepos-\d{8}-\d{6}\.sqlite$/;

/** Where a finished snapshot goes next. A cloud API would be another implementation of this. */
export interface BackupUploader {
  name: string;
  upload(file: string): Promise<void>;
  prune?(keep: number): Promise<void>;
}

/**
 * Copies snapshots into a folder. Point it at a folder that OneDrive, iCloud Drive, Dropbox or
 * Google Drive syncs, and that app does the uploading whenever the internet is available.
 */
export function createFolderUploader(dir: string, label = 'Cloud folder'): BackupUploader {
  return {
    name: label,
    upload: async (file) => {
      await fs.promises.mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.basename(file));
      const part = `${dest}.part`;
      await fs.promises.copyFile(file, part);
      await fs.promises.rename(part, dest); // the sync app never sees a half-copied file
    },
    prune: async (keep) => {
      const files = (await fs.promises.readdir(dir)).filter((f) => BACKUP_FILE.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) await fs.promises.unlink(path.join(dir, f));
    },
  };
}

/** Open a backup and make sure it is a healthy, complete Cake POS database. */
export function verifyBackupFile(file: string): { ok: true; staff: number } | { ok: false; detail: string } {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { fileMustExist: true });
    // Fold the write-ahead log into the file so a backup is always ONE self-contained file.
    db.pragma('journal_mode = DELETE');
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, detail: `Integrity check said: ${String(integrity)}` };
    const staff = (db.prepare('SELECT count(*) AS n FROM staff').get() as { n: number }).n;
    db.prepare('SELECT count(*) FROM orders').get();
    db.prepare('SELECT count(*) FROM payments').get();
    return { ok: true, staff };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

interface UploadState {
  done: string[];
  attempts: number;
  lastError: string | null;
}
interface BackupState {
  lastOkAt: string | null;
  lastError: string | null;
  lastFile: string | null;
  /** The day (shop local time) of the last backup that SUCCEEDED, so a restart never doubles up. */
  lastAttemptDay: string | null;
  /** When the last failed attempt happened, so failures retry soon but not every few seconds. */
  lastFailAt: string | null;
  uploads: Record<string, UploadState>;
}

export interface BackupService extends BackupTerminal {
  runNow(): Promise<string>;
  /** Run the daily backup if it is due. Called every 30 seconds; exposed so it can be tested. */
  checkSchedule(): Promise<boolean>;
  processUploads(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface BackupOptions {
  store: SqliteStore;
  /** Run while nothing else is reading or writing, so the snapshot is consistent. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  dir: string;
  keep: number;
  uploaders: BackupUploader[];
  hour: number;
  minute: number;
  log: Logger;
  clock?: Clock;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const stamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function createBackupService(o: BackupOptions): BackupService {
  const clock = o.clock ?? systemClock;
  const stateFile = path.join(o.dir, 'backup-state.json');
  let running: Promise<string> | null = null;
  let timers: NodeJS.Timeout[] = [];
  // Failures are also kept in memory. If the backup folder is the thing that broke (disk full, drive
  // unplugged), the state file inside it cannot be written either, and the failure would go unseen.
  let memError: string | null = null;
  let memFailAt: number | null = null;

  const load = (): BackupState => {
    try {
      return { lastOkAt: null, lastError: null, lastFile: null, lastAttemptDay: null, lastFailAt: null, uploads: {}, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
    } catch {
      return { lastOkAt: null, lastError: null, lastFile: null, lastAttemptDay: null, lastFailAt: null, uploads: {} };
    }
  };
  const save = (s: BackupState) => {
    fs.mkdirSync(o.dir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, stateFile);
  };

  async function processUploads() {
    if (o.uploaders.length === 0) return;
    const state = load();
    for (const [file, up] of Object.entries(state.uploads)) {
      const full = path.join(o.dir, file);
      if (!fs.existsSync(full)) {
        delete state.uploads[file]; // pruned locally before it could upload
        continue;
      }
      for (const u of o.uploaders) {
        if (up.done.includes(u.name)) continue;
        try {
          await u.upload(full);
          await u.prune?.(o.keep);
          up.done.push(u.name);
          up.lastError = null;
          o.log.info('Backup uploaded', { file, to: u.name });
        } catch (err) {
          up.attempts++;
          up.lastError = err instanceof Error ? err.message : String(err);
          o.log.warn('Backup upload failed, will retry', { file, to: u.name, ...errorFields(err) });
          break; // no point trying the rest of this file right now
        }
      }
    }
    // Forget files that are fully uploaded, so the state file stays small.
    for (const [file, up] of Object.entries(state.uploads)) {
      if (o.uploaders.every((u) => up.done.includes(u.name))) delete state.uploads[file];
    }
    save(state);
  }

  async function runOnce(): Promise<string> {
    const name = `cakepos-${stamp(clock.now())}.sqlite`;
    const final = path.join(o.dir, name);
    const part = `${final}.part`;
    const state = load();
    try {
      fs.mkdirSync(o.dir, { recursive: true }); // inside the try: an unusable folder is a failure to report, not a crash
      await o.exclusive(() => o.store.backupTo(part));
      const check = verifyBackupFile(part);
      if (!check.ok) throw new Error(`The new backup did not pass its check: ${check.detail}`);
      fs.renameSync(part, final); // atomic: a backup file is either complete or absent
      state.lastOkAt = clock.now().toISOString();
      state.lastAttemptDay = dayKey(clock.now());
      state.lastFailAt = null;
      state.lastError = null;
      memError = null;
      memFailAt = null;
      state.lastFile = name;
      if (o.uploaders.length) state.uploads[name] = { done: [], attempts: 0, lastError: null };
      const files = fs.readdirSync(o.dir).filter((f) => BACKUP_FILE.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - o.keep))) fs.unlinkSync(path.join(o.dir, f));
      save(state);
      o.log.info('Backup written', { file: name });
    } catch (err) {
      // Record the failure FIRST. Nothing in here is allowed to throw before that is done.
      state.lastError = err instanceof Error ? err.message : String(err);
      state.lastFailAt = clock.now().toISOString();
      memError = state.lastError;
      memFailAt = clock.now().getTime();
      try {
        fs.rmSync(part, { force: true });
      } catch {
        /* the folder may be unusable; nothing to clean up */
      }
      try {
        save(state);
      } catch {
        /* the folder may be the problem; memError above still reports it */
      }
      o.log.error('Backup failed', errorFields(err));
      throw err;
    }
    await processUploads();
    return final;
  }

  const runNow = () => (running ??= runOnce().finally(() => (running = null)));

  async function checkSchedule(): Promise<boolean> {
    const now = clock.now();
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), o.hour, o.minute);
    const state = load();
    if (now < due || state.lastAttemptDay === dayKey(now)) return false;
    // After a failure, wait half an hour before trying again instead of retrying every tick.
    const failedAt = memFailAt ?? (state.lastFailAt ? Date.parse(state.lastFailAt) : null);
    if (failedAt !== null && now.getTime() - failedAt < 30 * 60_000) return false;
    await runNow().catch(() => undefined);
    return true;
  }

  return {
    runNow,
    checkSchedule,
    processUploads,
    async status(): Promise<BackupStatus> {
      const s = load();
      const pending = Object.values(s.uploads).filter((u) => !o.uploaders.every((x) => u.done.includes(x.name))).length;
      return { lastOkAt: s.lastOkAt, lastError: memError ?? s.lastError, lastFile: s.lastFile, pendingUploads: pending };
    },
    start() {
      const s = load();
      const stale = !s.lastOkAt || clock.now().getTime() - Date.parse(s.lastOkAt) > 24 * 3_600_000;
      if (stale) timers.push(setTimeout(() => runNow().catch(() => undefined), 10_000));
      timers.push(setInterval(() => void checkSchedule(), 30_000));
      timers.push(setInterval(() => void processUploads(), 10 * 60_000));
      for (const t of timers) t.unref();
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}
