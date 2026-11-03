import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appendAudit, COLLECTIONS, createIds, todayLocal, type ChainHead, type RestorePlan, type RestorePoint, type RestoreStatus, type RestoreTerminal } from '@cake-pos/panel';
import { BACKUP_FILE } from './backup';
import { errorFields, type Logger } from './log';
import { openSqliteStore, type SqliteStore } from './sqlite-store';

/**
 * Putting a backup back in place of the shop's records, from the IT page.
 *
 * It runs as a job just after the request, because it must take a fresh copy of the current records first (the backup
 * service needs the panel's turn, which the request is still holding) and then replace the records in ONE turn, in
 * one transaction, so a failure leaves everything exactly as it was.
 *
 * What is NOT put back: the people and their access (staff, PINs, sign-ins, devices, pairing codes), the shop's own settings,
 * the server's keys, the offline passes and logs, the "selling is paused" switch, and the queues that feed the online
 * database. Everything else (orders, payments, stock, catalogue, records, alerts) comes from the backup.
 */
const KEEP_LIVE: ReadonlySet<string> = new Set([
  'staff',
  'devices',
  'pairingCodes',
  'sessions',
  'loginState',
  'pushSubscriptions',
  'serverKeys',
  'offlinePasses',
  'offlineLog',
  'maintenance',
  'outbox',
  'changes',
  'settings',
]);

export interface RestoreOptions {
  store: SqliteStore;
  backupDir: string;
  /** Where the job's last result is kept, so it survives a restart. */
  statePath: string;
  /** A scratch folder for the working copy of the backup. */
  workDir: string;
  /** Runs one thing while nothing else touches the records. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Takes a backup of the current records and returns its path. */
  takeBackup: () => Promise<string>;
  log: Logger;
  now?: () => Date;
  /** The records after this many sealed ones were replaced at this moment (so the copy on Drive can tell). */
  onRestored?: (info: { keepUpTo: number; at: string }) => void;
}

const IDLE: RestoreStatus = { state: 'idle', file: null, startedAt: null, finishedAt: null, message: null, discardedDays: [] };

/** `cakepos-20261101-020000.sqlite` was made at 02:00:00 UTC on 1 November 2026. */
export function madeAtOf(file: string): string | null {
  const m = /^cakepos-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sqlite$/.exec(file);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)).toISOString() : null;
}

/** The sealed-record count and last activity inside a backup, read without changing the file. */
function peek(full: string): { sealed: number; lastAt: string | null; staff: number; healthy: boolean } | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(full, { readonly: true, fileMustExist: true });
    const q = (sql: string) => {
      try {
        return db!.prepare(sql).get() as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    };
    const head = q(`SELECT json_extract(data,'$.seq') AS n FROM "chainHead" WHERE id='head'`);
    const last = q(`SELECT max(json_extract(data,'$.at')) AS at FROM "audit"`);
    const staff = q(`SELECT count(*) AS n FROM "staff"`);
    const quick = db.pragma('quick_check', { simple: true });
    return { sealed: Number(head?.n ?? 0), lastAt: (last?.at as string | null) ?? null, staff: Number(staff?.n ?? 0), healthy: quick === 'ok' };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function createRestoreService(o: RestoreOptions): RestoreTerminal {
  const now = o.now ?? (() => new Date());
  const ids = createIds();
  let running = false;

  const read = (): RestoreStatus => {
    try {
      const s = { ...IDLE, ...(JSON.parse(fs.readFileSync(o.statePath, 'utf8')) as Partial<RestoreStatus>) };
      // A job that was running when the server stopped changed nothing: the swap is all or nothing.
      if (s.state === 'running' && !running) return { ...s, state: 'failed', finishedAt: s.finishedAt ?? now().toISOString(), message: 'The server stopped before the restore finished. Nothing was changed.' };
      return s;
    } catch {
      return IDLE;
    }
  };
  const write = (s: RestoreStatus) => {
    try {
      fs.mkdirSync(path.dirname(o.statePath), { recursive: true });
      fs.writeFileSync(o.statePath, JSON.stringify(s));
    } catch (err) {
      o.log.warn('Could not save the restore state', errorFields(err));
    }
  };

  const fullPath = (file: string) => path.join(o.backupDir, file);

  async function list(): Promise<RestorePoint[]> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(o.backupDir).filter((f) => BACKUP_FILE.test(f));
    } catch {
      return [];
    }
    const out: RestorePoint[] = [];
    for (const file of names) {
      const p = peek(fullPath(file));
      if (!p || !p.healthy) continue;
      out.push({ file, madeAt: madeAtOf(file)!, sizeKb: Math.round(fs.statSync(fullPath(file)).size / 1024), sealed: p.sealed });
    }
    return out;
  }

  async function plan(file: string): Promise<RestorePlan> {
    const base: RestorePlan = { ok: false, problem: null, file, madeAt: null, sealedThen: 0, sealedNow: 0, discardedRecords: 0, discardedDays: [], ordersSince: 0, paymentsSince: 0 };
    if (!BACKUP_FILE.test(file) || !fs.existsSync(fullPath(file))) return { ...base, problem: 'That is not one of the backups on this server.' };
    const p = peek(fullPath(file));
    if (!p || !p.healthy) return { ...base, problem: 'That backup did not pass its health check, so it cannot be used.' };
    if (p.staff === 0) return { ...base, problem: 'That backup holds no staff, so it does not look like a shop backup.' };
    const madeAt = madeAtOf(file)!;
    const head = await o.store.get<ChainHead>('chainHead', 'head');
    const sealedNow = head?.seq ?? 0;
    const after = p.lastAt && p.lastAt > madeAt ? p.lastAt : madeAt;
    const days = new Set<string>();
    for (const r of o.store.db.prepare(`SELECT json_extract(data,'$.at') AS at FROM "audit" WHERE json_extract(data,'$.at') > ?`).all(after) as Array<{ at: string }>) days.add(todayLocal(new Date(r.at)));
    const count = (table: string, field: string) => Number((o.store.db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE json_extract(data,'$.${field}') > ?`).get(madeAt) as { n: number }).n);
    return {
      ...base,
      ok: true,
      madeAt,
      sealedThen: p.sealed,
      sealedNow,
      discardedRecords: Math.max(0, sealedNow - p.sealed),
      discardedDays: [...days].sort().reverse().slice(0, 14),
      ordersSince: count('orders', 'createdAt'),
      paymentsSince: count('payments', 'receivedAt'),
    };
  }

  /** Replaces the records in one transaction, in the panel's own turn. Returns what was removed. */
  async function swap(work: string, file: string, by: string): Promise<{ keepUpTo: number; days: string[]; removed: number }> {
    const bk = openSqliteStore(work); // opening it brings an older backup up to the current layout
    try {
      if (bk.integrityCheck() !== 'ok') throw new Error('The working copy of the backup did not pass its health check.');
      const keepUpTo = Number((bk.db.prepare(`SELECT json_extract(data,'$.seq') AS n FROM "chainHead" WHERE id='head'`).get() as { n?: number } | undefined)?.n ?? 0);
      const lastAt = (bk.db.prepare(`SELECT max(json_extract(data,'$.at')) AS at FROM "audit"`).get() as { at: string | null }).at;
      const madeAt = madeAtOf(file)!;
      const after = lastAt && lastAt > madeAt ? lastAt : madeAt;
      const head = await o.store.get<ChainHead>('chainHead', 'head');
      const removed = Math.max(0, (head?.seq ?? 0) - keepUpTo);
      const days = new Set<string>();
      for (const r of o.store.db.prepare(`SELECT json_extract(data,'$.at') AS at FROM "audit" WHERE json_extract(data,'$.at') > ?`).all(after) as Array<{ at: string }>) days.add(todayLocal(new Date(r.at)));
      const dayList = [...days].sort();
      const at = now().toISOString();
      await o.store.transaction(async () => {
        for (const c of COLLECTIONS) {
          if (KEEP_LIVE.has(c)) continue;
          o.store.db.exec(`DELETE FROM "${c}"`);
          const put = o.store.db.prepare(`INSERT INTO "${c}"(id, data) VALUES (?, ?)`);
          for (const row of bk.db.prepare(`SELECT id, data FROM "${c}"`).iterate() as Iterable<{ id: string; data: string }>) put.run(row.id, row.data);
        }
        // The old answers belong to records that are gone. The next check starts again from the restored chain.
        o.store.db.exec(`DELETE FROM "chainChecks"`);
        const when = `${todayLocal(new Date(madeAt))}`;
        await appendAudit(
          { store: o.store, ids, clock: { now } },
          {
            actorName: by,
            role: 'it',
            intent: 'restore/run',
            target: file,
            summary: `Restored to backup ${file} (made ${when}). Removed ${removed} sealed records${dayList.length ? ` made on ${dayList.join(', ')}` : ''}`,
            outcome: 'ok',
          },
          at,
        );
      });
      return { keepUpTo, days: dayList, removed };
    } finally {
      bk.close();
    }
  }

  async function job(file: string, by: string): Promise<void> {
    const startedAt = now().toISOString();
    const work = path.join(o.workDir, `restoring-${Date.now()}.sqlite`);
    const clean = () => {
      for (const ext of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${work}${ext}`, { force: true });
    };
    try {
      fs.mkdirSync(o.workDir, { recursive: true });
      // A working copy first: taking the safety backup below may delete the oldest backup, which could be this one.
      fs.copyFileSync(fullPath(file), work);
      const safety = await o.takeBackup();
      const r = await o.exclusive(() => swap(work, file, by));
      o.onRestored?.({ keepUpTo: r.keepUpTo, at: now().toISOString() });
      o.log.info('Records restored from a backup', { file, safety: path.basename(safety), removed: r.removed });
      write({
        state: 'done',
        file,
        startedAt,
        finishedAt: now().toISOString(),
        message: `Restored. The records as they were just before are saved as ${path.basename(safety)}. Selling is still paused: resume it when you are ready.`,
        discardedDays: r.days,
      });
    } catch (err) {
      o.log.error('Restoring a backup failed', errorFields(err));
      write({ state: 'failed', file, startedAt, finishedAt: now().toISOString(), message: `The restore did not happen and nothing was changed. ${err instanceof Error ? err.message : ''}`.trim(), discardedDays: [] });
    } finally {
      clean();
      running = false;
    }
  }

  return {
    list,
    plan,
    status: async () => read(),
    async start(file, by) {
      if (running) throw new Error('A restore is already running.');
      const p = await plan(file);
      if (!p.ok) throw new Error(p.problem ?? 'That backup cannot be used.');
      running = true;
      write({ state: 'running', file, startedAt: now().toISOString(), finishedAt: null, message: null, discardedDays: [] });
      // After this request has finished: the safety backup needs the panel's turn, which the request still holds.
      setTimeout(() => void job(file, by), 50);
    },
  };
}
