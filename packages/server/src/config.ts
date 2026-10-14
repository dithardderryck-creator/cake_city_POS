import os from 'node:os';
import path from 'node:path';
import type { MessagingConfig } from './messaging';

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
  /** The word in front of amounts. CURRENCY_LABEL, default TSh. */
  currencyLabel: string;
  /** Only registered devices may sign in. On unless REQUIRE_DEVICE is 0, false, no or off. */
  requireDevice: boolean;
  backupHour: number;
  backupMinute: number;
  backupKeep: number;
  /** Also back up this often, in hours, so the online copy is never far behind. 0 means nightly only. */
  backupEveryHours: number;
  /** How many backups to keep in Google Drive. */
  cloudBackupKeep: number;
  /** Where the connected Google sign-in is kept. The file only exists once `google-auth` has been run. */
  driveFile: string;
  /** Where archived spreadsheets are kept on this computer. */
  archiveDir: string;
  archive: { whenFullMb: number; minAgeDays: number; activityDays: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Which provider sends SMS and WhatsApp. Both null means texts are off. */
  messaging: MessagingConfig;
  /** An email address (or https address) that phone makers' push services can reach if our messages misbehave. Null turns phone notifications off. */
  pushContact: string | null;
  /** The live online database. Null means the shop runs on this computer alone, with backups. */
  onlineDb: { url: string; token: string } | null;
  /** OFFLINE_MASTER_KEY: the secret offline passes are made from. Optional; when missing, one is made and kept in the database. */
  offlineMasterKey: string | null;
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
    currencyLabel: (env.CURRENCY_LABEL ?? '').trim().slice(0, 8) || 'TSh',
    requireDevice: !/^(0|false|no|off)$/i.test((env.REQUIRE_DEVICE ?? '').trim()),
    backupHour: Number(match[1]),
    backupMinute: Number(match[2]),
    backupKeep: int(env, 'BACKUP_KEEP', 30, 1, 3650),
    backupEveryHours: int(env, 'BACKUP_EVERY_HOURS', 0, 0, 24),
    cloudBackupKeep: int(env, 'CLOUD_BACKUP_KEEP', 60, 1, 3650),
    driveFile: path.join(dataDir, 'google-drive.json'),
    archiveDir: path.resolve(env.ARCHIVE_DIR || path.join(dataDir, 'archive')),
    archive: {
      whenFullMb: int(env, 'ARCHIVE_WHEN_FULL_MB', 500, 1, 1_000_000),
      minAgeDays: int(env, 'ARCHIVE_MIN_AGE_DAYS', 90, 1, 3650),
      activityDays: int(env, 'ARCHIVE_ACTIVITY_DAYS', 365, 30, 3650),
    },
    logLevel: level,
    messaging: loadMessaging(env),
    pushContact: loadPushContact(env),
    onlineDb: loadOnlineDb(env),
    offlineMasterKey: loadMasterKey(env),
  };
}

const need = (env: NodeJS.ProcessEnv, key: string, why: string): string => {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`${key} is needed for ${why}.`);
  return v;
};
const oneOf = (env: NodeJS.ProcessEnv, key: string, allowed: string[]): string => {
  const v = (env[key] ?? 'none').trim().toLowerCase() || 'none';
  if (!['none', ...allowed].includes(v)) throw new ConfigError(`${key} must be one of: none, ${allowed.join(', ')}. Got "${v}".`);
  return v;
};

function loadMessaging(env: NodeJS.ProcessEnv): MessagingConfig {
  const sms = oneOf(env, 'SMS_PROVIDER', ['twilio', 'africastalking', 'webhook']);
  const wa = oneOf(env, 'WHATSAPP_PROVIDER', ['twilio', 'webhook']);
  const out: MessagingConfig = { sms: null, whatsapp: null };
  if (sms === 'twilio') {
    const from = env.TWILIO_SMS_FROM?.trim();
    const service = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    if (!from && !service) throw new ConfigError('Set TWILIO_SMS_FROM (a number or sender name) or TWILIO_MESSAGING_SERVICE_SID for SMS through Twilio.');
    out.sms = { kind: 'twilio', accountSid: need(env, 'TWILIO_ACCOUNT_SID', 'Twilio'), authToken: need(env, 'TWILIO_AUTH_TOKEN', 'Twilio'), from, messagingServiceSid: service };
  } else if (sms === 'africastalking') {
    out.sms = { kind: 'africastalking', username: need(env, 'AT_USERNAME', "Africa's Talking"), apiKey: need(env, 'AT_API_KEY', "Africa's Talking"), senderId: env.AT_SENDER_ID?.trim() || undefined, sandbox: env.AT_SANDBOX === '1' };
  } else if (sms === 'webhook') {
    out.sms = { kind: 'webhook', url: webhookUrl(env), token: env.MESSAGE_WEBHOOK_TOKEN?.trim() || undefined };
  }
  if (wa === 'twilio') {
    const from = need(env, 'TWILIO_WHATSAPP_FROM', 'WhatsApp through Twilio');
    if (!from.startsWith('whatsapp:')) throw new ConfigError('TWILIO_WHATSAPP_FROM must look like whatsapp:+14155238886.');
    out.whatsapp = { kind: 'twilio', accountSid: need(env, 'TWILIO_ACCOUNT_SID', 'Twilio'), authToken: need(env, 'TWILIO_AUTH_TOKEN', 'Twilio'), from };
  } else if (wa === 'webhook') {
    out.whatsapp = { kind: 'webhook', url: webhookUrl(env), token: env.MESSAGE_WEBHOOK_TOKEN?.trim() || undefined };
  }
  return out;
}

function webhookUrl(env: NodeJS.ProcessEnv): string {
  const url = need(env, 'MESSAGE_WEBHOOK_URL', 'the message webhook');
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
  } catch {
    throw new ConfigError('MESSAGE_WEBHOOK_URL must be a web address starting with https:// (or http:// for a service on this network).');
  }
  return url;
}

function loadMasterKey(env: NodeJS.ProcessEnv): string | null {
  const v = env.OFFLINE_MASTER_KEY?.trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9_-]{32,200}={0,2}$/.test(v)) throw new ConfigError('OFFLINE_MASTER_KEY must be at least 32 letters and digits (base64). Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  return v;
}

function loadOnlineDb(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  const url = env.ONLINE_DB_URL?.trim();
  if (!url) return null;
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) throw new ConfigError('ONLINE_DB_URL must start with https:// (http:// is only allowed for localhost).');
  return { url, token: need(env, 'ONLINE_DB_TOKEN', 'ONLINE_DB_URL (the secret the online database expects)') };
}

function loadPushContact(env: NodeJS.ProcessEnv): string | null {
  const v = env.PUSH_CONTACT?.trim();
  if (!v) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (/^https:\/\//.test(v)) return v;
  throw new ConfigError('PUSH_CONTACT must be an email address like shop@example.com (or an https:// address).');
}
