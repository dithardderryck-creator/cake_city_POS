import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './app';
import { loadConfig } from './config';
import { silentLogger } from './log';

// People move between the shop wifi, mobile data and a hotspot. A registered device and a signed-in person must keep working,
// because both are identified by secrets the browser keeps, never by the network address.
const open: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-net-'));
  dirs.push(dataDir);
  const server = await startServer({ config: loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', TEST_COPY: '1', TRUST_PROXY: '1' }), log: silentLogger });
  open.push(server);
  return server;
}
const call = (s: RunningServer, p: string, body: unknown, ip: string, headers: Record<string, string> = {}) =>
  fetch(s.url + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers }, body: JSON.stringify(body) });

describe('changing network', () => {
  it('keeps a registered device and a signed-in session working from a new address', async () => {
    const server = await boot();
    const wifi = '192.168.1.20';
    const mobile = '41.59.8.77';
    const paired = await call(server, '/api/pair', { code: server.testCopy!.code }, wifi);
    expect(paired.status).toBe(200);
    const device = ((await paired.json()) as { deviceToken: string }).deviceToken;
    const dev = { 'x-device-token': device };

    const list = (await (await fetch(server.url + '/api/staff', { headers: { ...dev, 'x-forwarded-for': wifi } })).json()) as { data: { id: string; role: string }[] };
    const owner = list.data.find((s) => s.role === 'owner')!;
    const signed = (await (await call(server, '/api/sign-in', { userId: owner.id, pin: '1111' }, wifi, dev)).json()) as { ok: boolean; token: string };
    expect(signed.ok).toBe(true);
    const auth = { ...dev, authorization: `Bearer ${signed.token}` };

    // Same device, same session, a different network: nothing is asked again.
    expect(((await (await fetch(server.url + '/api/device', { headers: { ...dev, 'x-forwarded-for': mobile } })).json()) as { registered: boolean }).registered).toBe(true);
    const feed = await call(server, '/api/feed', { name: 'device_list', params: {} }, mobile, auth);
    expect(feed.status).toBe(200);
    expect(((await feed.json()) as { ok: boolean }).ok).toBe(true);

    // A fresh sign-in from the new address works as well.
    const again = (await (await call(server, '/api/sign-in', { userId: owner.id, pin: '1111' }, mobile, dev)).json()) as { ok: boolean };
    expect(again.ok).toBe(true);
  });

  it('does not let a busy address block people on another one', async () => {
    const server = await boot();
    const bad = (ip: string) => call(server, '/api/pair', { code: 'AAAA-BBBB' }, ip).then((r) => r.status);
    for (let i = 0; i < 12; i++) await bad('203.0.113.9');
    expect(await bad('203.0.113.9')).toBe(429);
    // Someone on another network can still register with a good code.
    expect((await call(server, '/api/pair', { code: server.testCopy!.code }, '198.51.100.4')).status).toBe(200);
  });
});
