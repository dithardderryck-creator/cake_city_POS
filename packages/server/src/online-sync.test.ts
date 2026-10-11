import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPanel, seedDemo, DEMO_STAFF, type Change, type Staff } from '@cake-pos/panel';
import { createHttpSyncTerminal } from './online-sync';
import { loadConfig } from './config';
import { openSqliteStore } from './sqlite-store';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A stand-in online database: remembers each change id once, can be told to fail. */
async function receiver() {
  const got = new Map<string, Change>();
  const state = { fail: 0, auth: [] as string[], requests: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      state.requests++;
      state.auth.push(String(req.headers.authorization));
      if (state.fail > 0) {
        state.fail--;
        res.writeHead(503).end('database busy');
        return;
      }
      for (const c of (JSON.parse(body) as { changes: Change[] }).changes) if (!got.has(c.id)) got.set(c.id, c); // ignores repeats
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { got, state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
}

async function shop(url: string, now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-sync-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openSqliteStore(path.join(dir, 'db.sqlite'));
  cleanups.push(() => void store.db.close());
  const terminal = createHttpSyncTerminal({ url, token: 'secret-1', deviceId: 'A', backoffMs: 1000, now });
  const panel = createPanel({ store, terminals: { sync: terminal } });
  await seedDemo(store, panel);
  const s = (await store.list<Staff>('staff')).find((x) => x.role === 'owner')!;
  const r = await panel.dispatch('auth/sign_in', { userId: s.id, pin: DEMO_STAFF.find((d) => d.role === 'owner')!.pin });
  if (!r.ok) throw new Error('sign in failed');
  return { store, panel, owner: (r.data as { sessionId: string }).sessionId };
}

describe('online database over HTTP', () => {
  it('delivers every change, in order, with the secret, even past ten (SQLite ordering)', async () => {
    const rc = await receiver();
    const { panel, owner } = await shop(rc.url);
    for (let i = 0; i < 12; i++) await panel.dispatch('staff/create', { name: `Person ${i}`, role: 'cashier', pin: '1234' }, owner);
    const r = await panel.syncNow();
    expect(r.state).toBe('sent');
    expect(r.pending).toBe(0);
    expect([...rc.got.values()].filter((c) => c.collection === 'staff' && (c.record as Staff).name.startsWith('Person ')).length).toBe(12);
    const seqs = [...rc.got.values()].map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(rc.state.auth.every((a) => a === 'Bearer secret-1')).toBe(true);
  });

  it('survives the database being down: waits, then catches up without duplicates', async () => {
    const rc = await receiver();
    let clock = 1_000_000;
    const { panel, owner } = await shop(rc.url, () => clock);
    await panel.syncNow();
    const base = rc.got.size;
    await panel.dispatch('staff/create', { name: 'Neema', role: 'cashier', pin: '4321' }, owner);
    rc.state.fail = 1;
    const bad = await panel.syncNow();
    expect(bad.state).toBe('failed');
    expect(bad.error).toMatch(/503/);
    expect(bad.pending).toBeGreaterThan(0);
    expect((await panel.syncNow()).state).toBe('offline'); // backing off, not hammering
    clock += 1500;
    expect((await panel.syncNow()).state).toBe('sent');
    expect(rc.got.size).toBeGreaterThan(base);
    expect([...rc.got.values()].filter((c) => c.collection === 'staff' && (c.record as Staff).name === 'Neema')).toHaveLength(1);
  });

  it('treats an unreachable address as offline and keeps the changes', async () => {
    const { panel, store } = await shop('http://127.0.0.1:9/api');
    const r = await panel.syncNow();
    expect(r.state).toBe('failed');
    expect((await store.find('changes', { where: { status: 'pending' } })).length).toBeGreaterThan(0);
  });
});

describe('online database settings', () => {
  it('needs https (localhost excepted) and a secret', () => {
    expect(loadConfig({ DATA_DIR: os.tmpdir() }).onlineDb).toBeNull();
    expect(() => loadConfig({ DATA_DIR: os.tmpdir(), ONLINE_DB_URL: 'http://example.com' })).toThrow(/https/);
    expect(() => loadConfig({ DATA_DIR: os.tmpdir(), ONLINE_DB_URL: 'https://example.com' })).toThrow(/ONLINE_DB_TOKEN/);
    expect(loadConfig({ DATA_DIR: os.tmpdir(), ONLINE_DB_URL: 'https://example.com/api', ONLINE_DB_TOKEN: 't' }).onlineDb).toEqual({ url: 'https://example.com/api', token: 't' });
  });
});
