import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteStore } from './sqlite-store';

const serverDir = path.resolve(__dirname, '..');

/** Start the worker, wait for its signal, then kill it the hard way (no chance to clean up). */
function crash(file: string, mode: 'committed' | 'midway', signal: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(serverDir, 'test', 'crash-worker.ts'), file, mode], { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes(signal)) child.kill('SIGKILL');
    });
    child.on('exit', (code, sig) => (sig === 'SIGKILL' ? resolve() : reject(new Error(`worker ended early (${code}): ${err}`))));
    setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker timed out: ${out} ${err}`));
    }, 20_000);
  });
}

describe('crash durability (a real process, killed with SIGKILL)', () => {
  it('keeps every committed write when the process dies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-crash-'));
    const file = path.join(dir, 'a.sqlite');
    await crash(file, 'committed', 'DONE');
    const store = openSqliteStore(file);
    expect((await store.list('payments')).length).toBe(100);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws away a half-finished transaction when the process dies mid-write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-crash-'));
    const file = path.join(dir, 'b.sqlite');
    await crash(file, 'midway', 'INTX');
    const store = openSqliteStore(file);
    expect((await store.list('payments')).length).toBe(0);
    expect(store.integrityCheck()).toBe('ok');
    // And it is fully usable afterwards.
    await store.put('payments', { id: 'after', amount: 1 });
    expect((await store.list('payments')).length).toBe(1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
