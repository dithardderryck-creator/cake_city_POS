import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, readRecentLogs } from './log';

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-logs-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (time: string, level: string, msg: string, extra: object = {}) => JSON.stringify({ time, level, msg, ...extra });
const day = (d: string, lines: string[]) => fs.writeFileSync(path.join(dir, `server-${d}.log`), lines.join('\n') + '\n');
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('reading the server log for IT', () => {
  it('returns the newest first, and filters by level and time', () => {
    day('2026-10-26', [line('2026-10-26T09:00:00Z', 'error', 'yesterday')]);
    day('2026-10-27', [line('2026-10-27T08:00:00Z', 'info', 'started'), line('2026-10-27T09:00:00Z', 'warn', 'slow disk'), line('2026-10-27T11:30:00Z', 'error', 'backup failed', { part: 'backup' })]);
    const all = readRecentLogs(dir, { level: 'all', sinceMs: 48 * 3_600_000, limit: 50 }, NOW);
    expect(all.rows.map((r) => r.message)).toEqual(['backup failed', 'slow disk', 'started', 'yesterday']);
    expect(readRecentLogs(dir, { level: 'warn', sinceMs: 48 * 3_600_000, limit: 50 }, NOW).rows.map((r) => r.message)).toEqual(['backup failed', 'slow disk', 'yesterday']);
    expect(readRecentLogs(dir, { level: 'error', sinceMs: 2 * 3_600_000, limit: 50 }, NOW).rows.map((r) => r.message)).toEqual(['backup failed']);
    expect(all.rows[0]!.detail).toBe('{"part":"backup"}');
  });

  it('leaves out stack traces, skips broken lines, and caps the count', () => {
    day('2026-10-27', ['not json', line('2026-10-27T10:00:00Z', 'error', 'boom', { error: 'x', stack: 'a\n b\n c' }), ...Array.from({ length: 5 }, (_, i) => line(`2026-10-27T11:0${i}:00Z`, 'info', `n${i}`))]);
    const r = readRecentLogs(dir, { level: 'all', sinceMs: 5 * 3_600_000, limit: 3 }, NOW);
    expect(r.rows.map((x) => x.message)).toEqual(['n4', 'n3', 'n2']);
    expect(r.note).toMatch(/newest 3/);
    const boom = readRecentLogs(dir, { level: 'error', sinceMs: 5 * 3_600_000, limit: 5 }, NOW).rows[0]!;
    expect(boom.detail).not.toMatch(/stack|\\n/);
  });

  it('never shows what the logger already hid, and copes with no folder', () => {
    const log = createLogger({ level: 'info', dir, stdout: false });
    log.info('signed in', { pin: '1234', token: 'abc', who: 'Neema' });
    log.close();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const r = readRecentLogs(dir, { level: 'all', sinceMs: 3_600_000 * 24, limit: 50 }, Date.now());
        expect(JSON.stringify(r.rows)).not.toMatch(/1234|abc/);
        expect(r.rows[0]!.detail).toMatch(/Neema/);
        expect(readRecentLogs(path.join(dir, 'nope'), { level: 'all', sinceMs: 1000, limit: 5 }).note).toMatch(/No log files/);
        resolve();
      }, 100),
    );
  });
});
