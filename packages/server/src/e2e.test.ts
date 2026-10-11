import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CLIENT_DEFAULTS, createClient, type Client, type ClientOptions } from '@cake-pos/client';
import { seedDemo } from '@cake-pos/panel';
import { startServer, type RunningServer } from './app';
import { loadConfig } from './config';
import { LockedError } from './lock';
import { createLogger } from './log';
import { createScryptHasher } from './scrypt';

/* ---------- harness ---------- */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-e2e-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

interface Booted {
  server: RunningServer;
  dataDir: string;
  logDir: string;
}

async function boot(o: { dataDir?: string; env?: Record<string, string>; seed?: boolean } = {}): Promise<Booted> {
  const dataDir = o.dataDir ?? tmpDir();
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', ALLOWED_ORIGINS: 'http://allowed.test', ...o.env });
  const logDir = path.join(dataDir, 'logs');
  const log = createLogger({ level: 'debug', dir: logDir, stdout: false });
  const server = await startServer({ config, log });
  cleanups.push(async () => {
    await server.close();
    log.close();
  });
  if (o.seed !== false) await seedDemo(server.store, server.panel, createScryptHasher());
  return { server, dataDir, logDir };
}

const clientFor = (server: RunningServer, extra: Partial<ClientOptions> = {}): Client => {
  const c = createClient({ baseUrl: server.url, WebSocket: WebSocket as unknown as ClientOptions['WebSocket'], ...extra });
  cleanups.push(() => c.close());
  return c;
};

const PINS = { owner: '1111', cashier: '2222', baker: '3333', inventory: '4444', it: '9999' } as const;
async function login(server: RunningServer, role: keyof typeof PINS, extra: Partial<ClientOptions> = {}) {
  const c = clientFor(server, extra);
  const staff = await c.staff();
  const who = staff.find((s) => s.role === role)!;
  const r = await c.signIn(who.id, PINS[role]);
  if (!r.ok) throw new Error(`sign in failed: ${r.messages.join(' ')}`);
  return { client: c, userId: who.id };
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const call = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(url, init);
const json = { 'content-type': 'application/json' };

/* ---------- a day in the shop, over the real network ---------- */

describe('selling a cake through the real server', () => {
  it('signs in, takes an order, takes cash, hands over, and stock drops only then', async () => {
    const { server } = await boot();
    const { client: cashier } = await login(server, 'cashier');
    const { client: owner } = await login(server, 'owner');

    const grid = await cashier.feed('catalogue_grid', {});
    if (!grid.ok) throw new Error('grid failed');
    const combo = grid.data.find((g) => g.name === 'Chocolate Fudge Cake')!.combinations.find((c) => c.label === 'Slice, Vanilla cream, Standard')!;
    expect(combo.onHand).toBe(4);

    const created = await cashier.dispatch('orders/create_order', { source: 'phone', fulfilment: 'delivery', deliveryAddress: '12 Baker Street', customerName: 'Zuri' });
    if (!created.ok) throw new Error(created.error.messages.join(' '));
    const { orderId, number } = created.data as { orderId: string; number: string };
    expect(number).toBe('S-0001');

    const line = await cashier.dispatch('orders/add_catalogue_line', { orderId, combinationId: combo.combinationId, qty: 2 });
    if (!line.ok) throw new Error(line.error.messages.join(' '));
    const { lineId } = line.data as { lineId: string };

    const paid = await cashier.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 7000 });
    expect(paid.ok && paid.summary).toMatch(/Paid in full/);

    for (const to of ['ready', 'out_for_delivery', 'completed'] as const) {
      const r = await cashier.dispatch('orders/advance_line', { orderId, lineId, to });
      expect(r.ok).toBe(true);
      if (to !== 'completed') {
        const g = await owner.feed('catalogue_grid', {});
        if (!g.ok) throw new Error('grid');
        const c = g.data.find((x) => x.name === 'Chocolate Fudge Cake')!.combinations.find((x) => x.label === combo.label)!;
        expect(c.onHand).toBe(4); // not yet
        expect(c.committed).toBe(2);
      }
    }
    const after = await owner.feed('catalogue_grid', {});
    if (!after.ok) throw new Error('grid');
    expect(after.data.find((x) => x.name === 'Chocolate Fudge Cake')!.combinations.find((x) => x.label === combo.label)!.onHand).toBe(2);

    const card = await cashier.feed('order_card', { orderId });
    expect(card.ok && card.data.statusLabel).toBe('Completed');
    // The owner can see every step in the activity log, attributed to the right person.
    const audit = await owner.feed('audit_view', {});
    if (!audit.ok) throw new Error('audit');
    expect(audit.data.some((a) => a.who.startsWith('Baraka') && a.intent === 'payments/record_payment')).toBe(true);
  });

  it('pushes changes to other devices as they happen', async () => {
    const { server } = await boot();
    const { client: cashier } = await login(server, 'cashier');
    const { client: owner } = await login(server, 'owner');

    const seen: number[] = [];
    owner.subscribe('order_list', {}, (r) => r.ok && seen.push(r.data.length));
    await waitFor(() => seen.length > 0); // the current state arrives straight away
    expect(seen.at(-1)).toBe(0);

    await cashier.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    await waitFor(() => seen.at(-1) === 1);
    await cashier.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    await waitFor(() => seen.at(-1) === 2);
  });

  it('keeps people to their own role, over the network too', async () => {
    const { server } = await boot();
    const { client: cashier } = await login(server, 'cashier');
    const grid = await cashier.feed('catalogue_grid', {});
    if (!grid.ok) throw new Error('grid');
    const combinationId = grid.data[0]!.combinations[0]!.combinationId;
    const r = await cashier.dispatch('catalogue/set_price', { combinationId, price: 1 });
    expect(!r.ok && r.error.code).toBe('forbidden');
    const map = await cashier.feed('panel_map', {});
    expect(!map.ok && map.error.code).toBe('forbidden');
  });
});

/* ---------- when the network misbehaves ---------- */

describe('retries and outages', () => {
  it('does not take a payment twice when the reply is lost and the app retries', async () => {
    const { server } = await boot();
    const { client: cashier } = await login(server, 'cashier');
    const grid = await cashier.feed('catalogue_grid', {});
    if (!grid.ok) throw new Error('grid');
    const combo = grid.data[0]!.combinations.find((c) => c.sellable)!;
    const created = await cashier.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    const orderId = (created as { data: { orderId: string } }).data.orderId;
    await cashier.dispatch('orders/add_catalogue_line', { orderId, combinationId: combo.combinationId, qty: 4 });

    // The server does the work, but the answer never reaches the app: the classic wifi blip.
    let lost = false;
    const flaky: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (!lost && body.type === 'payments/record_payment') {
        lost = true;
        throw new TypeError('fetch failed');
      }
      return res;
    };
    const staff = (await cashier.staff()).find((s) => s.role === 'cashier')!;
    const phone = clientFor(server, { fetch: flaky });
    const signed = await phone.signIn(staff.id, PINS.cashier);
    expect(signed.ok).toBe(true);

    const r = await phone.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 6, allowPartial: true });
    expect(lost).toBe(true);
    expect(r.ok).toBe(true);
    expect((await server.store.list('payments')).length).toBe(1); // exactly one, not two
  });

  it('says plainly when the server cannot be reached, and changes nothing', async () => {
    const down = createClient({ baseUrl: 'http://127.0.0.1:1', retries: 1 });
    const r = await down.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    expect(!r.ok && r.error.code).toBe('offline');
    expect(!r.ok && r.error.messages[0]).toMatch(/Cannot reach the shop server/);
    expect(await down.staff()).toEqual([]);
  });

  it('gives up on a server that accepts connections but never answers, within the deadline', async () => {
    const sockets = new Set<net.Socket>();
    const hung = net.createServer((sock) => void sockets.add(sock)); // takes the connection, says nothing
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => {
      for (const sock of sockets) sock.destroy();
      hung.close(() => r());
    }));
    const port = (hung.address() as net.AddressInfo).port;
    const c = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 300, deadlineMs: 900 });
    const t0 = Date.now();
    const r = await c.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    const took = Date.now() - t0;
    expect(!r.ok && r.error.code).toBe('offline');
    expect(took).toBeLessThan(1_800);
  });

  it('has defaults that keep a stuck tap to about fifteen seconds', () => {
    expect(CLIENT_DEFAULTS.deadlineMs).toBeLessThanOrEqual(15_000);
    expect(CLIENT_DEFAULTS.timeoutMs).toBeLessThanOrEqual(CLIENT_DEFAULTS.deadlineMs);
  });

  it('signs out on this device at once even when the server is unreachable, then ends the sign-in when it can', async () => {
    const first = await boot();
    const port = first.server.port;
    const store: { t: string | null } = { t: null };
    const c = clientFor(first.server, {
      tokenStore: { get: () => store.t, set: (t) => void (store.t = t) },
      retries: 0,
      timeoutMs: 300,
      deadlineMs: 600,
      signOutRetryMs: 150,
    });
    const who = (await c.staff()).find((s) => s.role === 'cashier')!;
    await c.signIn(who.id, PINS.cashier);
    const oldToken = store.t!;
    expect(oldToken).toBeTruthy();

    await first.server.close(); // the till loses the server
    const out = await c.signOut();
    expect(out.serverEnded).toBe(false);
    expect(c.signedIn).toBe(false); // the device is signed out regardless
    expect(store.t).toBeNull();

    // The server comes back. The old token must be ended there, without anyone doing anything.
    const second = await boot({ dataDir: first.dataDir, env: { PORT: String(port) } });
    const probe = createClient({ baseUrl: second.server.url, tokenStore: { get: () => oldToken, set: () => undefined } });
    cleanups.push(() => probe.close());
    const deadline = Date.now() + 5_000;
    let ended = false;
    while (Date.now() < deadline && !ended) {
      ended = (await probe.restore()) === null;
      if (!ended) await new Promise((r) => setTimeout(r, 100));
    }
    expect(ended).toBe(true);
  }, 15_000);

  it('keeps people signed in across a server restart', async () => {
    const first = await boot();
    const token = await (async () => {
      const store: Record<string, string | null> = { t: null };
      const c = clientFor(first.server, { tokenStore: { get: () => store.t, set: (t) => void (store.t = t) } });
      const who = (await c.staff()).find((s) => s.role === 'cashier')!;
      await c.signIn(who.id, PINS.cashier);
      return store.t!;
    })();
    await first.server.close();

    const second = await boot({ dataDir: first.dataDir });
    const c2 = clientFor(second.server, { tokenStore: { get: () => token, set: () => undefined } });
    const me = await c2.restore();
    expect(me?.role).toBe('cashier');
  });

  it('reconnects live feeds by itself after the server comes back', async () => {
    const first = await boot({ env: { PORT: '0' } });
    const { client } = await login(first.server, 'owner');
    const states: string[] = [];
    client.onConnection((s) => states.push(s));
    let latest = -1;
    client.subscribe('order_list', {}, (r) => r.ok && (latest = r.data.length));
    await waitFor(() => latest === 0);
    expect(client.connection).toBe('online');

    // The server stops and restarts on the same port, as it would after a power cut.
    const port = first.server.port;
    await first.server.close();
    await waitFor(() => client.connection === 'offline');
    const second = await boot({ dataDir: first.dataDir, env: { PORT: String(port) } });
    const cashier = await login(second.server, 'cashier');
    await cashier.client.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    await waitFor(() => latest === 1, 15_000);
    expect(states).toContain('offline');
    expect(client.connection).toBe('online');
  }, 25_000);
});

/* ---------- ending a sign-in ---------- */

describe('ending a sign-in', () => {
  it('signs a device out the moment the owner switches that person off', async () => {
    const { server } = await boot();
    const { client: owner } = await login(server, 'owner');
    let signedOut = 0;
    const { client: cashier, userId } = await login(server, 'cashier', { onSignedOut: () => signedOut++ });
    cashier.subscribe('navigation', {}, () => undefined);
    await waitFor(() => cashier.connection === 'online');

    const off = await owner.dispatch('staff/set_active', { userId, active: false });
    expect(off.ok).toBe(true);
    await waitFor(() => signedOut > 0);
    expect(cashier.signedIn).toBe(false);
  });

  it('refuses a live connection that does not sign in', async () => {
    const { server } = await boot();
    const ws = new WebSocket(server.url.replace('http', 'ws') + '/api/live');
    const replies: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => replies.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ op: 'subscribe', id: 'a', name: 'order_list', params: {} }));
    ws.send(JSON.stringify({ op: 'auth', token: 'x'.repeat(43) }));
    await waitFor(() => replies.length >= 2);
    expect(replies[0]).toMatchObject({ op: 'error', error: { code: 'unauthenticated' } });
    expect(replies[1]).toMatchObject({ op: 'auth', ok: false });
    ws.close();
  });
});

/* ---------- hostile and sloppy requests ---------- */

describe('the API under bad requests', () => {
  it('answers each kind of mistake with the right status and stays up', async () => {
    const { server } = await boot();
    const u = (p: string) => server.url + p;
    const { client } = await login(server, 'owner');
    const token = (await (async () => {
      const who = (await client.staff()).find((s) => s.role === 'owner')!;
      const r = await call(u('/api/sign-in'), { method: 'POST', headers: json, body: JSON.stringify({ userId: who.id, pin: PINS.owner }) });
      return r.json();
    })()) as { token: string };
    const auth = { ...json, authorization: `Bearer ${token.token}` };

    expect((await call(u('/api/feed'), { method: 'POST', headers: json, body: '{"name":"navigation"}' })).status).toBe(401);
    expect((await call(u('/api/feed'), { method: 'POST', headers: { ...json, authorization: 'Bearer ' + 'z'.repeat(43) }, body: '{"name":"navigation"}' })).status).toBe(401);
    expect((await call(u('/api/dispatch'), { method: 'POST', headers: auth, body: '{not json' })).status).toBe(400);
    expect((await call(u('/api/dispatch'), { method: 'POST', headers: auth, body: '[1,2]' })).status).toBe(400);
    expect((await call(u('/api/dispatch'), { method: 'POST', headers: { authorization: auth.authorization, 'content-type': 'text/plain' }, body: 'hi' })).status).toBe(415);
    expect((await call(u('/api/dispatch'), { method: 'POST', headers: auth, body: JSON.stringify({ x: 'y'.repeat(300_000) }) })).status).toBe(413);
    expect((await call(u('/api/dispatch'), { method: 'POST', headers: auth, body: '{}' })).status).toBe(422);
    expect((await call(u('/api/dispatch'), { method: 'POST', headers: auth, body: JSON.stringify({ type: 'catalogue/set_price', payload: { combinationId: 1, price: 'x' } }) })).status).toBe(422);
    expect((await call(u('/api/nope'), { method: 'POST', headers: auth, body: '{}' })).status).toBe(404);
    expect((await call(u('/api/dispatch'), { method: 'GET' })).status).toBe(405);
    expect((await call(u('/nothing-here'))).status).toBe(404); // no UI folder configured
    // Still healthy.
    expect((await call(u('/api/health'))).status).toBe(200);
  });

  it('only allows the browser origins it was told about', async () => {
    const { server } = await boot();
    const allowed = await call(server.url + '/api/staff', { headers: { origin: 'http://allowed.test' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://allowed.test');
    const stranger = await call(server.url + '/api/staff', { headers: { origin: 'http://evil.test' } });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await call(server.url + '/api/dispatch', { method: 'OPTIONS', headers: { origin: 'http://allowed.test', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
  });

  it('slows down someone hammering the sign-in endpoint', async () => {
    const { server } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await call(server.url + '/api/sign-in', { method: 'POST', headers: json, body: JSON.stringify({ userId: `ghost${i}`, pin: '0000' }) });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 5).every((s) => s === 403)).toBe(true);
  });

  it('locks an account after repeated wrong PINs, over HTTP', async () => {
    const { server } = await boot();
    const c = clientFor(server);
    const who = (await c.staff()).find((s) => s.role === 'baker')!;
    let last = '';
    for (let i = 0; i < 5; i++) {
      const r = await c.signIn(who.id, '0000');
      last = r.ok ? '' : r.messages[0]!;
    }
    expect(last).toMatch(/Locked for 1 minute/);
    const right = await c.signIn(who.id, PINS.baker);
    expect(!right.ok && right.messages[0]).toMatch(/Try again in/);
  });
});

/* ---------- secrets ---------- */

describe('secrets stay secret', () => {
  it('never writes PINs or tokens to the logs or the database file', async () => {
    const { server, dataDir, logDir } = await boot();
    const c = clientFor(server);
    const who = (await c.staff()).find((s) => s.role === 'cashier')!;
    const wrong = '7391';
    await c.signIn(who.id, wrong);
    const ok = await call(server.url + '/api/sign-in', { method: 'POST', headers: json, body: JSON.stringify({ userId: who.id, pin: PINS.cashier }) });
    const { token } = (await ok.json()) as { token: string };
    await call(server.url + '/api/feed', { method: 'POST', headers: { ...json, authorization: `Bearer ${token}` }, body: '{"name":"navigation"}' });
    await server.close();

    const everything = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith('cakepos.sqlite'))
      .map((f) => fs.readFileSync(path.join(dataDir, f)).toString('latin1'))
      .concat(fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')))
      .join('\n');
    expect(everything).not.toContain(token);
    // A bare 4-digit string can turn up by chance inside random hex ids, so look for the PIN the way it would be written down.
    expect(everything).not.toContain(`"${wrong}"`);
    expect(everything).not.toContain(`pin=${wrong}`);
    expect(everything).not.toMatch(new RegExp(`pin\\W{1,4}${wrong}`, 'i'));
    expect(everything).not.toContain(`"pin":"${PINS.cashier}"`);
    expect(everything).toContain('scrypt$'); // PINs are stored only as salted scrypt hashes
  });
});

/* ---------- serving the UI ---------- */

describe('serving the built UI from the server', () => {
  const makeSite = () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shop</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(path.dirname(dir), 'secret-outside.txt'), 'top secret');
    cleanups.push(() => fs.rmSync(path.join(path.dirname(dir), 'secret-outside.txt'), { force: true }));
    return dir;
  };

  it('serves files, falls back to the app for its own pages, and never leaves the folder', async () => {
    const site = makeSite();
    const { server } = await boot({ env: { STATIC_DIR: site } });
    const home = await call(server.url + '/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('<title>shop</title>');
    const asset = await call(server.url + '/assets/app-abc123.js');
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    const page = await call(server.url + '/orders/123');
    expect(await page.text()).toContain('<title>shop</title>'); // the app's own router handles it
    expect((await call(server.url + '/missing.js')).status).toBe(404);

    // fetch() tidies "../" away, so send the raw request ourselves.
    const raw = (p: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.port, path: p }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }).on('error', reject);
      });
    for (const p of ['/..%2fsecret-outside.txt', '/%2e%2e/secret-outside.txt', '/assets/..%2f..%2fsecret-outside.txt', '/..%5csecret-outside.txt']) {
      const r = await raw(p);
      expect(r.body).not.toContain('top secret');
    }
  });
});

/* ---------- running it for real ---------- */

describe('operating the server', () => {
  it('refuses to start twice on the same data folder', async () => {
    const { dataDir } = await boot({ seed: false });
    // A different process holds the folder (we are pretending to be a second server).
    const other: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    cleanups.push(() => void other.kill('SIGKILL'));
    fs.writeFileSync(path.join(dataDir, 'server.lock'), JSON.stringify({ pid: other.pid }));
    const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' });
    await expect(startServer({ config, log: createLogger({ level: 'error', stdout: false }) })).rejects.toBeInstanceOf(LockedError);
  });

  it('takes over from a stale lock left by a crashed server', async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, 'server.lock'), JSON.stringify({ pid: 2 ** 22 - 1 })); // no such process
    const { server } = await boot({ dataDir, seed: false });
    expect(server.port).toBeGreaterThan(0);
  });

  it('shuts down cleanly: releases the lock and leaves a healthy database', async () => {
    const { server, dataDir } = await boot();
    const { client } = await login(server, 'cashier');
    await Promise.all(Array.from({ length: 10 }, () => client.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' })));
    await server.close();
    expect(fs.existsSync(path.join(dataDir, 'server.lock'))).toBe(false);
    const { openSqliteStore } = await import('./sqlite-store');
    const store = openSqliteStore(path.join(dataDir, 'cakepos.sqlite'));
    expect(store.integrityCheck()).toBe('ok');
    expect((await store.list('orders')).length).toBe(10);
    store.close();
  });

  it('reports health and system facts to IT', async () => {
    const { server } = await boot();
    const { client: it } = await login(server, 'it');
    const map = await it.feed('panel_map', {});
    if (!map.ok) throw new Error('map failed');
    const labels = map.data.system.map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Version', 'Uptime', 'Database', 'Addresses', 'Data folder']));
    expect(map.data.terminals.find((t) => t.name === 'Backups')?.state).toBe('no backup yet');
  });

  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version']);
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasOpenssl)('serves over HTTPS when given a certificate', async () => {
    const dir = tmpDir();
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const { server } = await boot({ env: { TLS_CERT: cert, TLS_KEY: key } });
    expect(server.url.startsWith('https://')).toBe(true);
    const body = await new Promise<string>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: server.port, path: '/api/health', ca: fs.readFileSync(cert), servername: 'localhost' }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    expect(JSON.parse(body).ok).toBe(true);
  });
});

/* ---------- custom cakes over the real network ---------- */

describe('custom cakes through the real server', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
  const tomorrow = () => {
    const d = new Date(Date.now() + 5 * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('takes a cake order with a photo, gets it quoted, and lets the baker see and bake it', async () => {
    const { server } = await boot();
    const { client: cashier } = await login(server, 'cashier');
    const { client: owner } = await login(server, 'owner');
    const { client: baker } = await login(server, 'baker');

    const made = await cashier.dispatch('orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: 'Zawadi', deliveryDate: tomorrow() });
    const { orderId } = (made.ok ? made.data : {}) as { orderId: string };
    const line = await cashier.dispatch('orders/add_custom_line', { orderId, spec: { servings: 20, flavor: 'Vanilla', layers: 3, inscription: 'Congratulations' } });
    const { lineId } = (line.ok ? line.data : {}) as { lineId: string };

    const up = await cashier.uploadPhoto(PNG, 'image/png');
    expect(up.ok).toBe(true);
    const photoId = up.ok ? up.photoId : '';
    expect((await cashier.dispatch('orders/attach_reference_photo', { orderId, lineId, photoId })).ok).toBe(true);

    // The owner's inbox updates live when the cashier asks for a price.
    let open = -1;
    owner.subscribe('quote_inbox', {}, (r) => r.ok && (open = r.data.open.length));
    await waitFor(() => open === 0);
    const asked = await cashier.dispatch('quotes/request', { orderId, lineId, note: 'Wants gold leaf' });
    expect(asked.ok).toBe(true);
    await waitFor(() => open === 1);
    const inbox = await owner.feed('quote_inbox', {});
    const quoteId = inbox.ok ? inbox.data.open[0]!.quoteId : '';
    expect(inbox.ok && inbox.data.open[0]!.cake.photoIds).toEqual([photoId]);

    expect((await cashier.dispatch('quotes/provide', { quoteId, price: 200 })).ok).toBe(false); // not the cashier's call
    expect((await owner.dispatch('quotes/provide', { quoteId, price: 200, note: 'Gold leaf included' })).ok).toBe(true);
    await waitFor(() => open === 0);

    // The baker sees the cake and the reference picture, but not the money.
    let queue = 0;
    baker.subscribe('bake_queue', {}, (r) => r.ok && (queue = r.data.rows.length));
    await waitFor(() => queue === 1);
    const pic = await baker.photo(photoId);
    expect(pic.ok && pic.mime).toBe('image/png');
    expect(pic.ok && Array.from(new Uint8Array(await pic.blob.arrayBuffer()))).toEqual(Array.from(PNG));
    const card = await baker.feed('order_card', { orderId });
    expect(!card.ok && card.error.code).toBe('forbidden');

    expect((await baker.dispatch('orders/advance_line', { orderId, lineId, to: 'in_production' })).ok).toBe(true);
    expect((await baker.dispatch('orders/advance_line', { orderId, lineId, to: 'ready' })).ok).toBe(true);
    expect((await cashier.dispatch('payments/record_payment', { orderId, method: 'cash', amount: 200 })).ok).toBe(true);
    expect((await cashier.dispatch('orders/advance_line', { orderId, lineId, to: 'completed' })).ok).toBe(true);
  });

  it('keeps pictures safe: signed-in staff only, real pictures only, size limited, kept across a restart', async () => {
    const first = await boot();
    const { client: cashier } = await login(first.server, 'cashier');
    const { client: inventory } = await login(first.server, 'inventory');
    const url = first.server.url;

    const up = await cashier.uploadPhoto(PNG, 'image/png');
    const photoId = up.ok ? up.photoId : '';
    expect(photoId).toBeTruthy();

    // No sign-in, no picture, whether uploading or looking.
    expect((await call(`${url}/api/photos/${photoId}`)).status).toBe(401);
    const anon = await call(`${url}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    expect(anon.status).toBe(401);
    // Inventory staff have no reason to see customer pictures.
    const denied = await inventory.photo(photoId);
    expect(!denied.ok && denied.error.code).toBe('forbidden');
    expect((await inventory.uploadPhoto(PNG, 'image/png')).ok).toBe(false);

    // Text pretending to be a picture is refused, whatever it is called.
    const fake = await cashier.uploadPhoto(new TextEncoder().encode('<html>not a picture</html>'), 'image/png');
    expect(!fake.ok && fake.error.messages[0]).toMatch(/JPEG, PNG or WebP/);
    // Too big: refused up front from the declared size.
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(PNG);
    const tooBig = await cashier.uploadPhoto(big, 'image/png');
    expect(!tooBig.ok && tooBig.error.messages[0]).toMatch(/too big/);

    // Pictures live in the database, so they survive a restart.
    await first.server.close();
    const second = await boot({ dataDir: first.dataDir });
    const { client: owner } = await login(second.server, 'owner');
    const again = await owner.photo(photoId);
    expect(again.ok && again.mime).toBe('image/png');
  }, 20_000);

  it('rejects a wrong content type for an upload with a clear answer', async () => {
    const { server } = await boot();
    const c = clientFor(server);
    const who = (await c.staff()).find((s) => s.role === 'cashier')!;
    const r = await call(server.url + '/api/sign-in', { method: 'POST', headers: json, body: JSON.stringify({ userId: who.id, pin: PINS.cashier }) });
    const { token } = (await r.json()) as { token: string };
    const bad = await call(server.url + '/api/photos', { method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${token}` }, body: '<b>x</b>' });
    expect(bad.status).toBe(415);
    const ok = await call(server.url + '/api/photos', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` }, body: PNG });
    expect(ok.status).toBe(200);
    const { photoId } = (await ok.json()) as { photoId: string };
    const got = await call(`${server.url}/api/photos/${photoId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toMatch(/sandbox/);
    const missing = await call(`${server.url}/api/photos/pho_doesnotexist`, { headers: { authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(404);
  });
});

/* ---------- ingredients and usage over the real network ---------- */

describe('ingredient usage through the real server', () => {
  const soon = () => {
    const d = new Date(Date.now() + 4 * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('suggests, lets the baker report, lets Inventory confirm, and only then lowers stock, live on every screen', async () => {
    const { server } = await boot();
    const { client: inventory } = await login(server, 'inventory');
    const { client: baker } = await login(server, 'baker');
    const { client: cashier } = await login(server, 'cashier');
    const { client: owner } = await login(server, 'owner');

    const made = await inventory.dispatch('inventory/create_ingredient', {
      name: 'Flour',
      unit: 'g',
      openingStock: 2000,
      ranges: [{ label: 'Light', min: 100, max: 200 }, { label: 'Medium', min: 200, max: 400 }],
    });
    const ingredientId = ((made.ok ? made.data : {}) as { ingredientId: string }).ingredientId;
    expect((await baker.dispatch('recipes/save_rule', { ingredientId, quantity: 25, unit: 'g', scaling: 'per_serving' })).ok).toBe(true);

    const o = await cashier.dispatch('orders/create_order', { source: 'phone', fulfilment: 'pickup', deliveryDate: soon() });
    const orderId = ((o.ok ? o.data : {}) as { orderId: string }).orderId;
    const l = await cashier.dispatch('orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Vanilla' } });
    const lineId = ((l.ok ? l.data : {}) as { lineId: string }).lineId;
    const q = await cashier.dispatch('quotes/request', { orderId, lineId });
    const quoteId = ((q.ok ? q.data : {}) as { quoteId: string }).quoteId;
    expect((await owner.dispatch('quotes/provide', { quoteId, price: 80 })).ok).toBe(true);

    let pending = -1;
    inventory.subscribe('usage_inbox', {}, (r) => r.ok && (pending = r.data.pending.length));
    await waitFor(() => pending === 0);

    expect((await baker.dispatch('orders/advance_line', { orderId, lineId, to: 'in_production' })).ok).toBe(true);
    const form = await baker.feed('usage_form', { orderId, lineId });
    expect(form.ok && form.data.suggested[0]).toMatchObject({ name: 'Flour', suggestedQty: 0.25, suggestedText: '250 g' });
    const rangeId = form.ok ? form.data.suggested[0]!.suggestedRangeId! : '';

    expect((await baker.dispatch('usage/report', { orderId, lineId, items: [{ ingredientId, rangeId }] })).ok).toBe(true);
    await waitFor(() => pending === 1);
    const stock = async () => {
      const r = await inventory.feed('ingredient_list', {});
      return r.ok ? r.data[0]! : undefined;
    };
    expect(await stock()).toMatchObject({ unit: 'kg', onHand: 2, onHandText: '2 kg', pending: { min: 0.2, max: 0.4, reports: 1 } });

    const inbox = await inventory.feed('usage_inbox', {});
    const reportId = inbox.ok ? inbox.data.pending[0]!.reportId : '';
    expect((await baker.dispatch('usage/confirm', { reportId, items: [{ ingredientId, qty: 250, unit: 'g' }] })).ok).toBe(false);
    expect((await inventory.dispatch('usage/confirm', { reportId, items: [{ ingredientId, qty: 250, unit: 'g' }] })).ok).toBe(true);
    await waitFor(() => pending === 0);
    expect(await stock()).toMatchObject({ onHand: 1.75, pending: null });
  });

  it('raises an alert on every inventory screen live when stock runs low, and clears it when restocked', async () => {
    const { server } = await boot();
    const { client: inventory } = await login(server, 'inventory');
    const { client: owner } = await login(server, 'owner');
    const { client: cashier } = await login(server, 'cashier');

    const made = await inventory.dispatch('inventory/create_ingredient', { name: 'Butter', unit: 'kg', openingStock: 5, reorderLevel: 1 });
    const ingredientId = ((made.ok ? made.data : {}) as { ingredientId: string }).ingredientId;

    let invTitles: string[] = [];
    let ownerCritical = -1;
    let cashierTitles: string[] | 'denied' = [];
    inventory.subscribe('alert_inbox', {}, (r) => r.ok && (invTitles = r.data.open.map((a) => a.title)));
    owner.subscribe('alert_inbox', {}, (r) => r.ok && (ownerCritical = r.data.critical));
    cashier.subscribe('alert_inbox', {}, (r) => r.ok && (cashierTitles = r.data.open.map((a) => a.title)));
    await waitFor(() => ownerCritical === 0);

    expect((await inventory.dispatch('inventory/count', { ingredientId, counted: 0 })).ok).toBe(true);
    await waitFor(() => invTitles.length === 1);
    expect(invTitles).toEqual(['Butter is out of stock']);
    await waitFor(() => ownerCritical === 1); // out of stock is critical, so the owner has it too
    expect(cashierTitles).toEqual([]);

    // The forecast screen data arrives over the same wire.
    const f = await inventory.feed('stock_forecast', { ingredientId });
    expect(f.ok && f.data.rows[0]).toMatchObject({ status: 'out', onHandText: '0 kg' });

    expect((await inventory.dispatch('inventory/receive', { ingredientId, qty: 3000, unit: 'g' })).ok).toBe(true);
    await waitFor(() => invTitles.length === 0);
    await waitFor(() => ownerCritical === 0);
  });

  it('really sends a critical alert as a text through the shop’s message service, and nobody else gets it', async () => {
    const received: Array<{ auth?: string; body: { channel: string; to: string; text: string } }> = [];
    const hook = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(data) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => hook.close(() => r())));
    const url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/send`;

    const { server } = await boot({ env: { SMS_PROVIDER: 'webhook', MESSAGE_WEBHOOK_URL: url, MESSAGE_WEBHOOK_TOKEN: 'bridge-secret', PUSH_CONTACT: 'owner@cakes.example' } });
    const { client: owner } = await login(server, 'owner');
    const { client: inventory } = await login(server, 'inventory');
    const ownerId = ((await owner.feed('me', {})) as { ok: true; data: { userId: string } }).data.userId;

    const setup = await owner.feed('notification_setup', {});
    expect(setup.ok && setup.data.channels).toEqual({ push: true, sms: true, whatsapp: false });
    expect(setup.ok && setup.data.push.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await owner.dispatch('staff/set_contact', { userId: ownerId, phone: '+255 712 345 678' })).ok).toBe(true);

    const made = await inventory.dispatch('inventory/create_ingredient', { name: 'Butter', unit: 'kg', openingStock: 5, reorderLevel: 1 });
    const ingredientId = ((made.ok ? made.data : {}) as { ingredientId: string }).ingredientId;
    expect((await inventory.dispatch('inventory/count', { ingredientId, counted: 0 })).ok).toBe(true);

    expect(await server.panel.deliver()).toMatchObject({ sent: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe('Bearer bridge-secret');
    expect(received[0]!.body).toMatchObject({ channel: 'sms', to: '+255712345678' });
    expect(received[0]!.body.text).toMatch(/^Cake POS: Butter is out of stock\./);
    expect(await server.panel.deliver()).toEqual({ sent: 0, failed: 0, retrying: 0 });
    expect(received).toHaveLength(1);

    const log = await owner.feed('notification_log', {});
    expect(log.ok && log.data[0]).toMatchObject({ title: 'Butter is out of stock', status: 'sent', deliveries: [{ channel: 'sms', status: 'sent' }] });
    // The phone number never reaches the log file.
    const logs = fs.readdirSync(path.join(path.dirname(server.store.file), 'logs')).map((f) => fs.readFileSync(path.join(path.dirname(server.store.file), 'logs', f), 'utf8')).join('\n');
    expect(logs).not.toContain('712345678');
    expect(logs).not.toContain('bridge-secret');
  });

  it('keeps the phone-notification keys across a restart, so phones that subscribed keep working', async () => {
    const dataDir = tmpDir();
    const env = { PUSH_CONTACT: 'owner@cakes.example' };
    const key = async () => {
      const { server } = await boot({ dataDir, env, seed: false });
      return (await server.store.get<{ id: string; publicKey: string }>('settings', 'vapid'))!.publicKey;
    };
    const first = await key();
    await cleanups.pop()!(); // stop the first server
    const second = await key();
    expect(second).toBe(first);
  });
});
