import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessenger } from './messaging';
import { createPushTerminal, loadOrCreateVapid } from './push';
import { appendAudit, createIds, createPanel, type Panel, type PinHasher, type Terminals } from '@cake-pos/panel';
import { createArchiveService, type ArchiveService } from './archive';
import { createFingerprintService } from './fingerprint';
import { createRestoreService } from './restore';
import { createBackupService, createDriveUploader, createFolderUploader, type BackupService, type BackupUploader } from './backup';
import { createHttpSyncTerminal } from './online-sync';
import { openDrive } from './cloud';
import type { DriveAccounts } from './drive-accounts';
import type { DriveDeps } from './google-drive';
import type { ServerConfig } from './config';
import { createAssistant } from './assistant';
import { createHttpServer } from './http';
import { acquireLock } from './lock';
import { errorFields, readRecentLogs, type Logger } from './log';
import { createScryptHasher } from './scrypt';
import { prepareTestCopy, testCopyBanner } from './test-copy';
import { openSqliteStore, SCHEMA_VERSION, type SqliteStore } from './sqlite-store';

export const VERSION = '0.2.0';

export interface RunningServer {
  url: string;
  port: number;
  panel: Panel;
  store: SqliteStore;
  backup: BackupService;
  archive: ArchiveService;
  /** The shop's Google accounts (none connected is a normal state). */
  drive: DriveAccounts;
  addresses: string[];
  /** Test copies only: the one-time first-device code. */
  testCopy?: { code: string; seeded: boolean };
  close(): Promise<void>;
}

export interface StartOptions {
  config: ServerConfig;
  log: Logger;
  hasher?: PinHasher;
  /** For tests: point Google Drive at a stand-in. */
  driveDeps?: DriveDeps;
}

export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const duration = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
};

export async function startServer({ config, log, hasher, driveDeps }: StartOptions): Promise<RunningServer> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
  const release = acquireLock(config.dataDir);

  let store: SqliteStore | undefined;
  try {
    store = openSqliteStore(config.dbFile);
    const db = store;
    const hasherInUse = hasher ?? createScryptHasher();
    const testCopy = config.testCopy ? await prepareTestCopy({ store: db, hasher: hasherInUse, log }) : undefined;
    if (testCopy) for (const line of testCopyBanner(testCopy)) console.log(line);
    const terminals: Terminals = {};
    const panel = createPanel({
      store: db,
      hasher: hasherInUse,
      devicePrefix: config.devicePrefix,
      currencyLabel: config.currencyLabel,
      requireDevice: config.requireDevice,
      offlineMasterKey: config.offlineMasterKey ?? undefined,
      terminals,
      onError: (err, info) => log.error('Unexpected failure inside the panel', { ...info, ...errorFields(err) }),
    });

    // Google Drive is optional. Any number of accounts can be signed in from the Owner or IT screen; backups and archives
    // go to the first one with room whenever wifi allows, and every upload simply waits and retries if the internet is down.
    const drive = openDrive(config, log, {
      ...(driveDeps ? { deps: driveDeps } : {}),
      // A newly connected account gets a copy straight away instead of waiting for tonight's backup.
      onConnected: () => void backup.runNow().catch(() => undefined),
    });
    terminals.drive = drive.terminal;
    const uploaders: BackupUploader[] = [];
    if (config.cloudBackupDir) uploaders.push(createFolderUploader(config.cloudBackupDir));
    uploaders.push(createDriveUploader(drive.client, drive.folderName, config.cloudBackupKeep, () => drive.active()));
    const backup = createBackupService({
      store: db,
      exclusive: (fn) => panel.exclusive(fn),
      dir: config.backupDir,
      keep: config.backupKeep,
      uploaders,
      hour: config.backupHour,
      minute: config.backupMinute,
      everyHours: config.backupEveryHours,
      log,
    });
    terminals.backup = backup;
    if (config.onlineDb) terminals.sync = createHttpSyncTerminal({ ...config.onlineDb, deviceId: config.devicePrefix });

    const archive = createArchiveService({
      store: db,
      exclusive: (fn) => panel.exclusive(fn),
      dir: config.archiveDir,
      statePath: path.join(config.dataDir, 'archive-state.json'),
      drive: () => (drive.active() ? { client: drive.client, folderName: drive.folderName() } : null),
      backupNow: () => backup.runNow(),
      usedBytes: () => db.usedBytes(),
      settings: { whenFullBytes: config.archive.whenFullMb * 1_048_576, minAgeDays: config.archive.minAgeDays, auditKeepDays: config.archive.activityDays },
      log,
    });

    // A second copy of the record chain's newest fingerprint on Drive, compared with the records every few hours.
    const fpIds = createIds();
    const fingerprint = createFingerprintService({
      store: db,
      drive: () => (drive.active() ? { client: drive.client, folderName: drive.folderName() } : null),
      statePath: path.join(config.dataDir, 'fingerprint-state.json'),
      log,
      audit: (summary, outcome) =>
        panel.exclusive(() => appendAudit({ store: db, ids: fpIds, clock: { now: () => new Date() } }, { actorName: 'The system', intent: 'records/drive_check', summary, outcome })),
    });
    terminals.fingerprint = fingerprint;

    // Putting a backup back, from the IT page: a job that takes a safety backup first and then swaps the records in one turn.
    terminals.restore = createRestoreService({
      store: db,
      backupDir: config.backupDir,
      statePath: path.join(config.dataDir, 'restore-state.json'),
      workDir: path.join(config.dataDir, 'restore-work'),
      exclusive: (fn) => panel.exclusive(fn),
      takeBackup: () => backup.runNow(),
      log,
      onRestored: (info) => {
        fingerprint.noteRestore?.(info);
        panel.refresh();
      },
    });

    // Texts and phone notifications. Each is optional; the panel says plainly when one is not set up.
    const messenger = createMessenger(config.messaging);
    if (messenger) terminals.messages = messenger;
    if (config.pushContact) terminals.push = createPushTerminal({ keys: await loadOrCreateVapid(db), contact: config.pushContact });
    const describeMessaging = () => {
      const ch = messenger?.channels() ?? [];
      return [ch.includes('sms') ? `SMS (${config.messaging.sms?.kind})` : null, ch.includes('whatsapp') ? `WhatsApp (${config.messaging.whatsapp?.kind})` : null, terminals.push ? 'phone notifications' : null].filter(Boolean).join(', ') || 'none set up';
    };

    const driveLine = async () => {
      const st = await drive.terminal.status();
      if (st.accounts.length === 0) return 'not connected';
      const working = st.accounts.filter((a) => a.state === 'ok').length;
      const attention = st.accounts.filter((a) => a.state !== 'ok' && a.state !== 'paused').length;
      return `${st.accounts.length} connected, ${working} working${attention ? `, ${attention} need attention` : ''}: ${st.accounts.map((a) => a.email ?? a.id).join(', ')}`;
    };
    const archiveLine = () => {
      const a = archive.status();
      return `${a.usedMb} MB used of ${a.whenFullMb} MB; ${a.totalOrdersArchived} orders archived${a.lastError ? `; last problem: ${a.lastError}` : ''}`;
    };
    const assistant = createAssistant({ config: config.assistant, panel, log });
    const http = createHttpServer({ panel, log, config, version: VERSION, assistant });
    const scheme = config.tls ? 'https' : 'http';
    terminals.logs = { recent: async (o) => readRecentLogs(path.join(config.dataDir, 'logs'), o) };
    terminals.system = {
      space: async () => {
        try {
          const st = fs.statfsSync(config.dataDir);
          return { freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
        } catch {
          return null;
        }
      },
      info: async () => [
        { label: 'Version', value: VERSION },
        { label: 'Uptime', value: duration(process.uptime()) },
        { label: 'Node', value: process.version },
        { label: 'System', value: `${os.platform()} ${os.arch()}` },
        { label: 'Database', value: `${(db.sizeBytes() / 1_048_576).toFixed(1)} MB, schema ${SCHEMA_VERSION}` },
        { label: 'Live connections', value: String(http.clientCount()) },
        { label: 'Addresses', value: lanAddresses().join(', ') || 'none found' },
        { label: 'Data folder', value: config.dataDir },
        { label: 'Google Drive', value: await driveLine() },
        { label: 'Archive', value: archiveLine() },
        { label: 'Alerts reach people by', value: `in-app, ${describeMessaging()}` },
      ],
    };

    const port = await http.listen(config.port, config.host);
    backup.start();
    // Look at the Google accounts now and every half hour, so a full or signed-out account is noticed before an upload needs it.
    const driveCheck = () => (drive.hasAccounts() ? drive.refresh().catch((err) => log.warn('Checking the Google accounts failed', errorFields(err))) : Promise.resolve());
    void driveCheck();
    const driveTimer = setInterval(() => void driveCheck(), 30 * 60_000);
    driveTimer.unref();
    archive.start();
    const fingerprintRun = () => (drive.active() ? fingerprint.run().catch((err) => log.warn('Comparing the records with Drive failed', errorFields(err))) : Promise.resolve());
    void fingerprintRun();
    const fingerprintTimer = setInterval(() => void fingerprintRun(), 10 * 60_000);
    fingerprintTimer.unref();
    const maintain = () =>
      panel
        .maintain()
        .then((r) => (r.sessionsPruned || r.requestsPruned || r.photosPruned || r.alertsPruned || r.syncPruned) && log.info('Housekeeping', r))
        .catch((err) => log.error('Housekeeping failed', errorFields(err)));
    void maintain();
    const timer = setInterval(maintain, 3_600_000);
    timer.unref();
    // Alerts depend on the clock too (a cake becomes late, a report waits too long), so they are re-checked every minute.
    const tick = () =>
      panel
        .tick()
        .then((r) => (r.raised || r.resolved) && log.info('Alerts checked', r))
        .catch((err) => log.error('Alert check failed', errorFields(err)));
    void tick();
    const alertTimer = setInterval(tick, 60_000);
    alertTimer.unref();
    // Notifications go out every few seconds. A provider that is slow or down never holds up the shop (see panel.deliver).
    const deliver = () =>
      panel
        .deliver()
        .then((r) => (r.sent || r.failed || r.retrying) && log.info('Notifications', r))
        .catch((err) => log.error('Sending notifications failed', errorFields(err)));
    const deliverTimer = setInterval(deliver, 10_000);
    deliverTimer.unref();
    // Changes go to the online database every few seconds. If it is down they wait here, in order, and nothing is lost.
    let lastSyncError = '';
    const syncOnline = () =>
      panel
        .syncNow()
        .then((r) => {
          if (r.state === 'sent') log.info('Online database', { sent: r.sent });
          if (r.state === 'failed' && r.error !== lastSyncError) log.warn('Online database did not accept changes', { error: r.error, waiting: r.pending });
          lastSyncError = r.state === 'failed' ? (r.error ?? '') : '';
        })
        .catch((err) => log.error('Online sync failed', errorFields(err)));
    const syncTimer = config.onlineDb ? setInterval(syncOnline, 10_000) : null;
    syncTimer?.unref();

    const addresses = lanAddresses();
    log.info('Server started', { port, host: config.host, dataDir: config.dataDir, version: VERSION });

    let closing: Promise<void> | null = null;
    return {
      url: `${scheme}://127.0.0.1:${port}`,
      port,
      panel,
      store: db,
      backup,
      archive,
      drive,
      addresses,
      testCopy,
      close: () =>
        (closing ??= (async () => {
          clearInterval(timer);
          clearInterval(alertTimer);
          clearInterval(deliverTimer);
          clearInterval(driveTimer);
          clearInterval(fingerprintTimer);
          if (syncTimer) clearInterval(syncTimer);
          backup.stop();
          archive.stop();
          await http.close(); // stop taking new requests
          await panel.exclusive(async () => undefined); // let anything already running finish
          db.close();
          release();
          log.info('Server stopped');
        })()),
    };
  } catch (err) {
    store?.close();
    release();
    throw err;
  }
}
