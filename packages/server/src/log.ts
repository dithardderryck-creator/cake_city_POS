import fs from 'node:fs';
import path from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /pin|token|authorization|password|secret|cookie/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  close(): void;
}

/** Anything that looks like a PIN, token or password is replaced before it can reach a log file. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET.test(k) ? '[hidden]' : redact(v, depth + 1)]));
}

export function errorFields(err: unknown): Record<string, unknown> {
  return err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
}

export function pruneLogs(dir: string, keepDays: number, now = Date.now()) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^server-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
    const full = path.join(dir, f);
    if (now - fs.statSync(full).mtimeMs > keepDays * 86_400_000) {
      fs.unlinkSync(full);
      removed++;
    }
  }
  return removed;
}

export function createLogger(options: { level: Level; dir?: string; stdout?: boolean }): Logger {
  const { level, dir, stdout = true } = options;
  let stream: fs.WriteStream | null = null;
  let streamDay = '';

  const fileFor = (day: string) => {
    if (!dir) return null;
    if (stream && streamDay === day) return stream;
    stream?.end();
    fs.mkdirSync(dir, { recursive: true });
    streamDay = day;
    stream = fs.createWriteStream(path.join(dir, `server-${day}.log`), { flags: 'a' });
    return stream;
  };

  const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const now = new Date();
    const line = JSON.stringify({ time: now.toISOString(), level: lvl, msg, ...(redact(fields) as object) });
    if (stdout) (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    fileFor(now.toISOString().slice(0, 10))?.write(line + '\n');
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    close: () => void stream?.end(),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, close() {} };
