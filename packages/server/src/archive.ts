import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  base64ToBytes,
  deriveOrderStatus,
  moneySummary,
  todayLocal,
  type AuditEntry,
  type Clock,
  type Ingredient,
  type Order,
  type OrderLine,
  type Payment,
  type Photo,
  type PhotoData,
  type Quote,
  type Refund,
  type Staff,
  type Store,
  type UsageReport,
  type UsageSuggestion,
} from '@cake-pos/panel';
import { stamp } from './backup';
import { GOOGLE_SHEET_MIME, XLSX_MIME, type DriveClient, type DriveFile } from './google-drive';
import { errorFields, type Logger } from './log';
import { buildXlsx, readXlsx, type Cell, type Sheet } from './xlsx';

/**
 * Archiving. When the database gets big, old finished orders move out of it into a spreadsheet kept in two places:
 * a folder on the shop computer (or wherever the owner points `ARCHIVE_DIR`) and, when Google Drive is connected, a
 * Google Sheet in the shop's Drive folder.
 *
 * The order of events is the safety. Nothing is removed from the database until
 *   1. the spreadsheet is written locally and read back with the same row counts,
 *   2. it is uploaded to Drive (when connected),
 *   3. a fresh, verified backup of the database exists.
 * If any step fails, nothing is deleted and the next run starts over.
 */

const DAY_MS = 86_400_000;

export interface ArchiveSettings {
  /** The database counts as "full" when the data in it reaches this many bytes. */
  whenFullBytes: number;
  /** An order must be this many days past its delivery date (or its creation) to be archived. */
  minAgeDays: number;
  /** Activity-log entries older than this many days are archived too. */
  auditKeepDays: number;
  /** Orders per spreadsheet. */
  batchOrders: number;
}

export const DEFAULT_ARCHIVE: ArchiveSettings = { whenFullBytes: 500 * 1_048_576, minAgeDays: 90, auditKeepDays: 365, batchOrders: 1000 };
const AUDIT_BATCH = 20_000;
const MAX_BATCHES_PER_RUN = 25;

export interface ArchivedBatch {
  kind: 'orders' | 'activity';
  name: string;
  at: string;
  /** Orders, or activity entries. */
  count: number;
  localFile: string;
  driveFileId?: string;
  driveLink?: string;
  firstNumber?: string;
  lastNumber?: string;
}

interface ArchiveState {
  batches: ArchivedBatch[];
  lastRunAt: string | null;
  lastError: string | null;
}

export interface ArchiveResult {
  ran: boolean;
  reason: string;
  batches: ArchivedBatch[];
  /** What a dry run found (nothing is written or removed). */
  wouldArchive?: { orders: number; activity: number };
}

export interface ArchiveStatus {
  usedMb: number;
  whenFullMb: number;
  full: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  totalOrdersArchived: number;
  driveConnected: boolean;
  folder: string;
  recent: ArchivedBatch[];
}

export interface ArchiveService {
  /** Archive now. `force` ignores "is the database full yet". `minAgeDays` overrides the setting for this run. */
  run(opts?: { force?: boolean; dryRun?: boolean; minAgeDays?: number }): Promise<ArchiveResult>;
  /** The hourly check: archives only if the database is full. */
  check(): Promise<ArchiveResult>;
  status(): ArchiveStatus;
  start(): void;
  stop(): void;
}

export interface ArchiveOptions {
  store: Store;
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Where the spreadsheets are kept on this computer. */
  dir: string;
  statePath: string;
  drive: { client: DriveClient; folderName: string } | null;
  /** Takes a verified backup (and starts uploading it). Called before anything is removed. */
  backupNow: () => Promise<unknown>;
  /** Bytes of real data in the database (not the file size, which does not shrink when rows are removed). */
  usedBytes: () => number;
  settings?: Partial<ArchiveSettings>;
  log: Logger;
  clock?: Clock;
}

/* ---------- Choosing what to archive ---------- */

interface OrderBundle {
  order: Order;
  lines: OrderLine[];
  payments: Payment[];
  refunds: Refund[];
  quotes: Quote[];
  reports: UsageReport[];
  suggestions: UsageSuggestion[];
  photos: Photo[];
}

const byOrder = <T extends { orderId?: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) if (r.orderId) m.set(r.orderId, [...(m.get(r.orderId) ?? []), r]);
  return m;
};

async function loadBundle(store: Store, order: Order): Promise<OrderBundle> {
  const where = { orderId: order.id };
  const [lines, payments, refunds, quotes, reports, suggestions, photos] = await Promise.all([
    store.find<OrderLine>('orderLines', { where }),
    store.find<Payment>('payments', { where }),
    store.find<Refund>('refunds', { where }),
    store.find<Quote>('quotes', { where }),
    store.find<UsageReport>('usageReports', { where }),
    store.find<UsageSuggestion>('usageSuggestions', { where }),
    store.find<Photo>('photos', { where }),
  ]);
  return { order, lines, payments, refunds, quotes, reports, suggestions, photos };
}

const fingerprint = (b: OrderBundle) => createHash('sha256').update(JSON.stringify(b)).digest('hex');

/** Finished means: handed over or cancelled, with the money settled. Anything still open stays in the database. */
export function isArchivable(b: OrderBundle, today: string, minAgeDays: number): boolean {
  const status = deriveOrderStatus(b.lines);
  const money = moneySummary(b.lines, b.payments, b.refunds);
  const settled = money.balance === 0 && money.overpaid === 0;
  if (status === 'completed') {
    if (!settled) return false;
  } else if (status === 'cancelled') {
    // A cancelled order that still holds money (a refund not yet given) is not finished.
    if (money.net !== 0) return false;
  } else if (status === 'empty') {
    if (b.payments.length || b.refunds.length) return false;
  } else {
    return false;
  }
  if (b.quotes.some((q) => q.status === 'sent' || q.status === 'seen')) return false;
  if (b.reports.some((r) => r.status === 'reported')) return false;
  const reference = b.order.deliveryDate && b.order.deliveryDate > b.order.createdAt.slice(0, 10) ? b.order.deliveryDate : b.order.createdAt.slice(0, 10);
  const cutoff = new Date(`${today}T12:00:00`).getTime() - minAgeDays * DAY_MS;
  return new Date(`${reference}T12:00:00`).getTime() <= cutoff;
}

/* ---------- The spreadsheet ---------- */

interface Lookups {
  staff: Map<string, string>;
  ingredients: Map<string, Ingredient>;
}
const who = (l: Lookups, id?: string) => (id ? (l.staff.get(id) ?? id) : '');

export function orderSheets(bundles: OrderBundle[], l: Lookups, summary: Array<[string, Cell]>): Sheet[] {
  const num = new Map(bundles.map((b) => [b.order.id, b.order.number]));
  const orders: Cell[][] = [];
  const lines: Cell[][] = [];
  const payments: Cell[][] = [];
  const refunds: Cell[][] = [];
  const quotes: Cell[][] = [];
  const usage: Cell[][] = [];
  for (const b of bundles) {
    const o = b.order;
    const m = moneySummary(b.lines, b.payments, b.refunds);
    orders.push([o.number, o.customerName, o.source, o.fulfilment, o.deliveryDate, o.deliveryAddress, o.createdAt, who(l, o.createdBy), deriveOrderStatus(b.lines), m.total, m.paid, m.refunded, m.balance, m.status]);
    for (const x of b.lines) {
      const s = x.snapshot;
      const c = x.custom?.spec;
      lines.push([
        o.number,
        x.id,
        x.type,
        x.type === 'custom' ? `Custom cake: ${c?.flavor ?? ''}${c?.filling ? ` with ${c.filling}` : ''}` : `${s.productName}${Object.values(s.options).length ? ` (${Object.values(s.options).join(', ')})` : ''}`,
        x.qty,
        s.unitPrice,
        x.status,
        c ? JSON.stringify(c) : '',
        c?.photoIds.join(' ') ?? '',
      ]);
    }
    for (const p of b.payments) payments.push([o.number, p.receivedAt, p.method, p.amount, p.reference, who(l, p.receivedBy)]);
    for (const r of b.refunds) refunds.push([o.number, r.at, r.method, r.amount, r.reason, who(l, r.approvedBy)]);
    for (const q of b.quotes) quotes.push([o.number, q.requestedAt, q.requestedByName, q.status, q.price, q.note, q.answer, q.resolvedAt]);
    for (const r of b.reports) {
      for (const it of r.items) {
        const used = r.confirmed?.find((c) => c.ingredientId === it.ingredientId)?.qty;
        usage.push([o.number, r.status, r.reportedAt, r.reportedByName, r.confirmedByName, it.name, it.rangeLabel, used, it.unit, r.sentBackReason]);
      }
    }
  }
  return [
    { name: 'Summary', header: ['Item', 'Value'], rows: summary },
    { name: 'Orders', header: ['Number', 'Customer', 'Source', 'Pickup or delivery', 'Delivery date', 'Address', 'Created', 'Created by', 'Status', 'Total', 'Paid', 'Refunded', 'Balance', 'Payment status'], rows: orders },
    { name: 'Items', header: ['Order', 'Item id', 'Type', 'Description', 'Qty', 'Unit price', 'Status', 'Cake details (JSON)', 'Photo ids'], rows: lines },
    { name: 'Payments', header: ['Order', 'Received', 'Method', 'Amount', 'Reference', 'Received by'], rows: payments },
    { name: 'Refunds', header: ['Order', 'Date', 'Method', 'Amount', 'Reason', 'Approved by'], rows: refunds },
    { name: 'Quotes', header: ['Order', 'Requested', 'Requested by', 'Status', 'Price', 'Request note', 'Answer', 'Answered'], rows: quotes },
    { name: 'Ingredient use', header: ['Order', 'Report status', 'Reported', 'Reported by', 'Confirmed by', 'Ingredient', 'Amount chosen', 'Confirmed qty', 'Unit', 'Sent back because'], rows: usage },
  ].filter((s) => s.name === 'Summary' || s.name === 'Orders' || s.name === 'Items' || s.rows.length > 0) as Sheet[];
}

function activitySheets(entries: AuditEntry[], summary: Array<[string, Cell]>): Sheet[] {
  return [
    { name: 'Summary', header: ['Item', 'Value'], rows: summary },
    { name: 'Activity', header: ['When', 'Who', 'Role', 'Action', 'About', 'What happened', 'Outcome'], rows: entries.map((e) => [e.at, e.actorName, e.role, e.intent, e.target, e.summary, e.outcome]) },
  ];
}

/** Reads a written file back and checks every sheet has the rows it should. Throws if not. */
export function verifySpreadsheet(bytes: Uint8Array, expected: Sheet[]): void {
  const got = readXlsx(bytes);
  if (got.length !== expected.length) throw new Error(`The spreadsheet has ${got.length} sheets, expected ${expected.length}.`);
  expected.forEach((s, i) => {
    const g = got[i]!;
    if (g.rows.length !== s.rows.length + 1) throw new Error(`Sheet "${s.name}" came back with ${g.rows.length - 1} rows, expected ${s.rows.length}.`);
  });
}

/* ---------- The service ---------- */

export function createArchiveService(o: ArchiveOptions): ArchiveService {
  const clock = o.clock ?? { now: () => new Date() };
  const settings: ArchiveSettings = { ...DEFAULT_ARCHIVE, ...o.settings };
  let timers: NodeJS.Timeout[] = [];
  let running: Promise<ArchiveResult> | null = null;
  let memError: string | null = null;

  const load = (): ArchiveState => {
    try {
      return { batches: [], lastRunAt: null, lastError: null, ...JSON.parse(fs.readFileSync(o.statePath, 'utf8')) };
    } catch {
      return { batches: [], lastRunAt: null, lastError: null };
    }
  };
  const save = (s: ArchiveState) => {
    fs.mkdirSync(path.dirname(o.statePath), { recursive: true });
    const tmp = `${o.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, o.statePath);
  };

  const full = () => o.usedBytes() >= settings.whenFullBytes;
  /** After a run the database should be comfortably below the line, not just under it. */
  const roomy = () => o.usedBytes() < settings.whenFullBytes * 0.8;

  async function lookups(): Promise<Lookups> {
    const [staff, ingredients] = await Promise.all([o.store.list<Staff>('staff'), o.store.list<Ingredient>('ingredients')]);
    return { staff: new Map(staff.map((s) => [s.id, s.name])), ingredients: new Map(ingredients.map((i) => [i.id, i])) };
  }

  async function candidateOrders(minAgeDays: number, limit: number): Promise<OrderBundle[]> {
    const today = todayLocal(clock.now());
    const orders = (await o.store.list<Order>('orders')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Cheap test first: an order younger than the age limit is never loaded in full.
    const cutoff = clock.now().getTime() - minAgeDays * DAY_MS;
    const out: OrderBundle[] = [];
    for (const order of orders) {
      if (Date.parse(order.createdAt) > cutoff) continue;
      const bundle = await loadBundle(o.store, order);
      if (isArchivable(bundle, today, minAgeDays)) out.push(bundle);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Writes the file, uploads it, backs up, and only then removes the rows. */
  async function commit(kind: 'orders' | 'activity', name: string, sheets: Sheet[], count: number, remove: () => Promise<number>, extra: Partial<ArchivedBatch> = {}, photos: Array<{ file: string; bytes: Uint8Array }> = []): Promise<ArchivedBatch> {
    fs.mkdirSync(o.dir, { recursive: true });
    const bytes = buildXlsx(sheets);
    verifySpreadsheet(bytes, sheets);
    const localFile = path.join(o.dir, `${name}.xlsx`);
    const photoDir = path.join(o.dir, `${name}-photos`);
    const written: string[] = [];
    let driveFile: DriveFile | undefined;
    try {
      fs.writeFileSync(`${localFile}.part`, bytes);
      fs.renameSync(`${localFile}.part`, localFile);
      written.push(localFile);
      // Read back from disk, not from memory: this is the copy that has to survive.
      verifySpreadsheet(fs.readFileSync(localFile), sheets);
      if (photos.length) {
        fs.mkdirSync(photoDir, { recursive: true });
        for (const p of photos) {
          const f = path.join(photoDir, p.file);
          fs.writeFileSync(f, p.bytes);
          if (fs.statSync(f).size !== p.bytes.byteLength) throw new Error(`Photo ${p.file} was not saved completely.`);
        }
      }
      if (o.drive) {
        const folder = await o.drive.client.ensureFolder([o.drive.folderName, 'Archive']);
        driveFile = await o.drive.client.upload({ name, parentId: folder, source: { bytes }, mimeType: XLSX_MIME, convertTo: GOOGLE_SHEET_MIME });
      }
      await o.backupNow(); // the way back if anything below goes wrong
      await remove();
    } catch (err) {
      // Nothing was removed from the database, so take back what was written: the next try starts clean.
      for (const f of written) fs.rmSync(f, { force: true });
      fs.rmSync(photoDir, { recursive: true, force: true });
      if (driveFile && o.drive) await o.drive.client.remove(driveFile.id).catch(() => undefined);
      throw err;
    }
    return { kind, name, at: clock.now().toISOString(), count, localFile, driveFileId: driveFile?.id, driveLink: driveFile?.webViewLink, ...extra };
  }

  async function archiveOrders(minAgeDays: number, dryRun: boolean, untilEmpty: boolean): Promise<{ batches: ArchivedBatch[]; found: number }> {
    const batches: ArchivedBatch[] = [];
    let found = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const bundles = await candidateOrders(minAgeDays, settings.batchOrders);
      if (!bundles.length) break;
      found += bundles.length;
      if (dryRun) break;
      const first = bundles[0]!.order.number;
      const last = bundles[bundles.length - 1]!.order.number;
      const name = `cakepos-orders-${first}-to-${last}-${bundles.length}-orders`;
      const l = await lookups();
      const photoRows = bundles.flatMap((b) => b.photos);
      const photoBytes: Array<{ file: string; bytes: Uint8Array }> = [];
      for (const ph of photoRows) {
        const data = await o.store.get<PhotoData>('photoData', ph.id);
        if (data) photoBytes.push({ file: `${ph.id}.${ph.mime === 'image/png' ? 'png' : ph.mime === 'image/webp' ? 'webp' : 'jpg'}`, bytes: base64ToBytes(data.data) });
      }
      const dates = bundles.map((b) => b.order.createdAt).sort();
      const sheets = orderSheets(bundles, l, [
        ['What this is', 'Finished orders moved out of the Cake POS database to keep it small'],
        ['Archived on', clock.now().toISOString()],
        ['Orders', bundles.length],
        ['First order', first],
        ['Last order', last],
        ['Orders created from', dates[0]],
        ['Orders created to', dates[dates.length - 1]],
        ['Reference photos', photoBytes.length ? `${photoBytes.length} saved on the shop computer in the folder "${name}-photos" (not uploaded to Drive)` : 'none'],
      ]);
      const prints = new Map(bundles.map((b) => [b.order.id, fingerprint(b)]));
      const remove = () =>
        o.exclusive(() =>
          o.store.transaction(async () => {
            // If anything about an order changed while the files were being written, it stays in the database.
            let removed = 0;
            for (const b of bundles) {
              const now = await o.store.get<Order>('orders', b.order.id);
              if (!now) continue;
              const fresh = await loadBundle(o.store, now);
              if (fingerprint(fresh) !== prints.get(b.order.id)) {
                o.log.warn('An order changed while it was being archived, so it was left in the database', { order: b.order.number });
                continue;
              }
              for (const x of fresh.lines) await o.store.delete('orderLines', x.id);
              for (const x of fresh.payments) await o.store.delete('payments', x.id);
              for (const x of fresh.refunds) await o.store.delete('refunds', x.id);
              for (const x of fresh.quotes) await o.store.delete('quotes', x.id);
              for (const x of fresh.reports) await o.store.delete('usageReports', x.id);
              for (const x of fresh.suggestions) await o.store.delete('usageSuggestions', x.id);
              for (const x of fresh.photos) {
                await o.store.delete('photoData', x.id);
                await o.store.delete('photos', x.id);
              }
              await o.store.delete('orders', b.order.id);
              removed++;
            }
            return removed;
          }),
        );
      const batch = await commit('orders', name, sheets, bundles.length, remove, { firstNumber: first, lastNumber: last }, photoBytes);
      const state = load();
      state.batches.push(batch);
      save(state);
      batches.push(batch);
      o.log.info('Archived orders', { orders: batch.count, file: batch.localFile, drive: !!batch.driveFileId });
      // An automatic run stops once there is comfortable room; a manual run goes on until nothing old is left.
      if (!untilEmpty && roomy()) break;
    }
    return { batches, found };
  }

  async function archiveActivity(dryRun: boolean): Promise<{ batches: ArchivedBatch[]; found: number }> {
    const batches: ArchivedBatch[] = [];
    let found = 0;
    const cutoff = new Date(clock.now().getTime() - settings.auditKeepDays * DAY_MS).toISOString();
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const entries = (await o.store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'asc' }, limit: AUDIT_BATCH })).filter((e) => e.at < cutoff);
      if (!entries.length) break;
      found += entries.length;
      if (dryRun) break;
      const name = `cakepos-activity-${entries[0]!.at.slice(0, 10)}-to-${entries[entries.length - 1]!.at.slice(0, 10)}-${stamp(clock.now())}`;
      const sheets = activitySheets(entries, [
        ['What this is', 'Old activity log entries moved out of the Cake POS database to keep it small'],
        ['Archived on', clock.now().toISOString()],
        ['Entries', entries.length],
        ['From', entries[0]!.at],
        ['To', entries[entries.length - 1]!.at],
      ]);
      const remove = () =>
        o.exclusive(() =>
          o.store.transaction(async () => {
            for (const e of entries) await o.store.delete('audit', e.id);
            return entries.length;
          }),
        );
      const batch = await commit('activity', name, sheets, entries.length, remove);
      const state = load();
      state.batches.push(batch);
      save(state);
      batches.push(batch);
      o.log.info('Archived activity log', { entries: batch.count, file: batch.localFile, drive: !!batch.driveFileId });
      if (entries.length < AUDIT_BATCH) break;
    }
    return { batches, found };
  }

  async function runInner(opts: { force?: boolean; dryRun?: boolean; minAgeDays?: number }): Promise<ArchiveResult> {
    if (!opts.force && !full()) return { ran: false, reason: 'The database is not full yet.', batches: [] };
    const minAge = opts.minAgeDays ?? settings.minAgeDays;
    const state = load();
    try {
      const orders = await archiveOrders(minAge, !!opts.dryRun, !!opts.force);
      // The activity log is only touched when forced, or when moving orders was not enough.
      const activity = opts.force || !roomy() ? await archiveActivity(!!opts.dryRun) : { batches: [], found: 0 };
      const batches = [...orders.batches, ...activity.batches];
      if (!opts.dryRun) {
        const s = load();
        s.lastRunAt = clock.now().toISOString();
        s.lastError = null;
        save(s);
        memError = null;
      }
      return {
        ran: true,
        reason: opts.dryRun ? 'Dry run: nothing was changed.' : batches.length ? `Archived ${orders.batches.reduce((n, b) => n + b.count, 0)} orders and ${activity.batches.reduce((n, b) => n + b.count, 0)} activity entries.` : 'There was nothing old and finished enough to archive.',
        batches,
        wouldArchive: opts.dryRun ? { orders: orders.found, activity: activity.found } : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      memError = msg;
      try {
        save({ ...state, lastRunAt: clock.now().toISOString(), lastError: msg });
      } catch {
        /* the folder may be the problem; memError still reports it */
      }
      o.log.error('Archiving failed; nothing was removed', errorFields(err));
      throw err;
    }
  }

  const run: ArchiveService['run'] = (opts = {}) => (running ??= runInner(opts).finally(() => (running = null)));

  return {
    run,
    check: () => run({}),
    status() {
      const s = load();
      const used = o.usedBytes();
      return {
        usedMb: Math.round((used / 1_048_576) * 10) / 10,
        whenFullMb: Math.round(settings.whenFullBytes / 1_048_576),
        full: used >= settings.whenFullBytes,
        lastRunAt: s.lastRunAt,
        lastError: memError ?? s.lastError,
        totalOrdersArchived: s.batches.filter((b) => b.kind === 'orders').reduce((n, b) => n + b.count, 0),
        driveConnected: !!o.drive,
        folder: o.dir,
        recent: s.batches.slice(-10).reverse(),
      };
    },
    start() {
      timers.push(setTimeout(() => void run({}).catch(() => undefined), 5 * 60_000));
      timers.push(setInterval(() => void run({}).catch(() => undefined), 3_600_000));
      for (const t of timers) t.unref();
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}
