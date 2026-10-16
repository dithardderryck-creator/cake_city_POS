import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Staff } from '@cake-pos/panel';
import { startServer, type RunningServer } from './app';
import { ConfigError, loadConfig } from './config';
import { silentLogger } from './log';

const open: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
async function boot(env: Record<string, string>, dir?: string) {
  const dataDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-tc-'));
  if (!dir) dirs.push(dataDir);
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', ...env });
  const server = await startServer({ config, log: silentLogger });
  open.push(server);
  return { server, dataDir, config };
}
const post = (s: RunningServer, p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(s.url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('test copy mode', () => {
  it('is off unless asked for: an empty shop stays empty and no code is made', async () => {
    const { server } = await boot({});
    expect(server.testCopy).toBeUndefined();
    expect(await server.store.list('staff')).toHaveLength(0);
  });

  it('fills an empty shop with the demo and makes a first-device code that registers one device, once', async () => {
    const { server } = await boot({ TEST_COPY: '1' });
    expect(server.testCopy?.seeded).toBe(true);
    expect((await server.store.list<Staff>('staff')).length).toBeGreaterThan(0);
    // An unregistered device sees no staff names.
    expect((await fetch(server.url + '/api/staff')).status).toBe(403);
    const first = await post(server, '/api/pair', { code: server.testCopy!.code });
    expect(first.status).toBe(200);
    const token = ((await first.json()) as { deviceToken: string }).deviceToken;
    // The paired device can now see the sign-in list and sign in.
    const list = (await (await fetch(server.url + '/api/staff', { headers: { 'x-device-token': token } })).json()) as { ok: boolean; data: unknown[] };
    expect(list.ok).toBe(true);
    expect(list.data.length).toBeGreaterThan(0);
    expect((await post(server, '/api/pair', { code: server.testCopy!.code })).status).not.toBe(200);
  });

  it('on a restart keeps what is there but makes a new code', async () => {
    const a = await boot({ TEST_COPY: '1' });
    const orders = (await a.server.store.list('orders')).length;
    const code1 = a.server.testCopy!.code;
    await a.server.close();
    open.pop();
    const b = await boot({ TEST_COPY: '1' }, a.dataDir);
    expect(b.server.testCopy?.seeded).toBe(false);
    expect((await b.server.store.list('orders')).length).toBe(orders);
    expect(b.server.testCopy!.code).not.toBe(code1);
  });
});

describe('TRUST_PROXY', () => {
  it('rejects nonsense', () => {
    expect(() => loadConfig({ TRUST_PROXY: '9' })).toThrow(ConfigError);
    expect(() => loadConfig({ TRUST_PROXY: 'lots' })).toThrow(ConfigError);
    expect(loadConfig({}).trustProxy).toBe(0);
  });

  it('with one proxy, each visitor gets their own try-limit and a made-up address on the left changes nothing', async () => {
    const { server } = await boot({ TRUST_PROXY: '1' });
    const bad = (xff: string) => post(server, '/api/pair', { code: 'AAAA-BBBB' }, { 'x-forwarded-for': xff }).then((r) => r.status);
    for (let i = 0; i < 10; i++) expect(await bad('9.9.9.9')).not.toBe(429);
    expect(await bad('9.9.9.9')).toBe(429);
    expect(await bad('8.8.8.8')).not.toBe(429); // someone else is not locked out
    expect(await bad('1.2.3.4, 9.9.9.9')).toBe(429); // writing extra addresses does not escape the limit
  });

  it('without it, the header is ignored: everyone counts as the connection they arrived on', async () => {
    const { server } = await boot({});
    const bad = (xff: string) => post(server, '/api/pair', { code: 'AAAA-BBBB' }, { 'x-forwarded-for': xff }).then((r) => r.status);
    for (let i = 0; i < 10; i++) await bad(`10.0.0.${i}`);
    expect(await bad('10.0.0.200')).toBe(429);
  });
});
