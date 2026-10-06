import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64, type AuditEntry, type Order, type OrderLine, type Payment, type Photo, type PhotoData, type Quote, type Refund, type Staff, type UsageReport } from '@cake-pos/panel';
import { createArchiveService, isArchivable, type ArchiveService } from './archive';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { createDriveClient, DriveError } from './google-drive';
import { createLogger } from './log';
import { openSqliteStore, type SqliteStore } from './sqlite-store';
import { readXlsx } from './xlsx';

const NOW = new Date(2026, 9, 6, 12, 0, 0); // 6 Oct 2026, local noon
const clock = { now: () => NOW };
const day = (ago: number) => {
  const d = new Date(NOW.getTime() - ago * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let store: SqliteStore;
let dir: string;
let google: FakeGoogle;
let events: string[];
let seq = 0;

beforeEach(async () => {
  store = openSqliteStore(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
  google = await startFakeGoogle();
  events = [];
  seq = 0;
  await store.put<Staff>('staff', { id: 'u1', name: 'Amina', role: 'owner', pinHash: 'x', active: true });
});
afterEach(async () => {
  store.close();
  await google.close();
});

interface Spec {
  ageDays: number;
  /** Item price, paid in full unless `paid` says otherwise. */
  price?: number;
  paid?: number;
  lineStatus?: OrderLine['status'];
  refunded?: number;
  name?: string;
}
async function order(spec: Spec): Promise<Order> {
  const n = ++seq;
  const o: Order = {
    id: `ord${n}`,
    number: `S-${String(n).padStart(4, '0')}`,
    customerName: spec.name ?? `Customer ${n}`,
    source: 'walk_in',
    fulfilment: 'pickup',
    deliveryDate: day(spec.ageDays),
    partialAllowed: false,
    createdBy: 'u1',
    createdAt: new Date(NOW.getTime() - (spec.ageDays + 2) * 86_400_000).toISOString(),
  };
  const price = spec.price ?? 100;
  await store.put('orders', o);
  await store.put<OrderLine>('orderLines', { id: `ln${n}`, orderId: o.id, type: 'catalogue', qty: 1, snapshot: { productName: 'Chocolate cake', options: { Size: 'Small' }, unitPrice: price, allergens: [] }, status: spec.lineStatus ?? 'completed' });
  const paid = spec.paid ?? (spec.lineStatus === 'cancelled' ? 0 : price);
  if (paid > 0) await store.put<Payment>('payments', { id: `pay${n}`, orderId: o.id, method: 'cash', amount: paid, receivedBy: 'u1', receivedAt: o.createdAt });
  if (spec.refunded) await store.put<Refund>('refunds', { id: `ref${n}`, orderId: o.id, amount: spec.refunded, reason: 'Customer cancelled', method: 'cash', approvedBy: 'u1', at: o.createdAt });
  return o;
}
const count = (c: Parameters<SqliteStore['list']>[0]) => store.list(c).then((r) => r.length);

function service(over: { drive?: boolean; backup?: () => Promise<unknown>; used?: () => number; settings?: Parameters<typeof createArchiveService>[0]['settings'] } = {}): ArchiveService {
  const drive = over.drive === false ? null : { client: createDriveClient({ clientId: 'i', clientSecret: 's', refreshToken: 'r', folderName: 'Cake POS' }, { endpoints: google.endpoints }), folderName: 'Cake POS' };
  return createArchiveService({
    store,
    exclusive: async (fn) => fn(),
    dir,
    statePath: path.join(dir, 'archive-state.json'),
    drive,
    backupNow: over.backup ?? (async () => void events.push('backup')),
    usedBytes: over.used ?? (() => 1000),
    settings: over.settings,
    log: createLogger({ level: 'error', stdout: false }),
    clock,
  });
}

describe('which orders are finished', () => {
  const bundle = async (spec: Spec, extra: { quote?: Partial<Quote>; report?: Partial<UsageReport> } = {}) => {
    const o = await order(spec);
    const [lines, payments, refunds] = await Promise.all([store.find<OrderLine>('orderLines', { where: { orderId: o.id } }), store.find<Payment>('payments', { where: { orderId: o.id } }), store.find<Refund>('refunds', { where: { orderId: o.id } })]);
    const quotes = extra.quote ? [{ id: 'q', orderId: o.id, status: 'sent', ...extra.quote } as Quote] : [];
    const reports = extra.report ? [{ id: 'r', orderId: o.id, status: 'reported', items: [], ...extra.report } as UsageReport] : [];
    return { order: o, lines, payments, refunds, quotes, reports, suggestions: [], photos: [] };
  };
  const ok = (b: Awaited<ReturnType<typeof bundle>>) => isArchivable(b, day(0), 90);

  it('takes old, handed-over, fully paid orders', async () => expect(ok(await bundle({ ageDays: 120 }))).toBe(true));
  it('leaves recent ones', async () => expect(ok(await bundle({ ageDays: 30 }))).toBe(false));
  it('leaves orders that are not handed over', async () => expect(ok(await bundle({ ageDays: 120, lineStatus: 'ready' }))).toBe(false));
  it('leaves orders with money still owed', async () => expect(ok(await bundle({ ageDays: 120, paid: 40 }))).toBe(false));
  it('takes a cancelled order whose money was all given back, but not one still holding money', async () => {
    expect(ok(await bundle({ ageDays: 120, lineStatus: 'cancelled', paid: 100, refunded: 100 }))).toBe(true);
    expect(ok(await bundle({ ageDays: 120, lineStatus: 'cancelled', paid: 100 }))).toBe(false);
  });
  it('leaves orders with a price request or a usage report still waiting', async () => {
    expect(ok(await bundle({ ageDays: 120 }, { quote: { status: 'seen' } }))).toBe(false);
    expect(ok(await bundle({ ageDays: 120 }, { report: { status: 'reported' } }))).toBe(false);
    expect(ok(await bundle({ ageDays: 120 }, { report: { status: 'confirmed' } }))).toBe(true);
  });
});

describe('archiving', () => {
  it('moves old finished orders into a spreadsheet saved locally and in Google Drive, and removes them from the database', async () => {
    const old1 = await order({ ageDays: 200, name: 'Amina & Sons' });
    const old2 = await order({ ageDays: 150, price: 55.5 });
    const recent = await order({ ageDays: 10 });
    const unpaid = await order({ ageDays: 200, paid: 10 });
    await store.put('counters', { id: 'order_seq', value: 4 });
    const result = await service().run({ force: true });

    expect(result.batches).toHaveLength(1);
    const batch = result.batches[0]!;
    expect(batch).toMatchObject({ kind: 'orders', count: 2, firstNumber: old1.number, lastNumber: old2.number });

    // The spreadsheet on this computer.
    const sheets = readXlsx(fs.readFileSync(batch.localFile));
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Orders', 'Items', 'Payments']);
    const orders = sheets.find((s) => s.name === 'Orders')!.rows;
    expect(orders[0]![0]).toBe('Number');
    expect(orders.slice(1).map((r) => [r[0], r[1], r[9], r[10], r[12]])).toEqual([
      [old1.number, 'Amina & Sons', '100', '100', '0'],
      [old2.number, 'Customer 2', '55.5', '55.5', '0'],
    ]);
    expect(sheets.find((s) => s.name === 'Items')!.rows[1]!.slice(0, 7)).toEqual([old1.number, 'ln1', 'catalogue', 'Chocolate cake (Small)', '1', '100', 'completed']);

    // The Google Sheet.
    const file = [...google.files.values()].find((f) => f.name === batch.name)!;
    expect(file.mimeType).toBe('application/vnd.google-apps.spreadsheet');
    expect(batch.driveFileId).toBe(file.id);
    const folders = [...google.files.values()].filter((f) => f.mimeType.endsWith('folder')).map((f) => f.name);
    expect(folders).toEqual(['Cake POS', 'Archive']);

    // The database.
    expect((await store.list<Order>('orders')).map((o) => o.id).sort()).toEqual([recent.id, unpaid.id].sort());
    expect(await count('orderLines')).toBe(2);
    expect(await count('payments')).toBe(2);
    // Order numbers keep counting from where they were.
    expect(await store.get('counters', 'order_seq')).toMatchObject({ value: 4 });
  });

  it('writes both copies and takes a backup BEFORE anything is removed', async () => {
    await order({ ageDays: 200 });
    let stateAtBackup: { rows: number; local: boolean; drive: boolean } | null = null;
    const svc = service({
      backup: async () => {
        stateAtBackup = { rows: await count('orders'), local: fs.readdirSync(dir).some((f) => f.endsWith('.xlsx')), drive: [...google.files.values()].some((f) => f.mimeType.includes('spreadsheet')) };
      },
    });
    await svc.run({ force: true });
    expect(stateAtBackup).toEqual({ rows: 1, local: true, drive: true });
    expect(await count('orders')).toBe(0);
  });

  it('removes nothing when Google Drive is unreachable, cleans up, and succeeds on the next try', async () => {
    await order({ ageDays: 200 });
    google.failNext(503, 50);
    await expect(service().run({ force: true })).rejects.toBeInstanceOf(DriveError);
    expect(await count('orders')).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.xlsx') || f.endsWith('.part'))).toEqual([]);
    expect(events).toEqual([]); // no backup was needed because nothing was going to change
    google.failNext(200, 0);
    const svc = service();
    const result = await svc.run({ force: true });
    expect(result.batches[0]!.count).toBe(1);
    expect(await count('orders')).toBe(0);
    expect(svc.status().lastError).toBeNull();
  });

  it('removes nothing when the backup fails, and takes the uploaded copy back', async () => {
    await order({ ageDays: 200 });
    const svc = service({ backup: async () => Promise.reject(new Error('disk full')) });
    await expect(svc.run({ force: true })).rejects.toThrow('disk full');
    expect(await count('orders')).toBe(1);
    expect([...google.files.values()].filter((f) => f.mimeType.includes('spreadsheet'))).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.xlsx'))).toEqual([]);
    expect(svc.status().lastError).toBe('disk full');
  });

  it('works without Google Drive: the local spreadsheet alone is enough', async () => {
    await order({ ageDays: 200 });
    const result = await service({ drive: false }).run({ force: true });
    expect(result.batches[0]!.driveFileId).toBeUndefined();
    expect(fs.existsSync(result.batches[0]!.localFile)).toBe(true);
    expect(await count('orders')).toBe(0);
  });

  it('leaves an order alone if it changed while the files were being written', async () => {
    const a = await order({ ageDays: 200 });
    await order({ ageDays: 200 });
    const svc = service({
      backup: async () => {
        await store.put<Payment>('payments', { id: 'late', orderId: a.id, method: 'cash', amount: 5, receivedBy: 'u1', receivedAt: NOW.toISOString() });
      },
    });
    await svc.run({ force: true, minAgeDays: 90 }).catch(() => undefined);
    expect((await store.list<Order>('orders')).map((o) => o.id)).toEqual([a.id]);
    expect(await count('payments')).toBe(2);
  });

  it('keeps reference photos in a folder beside the spreadsheet and removes them from the database', async () => {
    const o = await order({ ageDays: 200 });
    await store.put<Photo>('photos', { id: 'ph1', mime: 'image/png', size: 4, uploadedBy: 'u1', uploadedAt: o.createdAt, attachedTo: 'ln1', orderId: o.id });
    await store.put<PhotoData>('photoData', { id: 'ph1', data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) });
    const result = await service().run({ force: true });
    const photo = path.join(`${result.batches[0]!.localFile.replace(/\.xlsx$/, '')}-photos`, 'ph1.png');
    expect([...fs.readFileSync(photo)]).toEqual([1, 2, 3, 4]);
    expect(await count('photos')).toBe(0);
    expect(await count('photoData')).toBe(0);
    const summary = readXlsx(fs.readFileSync(result.batches[0]!.localFile))[0]!.rows;
    expect(summary.find((r) => r[0] === 'Reference photos')![1]).toMatch(/1 saved on the shop computer/);
  });

  it('a dry run reports what it would do and changes nothing', async () => {
    await order({ ageDays: 200 });
    await order({ ageDays: 5 });
    const result = await service().run({ force: true, dryRun: true });
    expect(result.wouldArchive).toEqual({ orders: 1, activity: 0 });
    expect(await count('orders')).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(google.files.size).toBe(0);
  });

  it('archives old activity-log entries and keeps recent ones', async () => {
    const entry = (i: number, ageDays: number): AuditEntry => ({ id: `a${i}`, at: new Date(NOW.getTime() - ageDays * 86_400_000).toISOString(), actorName: 'Amina', role: 'owner', intent: 'orders/create_order', summary: `Started order ${i}`, outcome: 'ok' });
    await store.put('audit', entry(1, 400));
    await store.put('audit', entry(2, 380));
    await store.put('audit', entry(3, 20));
    const result = await service().run({ force: true });
    expect(result.batches.map((b) => [b.kind, b.count])).toEqual([['activity', 2]]);
    expect((await store.list<AuditEntry>('audit')).map((e) => e.id)).toEqual(['a3']);
    const rows = readXlsx(fs.readFileSync(result.batches[0]!.localFile)).find((s) => s.name === 'Activity')!.rows;
    expect(rows.slice(1).map((r) => r[5])).toEqual(['Started order 1', 'Started order 2']);
  });
});

describe('when it runs by itself', () => {
  it('does nothing until the database is full', async () => {
    await order({ ageDays: 200 });
    const result = await service({ used: () => 10, settings: { whenFullBytes: 1000 } }).check();
    expect(result).toMatchObject({ ran: false });
    expect(await count('orders')).toBe(1);
  });

  it('stops as soon as there is comfortable room', async () => {
    for (let i = 0; i < 6; i++) await order({ ageDays: 200 + i });
    let used = 1000;
    const svc = service({
      used: () => used,
      settings: { whenFullBytes: 1000, batchOrders: 2 },
      backup: async () => void (used -= 150),
    });
    const result = await svc.check();
    // 1000 -> 850 -> 700 -> 550; below 80% (800) after the second batch.
    expect(result.batches.map((b) => b.count)).toEqual([2, 2]);
    expect(await count('orders')).toBe(2);
    expect(svc.status()).toMatchObject({ totalOrdersArchived: 4, driveConnected: true });
  });

  it('forced runs keep going until nothing old is left', async () => {
    for (let i = 0; i < 5; i++) await order({ ageDays: 200 + i });
    const result = await service({ settings: { batchOrders: 2 } }).run({ force: true });
    expect(result.batches.map((b) => b.count)).toEqual([2, 2, 1]);
    expect(await count('orders')).toBe(0);
  });

  it('never runs twice at once', async () => {
    await order({ ageDays: 200 });
    const svc = service();
    const [a, b] = await Promise.all([svc.run({ force: true }), svc.run({ force: true })]);
    expect(a).toBe(b);
    expect(a.batches).toHaveLength(1);
  });

  it('remembers what it did across restarts', async () => {
    await order({ ageDays: 200 });
    await service().run({ force: true });
    const again = service().status();
    expect(again.totalOrdersArchived).toBe(1);
    expect(again.recent[0]).toMatchObject({ kind: 'orders', count: 1 });
    expect(again.lastRunAt).not.toBeNull();
  });
});
