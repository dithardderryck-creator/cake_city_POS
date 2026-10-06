import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createClient, type ClientOptions } from '@cake-pos/client';
import { seedDemo, type Order, type OrderLine, type Payment } from '@cake-pos/panel';
import { startServer, type RunningServer } from './app';
import { loadConfig } from './config';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { saveDriveCredentials } from './google-drive';
import { createLogger } from './log';
import { createScryptHasher } from './scrypt';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(google: FakeGoogle | null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-online-'));
  cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  if (google) saveDriveCredentials(path.join(dataDir, 'google-drive.json'), { clientId: 'i', clientSecret: 's', refreshToken: 'r', folderName: 'Cake POS', account: 'owner@example.com' });
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' });
  const log = createLogger({ level: 'error', stdout: false });
  const server = await startServer({ config, log, driveDeps: google ? { endpoints: google.endpoints } : undefined });
  cleanups.push(async () => {
    await server.close();
    log.close();
  });
  await seedDemo(server.store, server.panel, createScryptHasher());
  const client = createClient({ baseUrl: server.url, WebSocket: WebSocket as unknown as ClientOptions['WebSocket'] });
  cleanups.push(() => client.close());
  const owner = (await client.staff()).find((s) => s.role === 'owner')!;
  const r = await client.signIn(owner.id, '1111');
  if (!r.ok) throw new Error('sign in failed');
  return { server, client, dataDir };
}

async function oldOrder(server: RunningServer, n: number) {
  const o: Order = { id: `old${n}`, number: `S-${String(n).padStart(4, '0')}`, customerName: `Old customer ${n}`, source: 'walk_in', fulfilment: 'pickup', deliveryDate: '2026-03-01', partialAllowed: false, createdBy: 'x', createdAt: '2026-02-27T09:00:00.000Z' };
  await server.store.put('orders', o);
  await server.store.put<OrderLine>('orderLines', { id: `oldline${n}`, orderId: o.id, type: 'catalogue', qty: 1, snapshot: { productName: 'Vanilla cake', options: {}, unitPrice: 40, allergens: [] }, status: 'completed' });
  await server.store.put<Payment>('payments', { id: `oldpay${n}`, orderId: o.id, method: 'cash', amount: 40, receivedBy: 'x', receivedAt: o.createdAt });
}

describe('the shop with its database online', () => {
  it('copies backups to Google Drive and archives old orders to a Google Sheet, while the app keeps working', async () => {
    const google = await startFakeGoogle();
    cleanups.push(() => google.close());
    const { server, client } = await boot(google);

    await oldOrder(server, 1);
    await oldOrder(server, 2);
    await server.store.put('counters', { id: 'order_seq', value: 2 });

    const before = await client.feed('order_list', {});
    expect(before.ok && before.data.map((o) => o.number).sort()).toEqual(['S-0001', 'S-0002']);

    const result = await server.archive.run({ force: true });
    expect(result.batches).toMatchObject([{ kind: 'orders', count: 2 }]);

    // The orders are gone from the live database and the app still answers.
    const after = await client.feed('order_list', {});
    expect(after.ok && after.data).toEqual([]);

    // Drive has the Google Sheet and the backup that was taken first.
    const files = [...google.files.values()];
    expect(files.find((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet')?.name).toMatch(/^cakepos-orders-S-0001-to-S-0002/);
    await server.backup.processUploads();
    expect(files.length).toBeGreaterThan(0);
    expect([...google.files.values()].some((f) => /^cakepos-\d{8}-\d{6}\.sqlite$/.test(f.name))).toBe(true);

    // New orders carry on from the old numbering.
    const made = await client.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    expect(made.ok && (made.data as { number: string }).number).toBe('S-0003');

    // IT can see the state of the online copy.
    const it = createClient({ baseUrl: server.url, WebSocket: WebSocket as unknown as ClientOptions['WebSocket'] });
    cleanups.push(() => it.close());
    const itUser = (await it.staff()).find((x) => x.role === 'it')!;
    await it.signIn(itUser.id, '9999');
    const info = await it.feed('panel_map', {});
    const text = JSON.stringify(info.ok ? info.data : info);
    expect(text).toContain('owner@example.com');
    expect(text).toContain('2 orders archived');
  });

  it('runs fine with no Google account connected: archives to the local folder only', async () => {
    const { server, dataDir } = await boot(null);
    expect(server.cloud).toBeNull();
    await oldOrder(server, 1);
    const result = await server.archive.run({ force: true });
    expect(result.batches[0]!.driveFileId).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, 'archive', `${result.batches[0]!.name}.xlsx`))).toBe(true);
    expect((await server.store.list('orders')).length).toBe(0);
  });

  it('does nothing by itself while the database is small', async () => {
    const { server } = await boot(null);
    await oldOrder(server, 1);
    expect((await server.archive.check()).ran).toBe(false);
    expect((await server.store.list('orders')).length).toBe(1);
  });
});
