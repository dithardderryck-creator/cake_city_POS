import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessenger } from './messaging';
import { createPushTerminal, loadOrCreateVapid } from './push';
import { createPanel, type Panel, type PinHasher, type Terminals } from '@cake-pos/panel';
import { createArchiveService, type ArchiveService } from './archive';
import { createBackupService, createDriveUploader, createFolderUploader, type BackupService, type BackupUploader } from './backup';
import { loadCloud, type Cloud } from './cloud';
import type { DriveDeps } from './google-drive';
import type { ServerConfig } from './config';
import { createHttpServer } from './http';
import { acquireLock } from './lock';
import { errorFields, type Logger } from './log';
import { createScryptHasher } from './scrypt';
import { openSqliteStore, SCHEMA_VERSION, type SqliteStore } from './sqlite-store';

export const VERSION = '0.2.0';

export interface RunningServer {
  url: string;
  port: number;
  panel: Panel;
  store: SqliteStore;
  backup: BackupService;
  archive: ArchiveService;
  /** Null when Google Drive has not been connected. */
  cloud: Cloud | null;
  addresses: string[];
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
    const terminals: Terminals = {};
    const panel = createPanel({
      store: db,
      hasher: hasher ?? createScryptHasher(),
      devicePrefix: config.devicePrefix,
      terminals,
      onError: (err, info) => log.error('Unexpected failure inside the panel', { ...info, ...errorFields(err) }),
    });

    // Google Drive is optional. When the shop has signed in to it, backups and archives go there whenever wifi allows,
    // and every upload simply waits and retries if the internet is down.
    let cloud: Cloud | null = null;
    try {
      cloud = loadCloud(config, driveDeps);
    } catch (err) {
      log.error('Google Drive sign-in could not be read, so Drive is off until it is fixed', errorFields(err));
    }
    const uploaders: BackupUploader[] = [];
    if (config.cloudBackupDir) uploaders.push(createFolderUploader(config.cloudBackupDir));
    if (cloud) uploaders.push(createDriveUploader(cloud.client, cloud.folderName, config.cloudBackupKeep));
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

    const archive = createArchiveService({
      store: db,
      exclusive: (fn) => panel.exclusive(fn),
      dir: config.archiveDir,
      statePath: path.join(config.dataDir, 'archive-state.json'),
      drive: cloud ? { client: cloud.client, folderName: cloud.folderName } : null,
      backupNow: () => backup.runNow(),
      usedBytes: () => db.usedBytes(),
      settings: { whenFullBytes: config.archive.whenFullMb * 1_048_576, minAgeDays: config.archive.minAgeDays, auditKeepDays: config.archive.activityDays },
      log,
    });

    // Texts and phone notifications. Each is optional; the panel says plainly when one is not set up.
    const messenger = createMessenger(config.messaging);
    if (messenger) terminals.messages = messenger;
    if (config.pushContact) terminals.push = createPushTerminal({ keys: await loadOrCreateVapid(db), contact: config.pushContact });
    const describeMessaging = () => {
      const ch = messenger?.channels() ?? [];
      return [ch.includes('sms') ? `SMS (${config.messaging.sms?.kind})` : null, ch.includes('whatsapp') ? `WhatsApp (${config.messaging.whatsapp?.kind})` : null, terminals.push ? 'phone notifications' : null].filter(Boolean).join(', ') || 'none set up';
    };

    const archiveLine = () => {
      const a = archive.status();
      return `${a.usedMb} MB used of ${a.whenFullMb} MB; ${a.totalOrdersArchived} orders archived${a.lastError ? `; last problem: ${a.lastError}` : ''}`;
    };
    const http = createHttpServer({ panel, log, config, version: VERSION });
    const scheme = config.tls ? 'https' : 'http';
    terminals.system = {
      info: async () => [
        { label: 'Version', value: VERSION },
        { label: 'Uptime', value: duration(process.uptime()) },
        { label: 'Node', value: process.version },
        { label: 'System', value: `${os.platform()} ${os.arch()}` },
        { label: 'Database', value: `${(db.sizeBytes() / 1_048_576).toFixed(1)} MB, schema ${SCHEMA_VERSION}` },
        { label: 'Live connections', value: String(http.clientCount()) },
        { label: 'Addresses', value: lanAddresses().join(', ') || 'none found' },
        { label: 'Data folder', value: config.dataDir },
        { label: 'Google Drive', value: cloud ? `connected${cloud.account ? ` as ${cloud.account}` : ''}, folder "${cloud.folderName}"` : 'not connected' },
        { label: 'Archive', value: archiveLine() },
        { label: 'Alerts reach people by', value: `in-app, ${describeMessaging()}` },
      ],
    };

    const port = await http.listen(config.port, config.host);
    backup.start();
    archive.start();
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
      cloud,
      addresses,
      close: () =>
        (closing ??= (async () => {
          clearInterval(timer);
          clearInterval(alertTimer);
          clearInterval(deliverTimer);
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
