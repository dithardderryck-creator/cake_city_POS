import fs from 'node:fs';
import os from 'node:os';
import { createPanel, type Panel, type PinHasher, type Terminals } from '@cake-pos/panel';
import { createBackupService, createFolderUploader, type BackupService } from './backup';
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
  addresses: string[];
  close(): Promise<void>;
}

export interface StartOptions {
  config: ServerConfig;
  log: Logger;
  hasher?: PinHasher;
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

export async function startServer({ config, log, hasher }: StartOptions): Promise<RunningServer> {
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

    const backup = createBackupService({
      store: db,
      exclusive: (fn) => panel.exclusive(fn),
      dir: config.backupDir,
      keep: config.backupKeep,
      uploaders: config.cloudBackupDir ? [createFolderUploader(config.cloudBackupDir)] : [],
      hour: config.backupHour,
      minute: config.backupMinute,
      log,
    });
    terminals.backup = backup;

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
      ],
    };

    const port = await http.listen(config.port, config.host);
    backup.start();
    const maintain = () =>
      panel
        .maintain()
        .then((r) => (r.sessionsPruned || r.requestsPruned || r.photosPruned || r.alertsPruned) && log.info('Housekeeping', r))
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

    const addresses = lanAddresses();
    log.info('Server started', { port, host: config.host, dataDir: config.dataDir, version: VERSION });

    let closing: Promise<void> | null = null;
    return {
      url: `${scheme}://127.0.0.1:${port}`,
      port,
      panel,
      store: db,
      backup,
      addresses,
      close: () =>
        (closing ??= (async () => {
          clearInterval(timer);
          clearInterval(alertTimer);
          backup.stop();
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
