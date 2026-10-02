import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  backupDir: string;
  /** A folder that a cloud sync app (OneDrive, iCloud Drive, Dropbox, Google Drive) uploads for you. */
  cloudBackupDir: string | null;
  /** Browser origins allowed to call the API from another address. Same-address use needs nothing. */
  allowedOrigins: string[] | '*';
  /** Folder of a built UI to serve from the same address, so devices just open the server. */
  staticDir: string | null;
  /** Paths to a certificate and key. Needed for installable-app features on other devices (see the runbook). */
  tls: { cert: string; key: string } | null;
  devicePrefix: string;
  backupHour: number;
  backupMinute: number;
  backupKeep: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

/** Where the shop's data lives by default: a normal per-user application folder on each system. */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'CakePOS');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CakePOS');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'cakepos');
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be a whole number from ${min} to ${max}. Got "${raw}".`);
  return n;
}

/** Read settings from environment variables, failing early with a plain message if one is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = path.resolve(env.DATA_DIR || defaultDataDir());
  const time = env.BACKUP_TIME ?? '02:00';
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new ConfigError(`BACKUP_TIME must look like 02:00 (24-hour, shop local time). Got "${time}".`);

  const origins = env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173';
  const level = (env.LOG_LEVEL ?? 'info') as ServerConfig['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error. Got "${level}".`);

  const prefix = (env.DEVICE_PREFIX ?? 'S').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(prefix)) throw new ConfigError(`DEVICE_PREFIX must be 1 to 3 letters. Got "${prefix}".`);

  return {
    port: int(env, 'PORT', 8787, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'cakepos.sqlite'),
    backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
    cloudBackupDir: env.CLOUD_BACKUP_DIR ? path.resolve(env.CLOUD_BACKUP_DIR) : null,
    allowedOrigins: origins.trim() === '*' ? '*' : origins.split(',').map((o) => o.trim()).filter(Boolean),
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
    tls:
      env.TLS_CERT && env.TLS_KEY
        ? { cert: path.resolve(env.TLS_CERT), key: path.resolve(env.TLS_KEY) }
        : (() => {
            if (env.TLS_CERT || env.TLS_KEY) throw new ConfigError('Set both TLS_CERT and TLS_KEY, or neither.');
            return null;
          })(),
    devicePrefix: prefix,
    backupHour: Number(match[1]),
    backupMinute: Number(match[2]),
    backupKeep: int(env, 'BACKUP_KEEP', 30, 1, 3650),
    logLevel: level,
  };
}
