import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createClient, type Client, type ClientOptions } from '@cake-pos/client';
import { createPanel, seedDemo, type Combination, type Order, type Payment } from '@cake-pos/panel';
import { makePairingCode } from './admin';
import { startServer, type RunningServer } from './app';
import { loadConfig } from './config';
import { createLogger } from './log';
import { createScryptHasher } from './scrypt';

/* ---------- harness ---------- */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<RunningServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-offline-'));
  cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', REQUIRE_DEVICE: '1' });
  const log = createLogger({ level: 'error', dir: path.join(dataDir, 'logs'), stdout: false });
  const server = await startServer({ config, log });
  cleanups.push(async () => {
    await server.close();
    log.close();
  });
  const hasher = createScryptHasher();
  await seedDemo(server.store, createPanel({ store: server.store, hasher }), hasher);
  return server;
}

const PINS = { owner: '1111', cashier: '2222' } as const;

/** A fetch that can lose the network, or lose only the answers (the request still reaches the server). */
function flaky() {
  const net = { down: false, dropAnswers: 0 };
  const f: typeof fetch = async (input, init) => {
    if (net.down) throw new TypeError('network down');
    const res = await fetch(input, init);
    if (net.dropAnswers > 0) {
      net.dropAnswers--;
      await res.arrayBuffer();
      throw new TypeError('answer lost');
    }
    return res;
  };
  return { net, f };
}

interface Till {
  client: Client;
  net: ReturnType<typeof flaky>['net'];
  offlineStore: { value: string | null };
  deviceStore: { value: string | null };
  tokenStore: { value: string | null };
  userId: string;
  options: Partial<ClientOptions>;
}

const box = () => {
  const b: { value: string | null } = { value: null };
  return { b, store: { get: () => b.value, set: (v: string | null) => void (b.value = v) } };
};

async function pair(server: RunningServer, name: string, deviceStore: { value: string | null }) {
  const c = createClient({ baseUrl: server.url, deviceStore: { get: () => deviceStore.value, set: (v) => void (deviceStore.value = v) } });
  const { code } = await makePairingCode(server.store, { name });
  expect((await c.pairDevice(code)).ok).toBe(true);
  c.close();
}

/** A till: a registered device with a signed-in cashier (or owner). */
async function till(server: RunningServer, name: string, role: keyof typeof PINS = 'cashier', reuse?: Pick<Till, 'offlineStore' | 'deviceStore' | 'tokenStore'>): Promise<Till> {
  const device = reuse?.deviceStore ?? box().b;
  const offline = reuse?.offlineStore ?? box().b;
  const tokenBox = reuse?.tokenStore ?? box().b;
  if (!reuse) await pair(server, name, device);
  const { net, f } = flaky();
  const options: Partial<ClientOptions> = {
    baseUrl: server.url,
    WebSocket: WebSocket as unknown as ClientOptions['WebSocket'],
    fetch: f,
    retries: 1,
    timeoutMs: 1500,
    deadlineMs: 4000,
    deviceStore: { get: () => device.value, set: (v) => void (device.value = v) },
    offlineStore: { get: () => offline.value, set: (v) => void (offline.value = v) },
    tokenStore: { get: () => tokenBox.value, set: (v) => void (tokenBox.value = v) },
  };
  const client = createClient(options);
  cleanups.push(() => client.close());
  const staff = await client.staff();
  const who = staff.find((s) => s.role === role)!;
  if (!reuse) {
    const r = await client.signIn(who.id, PINS[role]);
    if (!r.ok) throw new Error(r.messages.join(' '));
  } else if (!(await client.restore())) {
    const r = await client.signIn(who.id, PINS[role]);
    if (!r.ok) throw new Error(r.messages.join(' '));
  }
  return { client, net, offlineStore: offline, deviceStore: device, tokenStore: tokenBox, userId: who.id, options };
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

async function cakes(server: RunningServer) {
  const combos = await server.store.list<Combination>('combinations');
  return combos.filter((c) => c.status === 'available' && c.price !== null && c.price > 0).slice(0, 2);
}

async function setup(limits: Record<string, unknown> = {}) {
  const server = await boot();
  const owner = await till(server, 'Owner laptop', 'owner');
  const set = await owner.client.dispatch('settings/update', { offlineEnabled: true, ...limits });
  expect(set.ok).toBe(true);
  const t = await till(server, 'Counter');
  await waitFor(() => t.client.offline.status().canSell);
  const [a, b] = await cakes(server);
  const sale = (c: Combination, qty = 1) => ({ items: [{ combinationId: c.id, qty }], method: 'cash' as const, expectedTotal: c.price! * qty });
  return { server, owner, t, a: a!, b: b!, sale };
}

const orders = (s: RunningServer) => s.store.list<Order>('orders');

/* ---------- tests ---------- */

describe('selling with the network gone, over the real server', () => {
  it('gets a pass after sign-in without anyone asking', async () => {
    const { t } = await setup();
    const st = t.client.offline.status();
    expect(st.canSell).toBe(true);
    expect(st.waiting).toBe(0);
    expect(st.salesLeft).toBe(50);
  });

  it('sells normally when online: nothing is queued', async () => {
    const { server, t, a, sale } = await setup();
    const r = await t.client.offline.quickSale(sale(a));
    expect(r.ok && r.queued).toBe(false);
    expect((await orders(server)).length).toBe(1);
    expect(t.client.offline.status().waiting).toBe(0);
  });

  it('saves sales while the network is down, then sends them when it comes back, each sold exactly once', async () => {
    const { server, t, a, b, sale } = await setup();
    t.net.down = true;
    const t0 = Date.now();
    const r1 = await t.client.offline.quickSale(sale(a, 2));
    const r2 = await t.client.offline.quickSale(sale(b));
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r1).toMatchObject({ ok: true, queued: true, seq: 1, total: a.price! * 2 });
    expect(r2).toMatchObject({ ok: true, queued: true, seq: 2 });
    expect(t.client.offline.status().waiting).toBe(2);
    expect((await orders(server)).length).toBe(0);

    t.net.down = false;
    expect((await t.client.offline.flush()).left).toBe(0);
    const os_ = await orders(server);
    expect(os_.length).toBe(2);
    expect(os_.every((o) => o.createdBy === t.userId)).toBe(true);
    expect((await server.store.list<Payment>('payments')).map((p) => p.amount).sort()).toEqual([a.price! * 2, b.price!].sort());
    const st = t.client.offline.status();
    expect(st.waiting).toBe(0);
    expect(st.notices).toEqual([]);
    expect(st.sent.map((x) => x.seq)).toEqual([2, 1]);
    expect(st.sent[0]!.number).toMatch(/-\d{4}$/);
    expect((await t.client.offline.flush()).left).toBe(0); // nothing to send, nothing changes
    expect((await orders(server)).length).toBe(2);
  });

  it('does not sell twice when the sale reached the server but the answer was lost', async () => {
    const { server, t, a, sale } = await setup();
    t.net.dropAnswers = 2; // the first try and its retry both reach the server; neither answer comes back
    const r = await t.client.offline.quickSale(sale(a));
    expect(r).toMatchObject({ ok: true, queued: true });
    expect((await orders(server)).length).toBe(1); // the server did make it
    await t.client.offline.flush();
    expect((await orders(server)).length).toBe(1); // and replaying the saved copy did not make a second
    expect(t.client.offline.status().waiting).toBe(0);
  });

  it('keeps the queue across a reload, and sends it with nobody signed in', async () => {
    const { server, t, a, sale } = await setup();
    t.net.down = true;
    await t.client.offline.quickSale(sale(a));
    t.client.close();
    // a brand new page, same device storage, still no network
    const again = await till(server, 'Counter', 'cashier', t);
    expect(again.client.offline.status().waiting).toBe(1);
    again.client.offline.clearNotices();
    expect(await again.client.signOut()).toBeDefined();
    const fresh = createClient({ ...t.options, tokenStore: { get: () => null, set: () => undefined } });
    cleanups.push(() => fresh.close());
    expect(fresh.offline.status().waiting).toBe(1);
    t.net.down = false; // the wifi is back
    expect((await fresh.offline.flush()).left).toBe(0);
    expect((await orders(server)).length).toBe(1);
  });

  it('wipes the pass key at sign-out, so the next person cannot sell as the last one', async () => {
    const { t, a, sale } = await setup();
    t.net.down = true;
    await t.client.offline.quickSale(sale(a));
    t.net.down = false;
    await t.client.signOut();
    expect(t.offlineStore.value).not.toMatch(/"key"/);
    expect(t.client.offline.status().canSell).toBe(false);
    expect(t.client.offline.status().waiting).toBe(1); // the sale already saved is still there to be sent
    t.net.down = true;
    const r = await t.client.offline.quickSale(sale(a));
    expect(r.ok).toBe(false);
  });

  it('refuses a sale on this till once the limits are used up, in plain words', async () => {
    const { t, a, sale } = await setup({ offlineMaxSales: 2 });
    t.net.down = true;
    expect((await t.client.offline.quickSale(sale(a))).ok).toBe(true);
    expect((await t.client.offline.quickSale(sale(a))).ok).toBe(true);
    const third = await t.client.offline.quickSale(sale(a));
    expect(!third.ok && third.error.messages.join(' ')).toMatch(/limit/);
    expect(t.client.offline.status().waiting).toBe(2);
  });

  it('refuses a sale that would take the offline money over the limit', async () => {
    const { t, a, sale } = await setup({ offlineMaxTotal: 1 });
    t.net.down = true;
    const r = await t.client.offline.quickSale(sale(a));
    expect(!r.ok && r.error.messages.join(' ')).toMatch(/over the limit/);
  });

  it('says plainly that it cannot sell offline when no pass was given', async () => {
    const server = await boot();
    const t = await till(server, 'Counter'); // the owner never switched offline selling on
    t.net.down = true;
    const [a] = await cakes(server);
    const r = await t.client.offline.quickSale({ items: [{ combinationId: a!.id, qty: 1 }], method: 'cash', expectedTotal: a!.price! });
    expect(!r.ok && r.error.messages.join(' ')).toMatch(/not set up to sell offline/);
  });

  it('a queue edited on the device is refused by the server, the owner can see it, and nothing is sold', async () => {
    const { server, t, a, sale } = await setup();
    t.net.down = true;
    await t.client.offline.quickSale(sale(a));
    t.net.down = false;
    const stored = JSON.parse(t.offlineStore.value!);
    const pass = Object.values(stored.passes)[0] as { queue: Array<{ payload: { items: Array<{ qty: number }>; expectedTotal: number } }> };
    pass.queue[0]!.payload.items[0]!.qty = 9; // the cashier tries to change what was sold
    t.offlineStore.value = JSON.stringify(stored);
    await t.client.offline.flush();
    expect((await orders(server)).length).toBe(0);
    const st = t.client.offline.status();
    expect(st.waiting).toBe(0);
    expect(st.notices).toHaveLength(1);
    expect(st.notices[0]).toMatchObject({ kind: 'refused', seq: 1 });
    expect(st.notices[0]!.message).toMatch(/changed after it was made/);
    // the pass the server did not trust is retired, and the till asks for a fresh one so it can sell offline again
    await waitFor(() => t.client.offline.status().canSell);
    const audit = (await server.store.list<{ id: string; intent: string; outcome: string }>('audit')).filter((x) => x.intent === 'offline/replay' && x.outcome === 'denied');
    expect(audit).toHaveLength(1);
  });

  it('a queue sent from a device that was revoked meanwhile is refused as a whole, and kept on view', async () => {
    const { server, owner, t, a, sale } = await setup();
    t.net.down = true;
    await t.client.offline.quickSale(sale(a));
    const devices = await owner.client.feed('device_list', {});
    if (!devices.ok) throw new Error('device list');
    const id = devices.data.devices.find((d) => d.name === 'Counter')!.id;
    expect((await owner.client.dispatch('devices/revoke', { deviceId: id })).ok).toBe(true);
    t.net.down = false;
    await t.client.offline.flush();
    expect((await orders(server)).length).toBe(0);
    const st = t.client.offline.status();
    expect(st.waiting).toBe(0);
    expect(st.notices[0]).toMatchObject({ kind: 'stuck', seq: 1, total: a.price });
  });

  it('a sale whose price changed while offline is held, shown to the owner, and approved at the new price', async () => {
    const { server, owner, t, a, sale } = await setup();
    t.net.down = true;
    await t.client.offline.quickSale(sale(a));
    expect((await owner.client.dispatch('catalogue/set_price', { combinationId: a.id, price: a.price! + 700 })).ok).toBe(true);
    t.net.down = false;
    await t.client.offline.flush();
    expect((await orders(server)).length).toBe(0);
    expect(t.client.offline.status().notices[0]).toMatchObject({ kind: 'held' });
    const view = await owner.client.feed('offline_review', {});
    if (!view.ok) throw new Error('review feed');
    expect(view.data.held).toHaveLength(1);
    const ok = await owner.client.dispatch('offline/review', { heldId: view.data.held[0]!.id, action: 'approve' });
    expect(ok.ok).toBe(true);
    const [o] = await orders(server);
    expect(o!.createdBy).toBe(t.userId);
    expect((await server.store.list<Payment>('payments'))[0]!.amount).toBe(a.price! + 700);
  });

  it('shares nothing between tills: another till cannot send this till\'s queue', async () => {
    const { server, t, a, sale } = await setup();
    const other = await till(server, 'Counter 2');
    t.net.down = true;
    await t.client.offline.quickSale(sale(a));
    const stolen = t.offlineStore.value!;
    other.offlineStore.value = stolen; // the queue copied onto another registered till
    await other.client.offline.flush();
    expect((await orders(server)).length).toBe(0);
    expect(other.client.offline.status().notices[0]?.kind).toBe('stuck');
  });
});
