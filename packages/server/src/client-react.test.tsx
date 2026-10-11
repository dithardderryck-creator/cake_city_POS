// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createClient, type Client, type ClientOptions } from '@cake-pos/client';
import { ClientProvider, useConnection, useFeed, useRun, useSession } from '@cake-pos/client/react';
import { seedDemo } from '@cake-pos/panel';
import { startServer, type RunningServer } from './app';
import { loadConfig } from './config';
import { createLogger } from './log';
import { createScryptHasher } from './scrypt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  cleanup();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const dirs = new WeakMap<RunningServer, string>();
async function boot(): Promise<RunningServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-react-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', REQUIRE_DEVICE: '0' });
  const log = createLogger({ level: 'error', dir: path.join(dataDir, 'logs'), stdout: false });
  const server = await startServer({ config, log });
  cleanups.push(async () => {
    await server.close();
    log.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await seedDemo(server.store, server.panel, createScryptHasher());
  dirs.set(server, dataDir);
  return server;
}

const PINS = { owner: '1111', cashier: '2222' } as const;

function newClient(server: RunningServer, store: { t: string | null }, extra: Partial<ClientOptions> = {}): Client {
  const c = createClient({
    baseUrl: server.url,
    WebSocket: WebSocket as unknown as ClientOptions['WebSocket'],
    tokenStore: { get: () => store.t, set: (t) => void (store.t = t) },
    ...extra,
  });
  cleanups.push(() => c.close());
  return c;
}

const wrap = (client: Client) => ({ children }: { children: ReactNode }) => createElement(ClientProvider, { client, children });
const idOf = async (c: Client, role: string) => (await c.staff()).find((s) => s.role === role)!.id;

describe('React hooks against a real server', () => {
  it('signs in and out through useSession', async () => {
    const server = await boot();
    const client = newClient(server, { t: null });
    const { result } = renderHook(() => useSession(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));

    const id = await idOf(client, 'cashier');
    let r: Awaited<ReturnType<typeof result.current.signIn>> | undefined;
    await act(async () => void (r = await result.current.signIn(id, PINS.cashier)));
    expect(r?.ok).toBe(true);
    expect(result.current.status).toBe('signedIn');
    expect(result.current.session?.role).toBe('cashier');

    await act(async () => void (await result.current.signOut()));
    expect(result.current.status).toBe('signedOut');
    expect(client.signedIn).toBe(false);
  });

  it('restores a saved sign-in after a page reload', async () => {
    const server = await boot();
    const store = { t: null as string | null };
    const first = newClient(server, store);
    await first.signIn(await idOf(first, 'owner'), PINS.owner);
    expect(store.t).toBeTruthy();

    const reloaded = newClient(server, store); // new page, same saved token
    const { result } = renderHook(() => useSession(), { wrapper: wrap(reloaded) });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    expect(result.current.session?.role).toBe('owner');
  });

  it('notices when the server ends the sign-in from elsewhere', async () => {
    const server = await boot();
    const owner = newClient(server, { t: null });
    await owner.signIn(await idOf(owner, 'owner'), PINS.owner);

    const store = { t: null as string | null };
    const till = newClient(server, store);
    const { result } = renderHook(() => ({ s: useSession(), f: useFeed('navigation', {}) }), { wrapper: wrap(till) });
    await waitFor(() => expect(result.current.s.status).toBe('signedOut'));
    const cashierId = await idOf(till, 'cashier');
    await act(async () => void (await result.current.s.signIn(cashierId, PINS.cashier)));
    await waitFor(() => expect(till.connection).toBe('online'));

    await owner.dispatch('staff/set_active', { userId: cashierId, active: false });
    await waitFor(() => expect(result.current.s.status).toBe('signedOut'));
    expect(result.current.s.session).toBeNull();
    expect(store.t).toBeNull();
  });

  it('notices when a plain request finds the sign-in was ended, with no live connection open', async () => {
    const server = await boot();
    const owner = newClient(server, { t: null });
    await owner.signIn(await idOf(owner, 'owner'), PINS.owner);

    const store = { t: null as string | null };
    const till = newClient(server, store);
    const { result } = renderHook(() => useSession(), { wrapper: wrap(till) }); // no feeds, so no socket
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    const cashierId = await idOf(till, 'cashier');
    await act(async () => void (await result.current.signIn(cashierId, PINS.cashier)));
    expect(result.current.status).toBe('signedIn');
    expect(till.connection).not.toBe('online');

    await owner.dispatch('staff/set_active', { userId: cashierId, active: false });
    await act(async () => void (await till.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' })));
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    expect(store.t).toBeNull();
  });

  it('updates a feed by itself when someone else changes something', async () => {
    const server = await boot();
    const owner = newClient(server, { t: null });
    await owner.signIn(await idOf(owner, 'owner'), PINS.owner);
    const cashier = newClient(server, { t: null });
    await cashier.signIn(await idOf(cashier, 'cashier'), PINS.cashier);

    const { result } = renderHook(() => useFeed('order_list', {}), { wrapper: wrap(owner) });
    await waitFor(() => expect(result.current.data).toEqual([]));
    await cashier.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.stale).toBe(false);
  });

  it('marks data stale while the connection is down and recovers by itself', async () => {
    const server = await boot();
    const owner = newClient(server, { t: null });
    await owner.signIn(await idOf(owner, 'owner'), PINS.owner);
    const { result } = renderHook(() => ({ f: useFeed('order_list', {}), c: useConnection() }), { wrapper: wrap(owner) });
    await waitFor(() => expect(result.current.f.data).toEqual([]));
    await waitFor(() => expect(result.current.c).toBe('online'));

    const port = server.port;
    await server.close();
    await waitFor(() => expect(result.current.f.stale).toBe(true));
    expect(result.current.f.data).toEqual([]); // the last data is kept, and labelled stale

    // restart on the same data and port
    const dataDir = dirs.get(server)!;
    const config = loadConfig({ DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', REQUIRE_DEVICE: '0' });
    const log = createLogger({ level: 'error', dir: path.join(dataDir, 'logs'), stdout: false });
    const again = await startServer({ config, log });
    cleanups.push(async () => {
      await again.close();
      log.close();
    });
    await waitFor(() => expect(result.current.c).toBe('online'), { timeout: 15_000 });
    expect(result.current.f.stale).toBe(false);
  }, 25_000);

  it('runs instructions through useRun', async () => {
    const server = await boot();
    const cashier = newClient(server, { t: null });
    await cashier.signIn(await idOf(cashier, 'cashier'), PINS.cashier);
    const { result } = renderHook(() => useRun(), { wrapper: wrap(cashier) });
    let r: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => void (r = await result.current('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' })));
    expect(r?.ok).toBe(true);
    let bad: typeof r;
    await act(async () => void (bad = await result.current('staff/set_active', { userId: 'x', active: false })));
    expect(bad?.ok).toBe(false); // a cashier may not do this
  });
});
