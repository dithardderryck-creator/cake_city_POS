import type { AuditEntry, ChainCheck, ChainHead, ChainLink, Role } from '../domain';
import type { FeedDef } from '../feeds';
import type { Registry } from '../intents';
import { DomainError } from '../intents';
import { entryFingerprint, linkId, refOf, verifyChain } from './seal';

/** What IT sees of the sealed records. Money and stock show as a sealed signal until the record is opened (and opening is itself recorded). */
const SEALED = /^(payments|orders|stock|inventory|count|usage|batches|day|offline)\/|^catalogue\/(set_price|fill_price)$/;

const KIND_LABEL: Record<string, string> = {
  'orders/create_order': 'New order',
  'orders/quick_sale': 'Sale',
  'orders/add_catalogue_line': 'Order line added',
  'orders/add_custom_line': 'Custom cake added',
  'payments/record_payment': 'Payment',
  'payments/approve_refund': 'Refund',
  'orders/advance_line': 'Order progress',
  'orders/cancel_order': 'Order cancelled',
  'inventory/receive': 'Stock received',
  'inventory/write_off': 'Stock written off',
  'inventory/count': 'Stock count',
  'day/close': 'Day closed',
  'stock/set_count': 'Stock count',
  'count/submit': 'Stock count',
  'catalogue/set_price': 'Price change',
  'catalogue/fill_price': 'Price change',
  'offline/replay': 'Offline sale',
};
export const kindLabel = (intent: string): string => {
  if (KIND_LABEL[intent]) return KIND_LABEL[intent]!;
  const last = (intent.split('/').pop() ?? intent).replace(/_/g, ' ');
  const area = intent.split('/')[0] === 'orders' ? 'Order' : intent.split('/')[0] === 'payments' ? 'Payment' : intent.split('/')[0] === 'inventory' || intent.split('/')[0] === 'stock' ? 'Stock' : intent.split('/')[0] === 'usage' ? 'Usage' : intent.split('/')[0] === 'batches' ? 'Batch' : intent.split('/')[0] === 'count' ? 'Count' : '';
  return area ? `${area}: ${last}` : last.charAt(0).toUpperCase() + last.slice(1);
};
export const isSealedKind = (intent: string) => SEALED.test(intent);

const PAGE = 40;
const MAX_SCAN = 4000;

export interface RecordRow {
  seq: number;
  at: string;
  who: string;
  role: Role | null;
  kind: string;
  intent: string;
  /** Money and stock are sealed: no summary until the record is opened. */
  sealed: boolean;
  summary: string | null;
  outcome: AuditEntry['outcome'];
  ref: string;
  /** The details are no longer in the activity record (moved to the archive or removed). */
  detailsGone: boolean;
}
export interface RecordsViewData {
  rows: RecordRow[];
  /** Pass this as `before` to read older records. Null at the beginning of the chain. */
  nextBefore: number | null;
  chain: { sealed: number; since: string | null; headRef: string | null; check: { at: string; ok: boolean; mode: 'new' | 'full'; checked: number; detailsGone: number; problems: string[] } | null };
}
export interface RecordOpened {
  seq: number;
  ref: string;
  at: string;
  who: string;
  role: Role | null;
  kind: string;
  intent: string;
  target: string | null;
  outcome: AuditEntry['outcome'];
  summary: string | null;
  /** The entry still matches the fingerprint it was sealed with. Null when the details are gone. */
  intact: boolean | null;
}
export interface ItActivityData {
  rows: { at: string; who: string; summary: string; outcome: AuditEntry['outcome'] }[];
}

async function describe(store: Parameters<NonNullable<FeedDef<'records_view'>['build']>>[0]['store'], l: ChainLink): Promise<{ audit: AuditEntry | undefined; row: RecordRow }> {
  const audit = await store.get<AuditEntry>('audit', l.auditId);
  const sealed = isSealedKind(l.kind) && l.outcome === 'ok';
  return {
    audit,
    row: {
      seq: l.seq,
      at: l.at,
      who: audit?.actorName ?? (l.actorId ? 'Someone' : 'Not signed in'),
      role: audit?.role ?? null,
      kind: kindLabel(l.kind),
      intent: l.kind,
      sealed,
      summary: sealed ? null : (audit?.summary ?? null),
      outcome: l.outcome,
      ref: refOf(l.hash),
      detailsGone: !audit,
    },
  };
}

export const recordIntents = {
  'records/open': {
    circuit: 'Records',
    roles: ['it'],
    validate: async (p, ctx) => ((await ctx.store.get<ChainLink>('chain', linkId(p.seq))) ? [] : ['That record does not exist.']),
    handle: async (p, ctx) => {
      const l = (await ctx.store.get<ChainLink>('chain', linkId(p.seq)))!;
      const { audit, row } = await describe(ctx.store, l);
      const opened: RecordOpened = {
        seq: l.seq,
        ref: row.ref,
        at: l.at,
        who: row.who,
        role: row.role,
        kind: row.kind,
        intent: l.kind,
        target: audit?.target ?? null,
        outcome: l.outcome,
        summary: audit?.summary ?? null,
        intact: audit ? (await entryFingerprint(audit)) === l.entryHash : null,
      };
      return { summary: `Opened record ${row.ref}`, target: row.ref, data: opened };
    },
  },

  'records/verify': {
    circuit: 'Records',
    roles: ['it'],
    handle: async (p, ctx) => {
      const r = await verifyChain({ store: ctx.store, ids: ctx.ids, clock: ctx.clock }, { full: !!p.full });
      return { summary: r.ok ? `Checked the record chain (${p.full ? 'everything' : 'what is new'}): it matches` : `Checked the record chain (${p.full ? 'everything' : 'what is new'}): it does NOT match`, data: r };
    },
  },
} satisfies Partial<Registry>;

export const recordFeeds = {
  records_view: {
    roles: ['it'],
    build: async ({ store }, p) => {
      const head = await store.get<ChainHead>('chainHead', 'head');
      const last = await store.get<ChainCheck>('chainChecks', 'last');
      const chain: RecordsViewData['chain'] = {
        sealed: head?.seq ?? 0,
        since: head?.since ?? null,
        headRef: head ? refOf(head.hash) : null,
        check: last ? { at: last.at, ok: last.ok, mode: last.mode, checked: last.checked, detailsGone: last.detailsGone, problems: last.problems } : null,
      };
      if (!head) return { rows: [], nextBefore: null, chain };
      const kind = p.kind ?? 'all';
      let seq = Math.min(head.seq, (p.before ?? head.seq + 1) - 1);
      const rows: RecordRow[] = [];
      let scanned = 0;
      for (; seq >= 1 && rows.length < PAGE && scanned < MAX_SCAN; seq--, scanned++) {
        const l = await store.get<ChainLink>('chain', linkId(seq));
        if (!l) continue;
        if (kind === 'refused' && l.outcome === 'ok') continue;
        if (kind === 'opened' && l.kind !== 'records/open') continue;
        rows.push((await describe(store, l)).row);
      }
      return { rows, nextBefore: seq >= 1 ? seq + 1 : null, chain };
    },
  },

  it_activity: {
    roles: ['owner'],
    build: async ({ store }) => {
      const mine = await store.find<AuditEntry>('audit', { where: { role: 'it' }, orderBy: { field: 'at', dir: 'desc' }, limit: 200 });
      return { rows: mine.map((a) => ({ at: a.at, who: a.actorName ?? 'IT', summary: a.summary, outcome: a.outcome })) };
    },
  },
} satisfies Pick<{ [K in 'records_view' | 'it_activity']: FeedDef<K> }, 'records_view' | 'it_activity'>;
