import type {
  AuditEntry,
  CakeSpec,
  Quote,
  QuoteStatus,
  Combination,
  Order,
  OrderLine,
  OrderStatus,
  OptionGroup,
  OptionValue,
  OutboxItem,
  Payment,
  PaymentStatus,
  Product,
  Refund,
  Role,
  Session,
  Staff,
} from './domain';
import { daysBetween, todayLocal } from './circuits/dates';
import { loadSettings } from './circuits/settings';
import { MAX_PHOTOS_PER_CAKE } from './circuits/custom';
import type { LoginState } from './circuits/pin';
import { PLANNED_CIRCUITS, type CircuitName, type PanelConfig } from './intents';
import type { BackupStatus, Clock, Store, Terminals } from './ports';
import {
  PAYMENT_LABEL,
  PAYMENT_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  canRemoveLine,
  deriveOrderStatus,
  isCustom,
  lineTotal,
  moneySummary,
  nextActions,
  type LineAction,
  type Tone,
} from './circuits/order-logic';
import { loadOrderBundle } from './circuits/orders';

/* ---------- Feed data shapes (what the UI receives) ---------- */

export interface CatalogueCombination {
  combinationId: string;
  label: string;
  valueIds: string[];
  price: number | null;
  priceLabel: string | null;
  onHand: number;
  committed: number;
  sellable: boolean;
  reason: string | null;
  markedUnavailable: boolean;
  warning: string | null;
}
export interface CatalogueGridItem {
  productId: string;
  name: string;
  category: string;
  description: string;
  archived: boolean;
  availableToday: boolean;
  allergens: string[];
  groups: { groupId: string; name: string; values: { valueId: string; label: string }[] }[];
  combinations: CatalogueCombination[];
  priceFromLabel: string | null;
  sellable: boolean;
  /** What the signed-in person may change here. The UI shows or hides controls from this. */
  can: { price: boolean; stock: boolean; manage: boolean };
}

export interface OrderListItem {
  orderId: string;
  number: string;
  customerName: string;
  fulfilment: 'pickup' | 'delivery';
  deliveryDate?: string;
  status: OrderStatus;
  statusLabel: string;
  statusTone: Tone;
  paymentStatus: PaymentStatus;
  paymentLabel: string;
  paymentTone: Tone;
  totalLabel: string;
  balanceLabel: string;
  itemCount: number;
  /** A custom cake is waiting for the owner to price it. */
  needsQuote: boolean;
  /** The total is not final yet because a custom cake has no price. */
  quotePending: boolean;
  hasCustomCake: boolean;
}

/** What the customer asked for in a custom cake, ready to display. */
export interface CakeDetails {
  servings: number;
  sizeNote?: string;
  flavor: string;
  filling?: string;
  layers: number;
  dietary: string[];
  decorationNotes?: string;
  inscription?: string;
  allergyNotes?: string;
  /** Fetch each picture with the client's photo() call. */
  photoIds: string[];
}

export interface QuoteState {
  quoteId: string;
  status: QuoteStatus;
  statusLabel: string;
  priceLabel?: string;
  /** The cashier's note to the owner. */
  note?: string;
  /** The owner's note with the price, or the reason for declining. */
  answer?: string;
  requestedByName: string;
  requestedAt: string;
  resolvedAt?: string;
}

export interface OrderCardLine {
  lineId: string;
  title: string;
  options: string;
  allergens: string[];
  qty: number;
  unitPriceLabel: string;
  totalLabel: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  cancelled: boolean;
  actions: LineAction[];
  canRemove: boolean;
  kind: 'catalogue' | 'custom';
  /** Custom cakes only. */
  cake?: CakeDetails;
  quote?: QuoteState;
  /** Details and photos can be changed (draft, or quoted but not yet started). */
  canEdit: boolean;
  canRequestQuote: boolean;
  /** Why the quote cannot be requested yet, in plain words. */
  quoteBlockedReason: string | null;
  canWithdrawQuote: boolean;
  maxPhotos: number;
}
export interface OrderCardData extends OrderListItem {
  source: 'walk_in' | 'phone';
  deliveryAddress?: string;
  lines: OrderCardLine[];
  paidLabel: string;
  refundedLabel: string | null;
  balance: number;
  total: number;
  canRecordPayment: boolean;
  canCancel: boolean;
  canEditDelivery: boolean;
  canRefund: boolean;
  refundableLabel: string;
  payments: { id: string; methodLabel: string; amountLabel: string; at: string; reference?: string }[];
  warnings: string[];
}

export interface AuditRow {
  id: string;
  at: string;
  who: string;
  role?: Role;
  intent: string;
  summary: string;
  outcome: AuditEntry['outcome'];
}

export interface StaffListRow {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  locked: boolean;
}

export interface PanelMapData {
  circuits: {
    name: string;
    status: 'live' | 'planned';
    handled: number;
    denied: number;
    invalid: number;
    errors: number;
    lastActivityAt: string | null;
  }[];
  outbox: { pending: number; sent: number; failed: number };
  terminals: { name: string; state: string }[];
  activeSessions: number;
  backup: BackupStatus | null;
  system: { label: string; value: string }[];
}

export interface StaffSigninRow {
  id: string;
  name: string;
  role: Role;
}

export type ScreenId = 'sell' | 'orders' | 'quotes' | 'bake_queue' | 'catalogue' | 'staff' | 'settings' | 'audit' | 'panel_map';
export interface NavItem {
  id: ScreenId;
  label: string;
}

export interface QuoteRow {
  quoteId: string;
  orderId: string;
  orderNumber: string;
  lineId: string;
  customerName: string;
  deliveryDate?: string;
  fulfilment: 'pickup' | 'delivery';
  status: QuoteStatus;
  statusLabel: string;
  requestedByName: string;
  requestedAt: string;
  note?: string;
  priceLabel?: string;
  answer?: string;
  resolvedAt?: string;
  cake: CakeDetails;
}
export interface QuoteInboxData {
  /** Waiting for the owner. Soonest delivery date first. */
  open: QuoteRow[];
  /** The most recent answered or withdrawn requests. */
  recent: QuoteRow[];
  can: { provide: boolean; withdraw: boolean };
}

export type Urgency = 'late' | 'today' | 'soon' | 'later' | 'undated';
export interface BakeRow {
  lineId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  deliveryDate?: string;
  fulfilment: 'pickup' | 'delivery';
  /** For example "Today", "Tomorrow", "In 3 days", "2 days late". */
  dueLabel: string;
  urgency: Urgency;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  actions: LineAction[];
  cake: CakeDetails;
}
export interface BakeQueueData {
  rows: BakeRow[];
  counts: { late: number; today: number; toStart: number; inProduction: number; ready: number };
  decoratingStage: boolean;
}

export interface ShopSettingsData {
  decoratingStage: boolean;
  can: { edit: boolean };
}

export interface FeedMap {
  me: { params: Record<string, never>; data: Session };
  navigation: { params: Record<string, never>; data: NavItem[] };
  staff_signin: { params: Record<string, never>; data: StaffSigninRow[] };
  staff_list: { params: Record<string, never>; data: StaffListRow[] };
  catalogue_grid: { params: { includeArchived?: boolean }; data: CatalogueGridItem[] };
  order_list: { params: Record<string, never>; data: OrderListItem[] };
  order_card: { params: { orderId: string }; data: OrderCardData };
  quote_inbox: { params: Record<string, never>; data: QuoteInboxData };
  bake_queue: { params: Record<string, never>; data: BakeQueueData };
  shop_settings: { params: Record<string, never>; data: ShopSettingsData };
  audit_view: { params: Record<string, never>; data: AuditRow[] };
  panel_map: { params: Record<string, never>; data: PanelMapData };
}
export type FeedName = keyof FeedMap;

export interface CircuitStat {
  handled: number;
  denied: number;
  invalid: number;
  errors: number;
  lastActivityAt: string | null;
}

export interface FeedCtx {
  store: Store;
  config: PanelConfig;
  clock: Clock;
  terminals: Terminals;
  session: Session | null;
  stats: () => Map<CircuitName, CircuitStat>;
}

export interface FeedDef<K extends FeedName> {
  roles: Role[] | 'public';
  build: (ctx: FeedCtx, params: FeedMap[K]['params']) => Promise<FeedMap[K]['data']>;
}
export type FeedRegistry = { [K in FeedName]: FeedDef<K> };

/* ---------- Helpers ---------- */

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  mobile_money: 'Mobile money',
};

const needsPrice = (status: string) => status === 'draft' || status === 'awaiting_quote';
const OPEN_LINE_STATUSES = ['new', 'ready', 'out_for_delivery'];

const QUOTE_LABEL: Record<QuoteStatus, string> = {
  sent: 'Sent to the owner',
  seen: 'Seen by the owner',
  quoted: 'Priced',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

const cakeDetails = (spec: CakeSpec): CakeDetails => ({
  servings: spec.servings,
  sizeNote: spec.sizeNote,
  flavor: spec.flavor,
  filling: spec.filling,
  layers: spec.layers,
  dietary: spec.dietary,
  decorationNotes: spec.decorationNotes,
  inscription: spec.inscription,
  allergyNotes: spec.allergyNotes,
  photoIds: spec.photoIds,
});

const quoteState = (q: Quote, fmt: (n: number) => string): QuoteState => ({
  quoteId: q.id,
  status: q.status,
  statusLabel: QUOTE_LABEL[q.status],
  priceLabel: q.price !== undefined ? fmt(q.price) : undefined,
  note: q.note,
  answer: q.answer,
  requestedByName: q.requestedByName,
  requestedAt: q.requestedAt,
  resolvedAt: q.resolvedAt,
});

function dueInfo(deliveryDate: string | undefined, today: string): { label: string; urgency: Urgency } {
  if (!deliveryDate) return { label: 'No date set', urgency: 'undated' };
  const d = daysBetween(today, deliveryDate);
  if (d < 0) return { label: d === -1 ? '1 day late' : `${-d} days late`, urgency: 'late' };
  if (d === 0) return { label: 'Today', urgency: 'today' };
  if (d === 1) return { label: 'Tomorrow', urgency: 'soon' };
  return { label: `In ${d} days`, urgency: d <= 2 ? 'soon' : 'later' };
}

function listItem(
  order: Order,
  lines: OrderLine[],
  payments: Payment[],
  refunds: Refund[],
  fmt: (n: number) => string,
): OrderListItem {
  const status = deriveOrderStatus(lines);
  const money = moneySummary(lines, payments, refunds);
  return {
    orderId: order.id,
    number: order.number,
    customerName: order.customerName,
    fulfilment: order.fulfilment,
    deliveryDate: order.deliveryDate,
    status,
    statusLabel: STATUS_LABEL[status],
    statusTone: STATUS_TONE[status],
    paymentStatus: money.status,
    paymentLabel: PAYMENT_LABEL[money.status],
    paymentTone: PAYMENT_TONE[money.status],
    totalLabel: fmt(money.total),
    balanceLabel: fmt(money.balance),
    itemCount: lines.filter((l) => l.status !== 'cancelled').reduce((s, l) => s + l.qty, 0),
    needsQuote: lines.some((l) => l.status === 'awaiting_quote'),
    quotePending: money.quotePending,
    hasCustomCake: lines.some((l) => isCustom(l) && l.status !== 'cancelled'),
  };
}

/* ---------- Feeds ---------- */

const NAV: Record<Role, NavItem[]> = {
  owner: [
    { id: 'sell', label: 'Sell' },
    { id: 'orders', label: 'Orders' },
    { id: 'quotes', label: 'Quotes' },
    { id: 'bake_queue', label: 'Cakes to bake' },
    { id: 'catalogue', label: 'Catalogue' },
    { id: 'staff', label: 'Staff' },
    { id: 'settings', label: 'Settings' },
    { id: 'audit', label: 'Activity' },
  ],
  cashier: [
    { id: 'sell', label: 'Sell' },
    { id: 'orders', label: 'Orders' },
    { id: 'quotes', label: 'Quotes' },
    { id: 'catalogue', label: 'Catalogue' },
  ],
  baker: [
    { id: 'bake_queue', label: 'Cakes to bake' },
    { id: 'catalogue', label: 'Catalogue' },
  ],
  inventory: [{ id: 'catalogue', label: 'Catalogue' }],
  it: [{ id: 'panel_map', label: 'Panel map' }],
};

export const feeds: FeedRegistry = {
  me: {
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    build: async ({ session }) => session!,
  },

  navigation: {
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    build: async ({ session }) => NAV[session!.role],
  },

  staff_signin: {
    roles: 'public',
    build: async ({ store }) =>
      (await store.list<Staff>('staff'))
        .filter((s) => s.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ id: s.id, name: s.name, role: s.role })),
  },

  staff_list: {
    roles: ['owner'],
    build: async ({ store, clock }) => {
      const [staff, states] = await Promise.all([store.list<Staff>('staff'), store.list<LoginState>('loginState')]);
      const nowMs = clock.now().getTime();
      const locked = new Set(states.filter((s) => s.lockedUntil && Date.parse(s.lockedUntil) > nowMs).map((s) => s.id));
      return staff
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ id: s.id, name: s.name, role: s.role, active: s.active, locked: locked.has(s.id) }));
    },
  },

  catalogue_grid: {
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    build: async ({ store, config, session }, params) => {
      const can = {
        price: session?.role === 'owner',
        stock: session?.role === 'owner' || session?.role === 'inventory',
        manage: session?.role === 'owner',
      };
      const [products, groups, values, combos, lines] = await Promise.all([
        store.list<Product>('products'),
        store.list<OptionGroup>('optionGroups'),
        store.list<OptionValue>('optionValues'),
        store.list<Combination>('combinations'),
        store.find<OrderLine>('orderLines', { where: { status: OPEN_LINE_STATUSES } }),
      ]);
      const committed = new Map<string, number>();
      for (const l of lines) {
        if (l.type !== 'catalogue' || !l.combinationId) continue; // custom cakes do not use counter stock
        committed.set(l.combinationId, (committed.get(l.combinationId) ?? 0) + l.qty);
      }
      const groupById = new Map(groups.map((g) => [g.id, g]));
      const valueById = new Map(values.map((v) => [v.id, v]));

      return products
        .filter((p) => params.includeArchived || p.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p): CatalogueGridItem => {
          const chosen = values.filter((v) => p.selectedValueIds.includes(v.id));
          const productGroups = groups
            .filter((g) => chosen.some((v) => v.groupId === g.id))
            .sort((a, b) => a.order - b.order)
            .map((g) => ({
              groupId: g.id,
              name: g.name,
              values: chosen
                .filter((v) => v.groupId === g.id)
                .sort((a, b) => a.order - b.order)
                .map((v) => ({ valueId: v.id, label: v.label })),
            }));

          const sortKey = (c: Combination) =>
            c.valueIds
              .map((id) => valueById.get(id))
              .filter((v): v is OptionValue => !!v)
              .sort((a, b) => (groupById.get(a.groupId)?.order ?? 0) - (groupById.get(b.groupId)?.order ?? 0));

          const combinations = combos
            .filter((c) => c.productId === p.id)
            .map((c): CatalogueCombination => {
              const ordered = sortKey(c);
              const onHand = c.stockCount;
              const open = committed.get(c.id) ?? 0;
              let reason: string | null = null;
              if (p.status === 'archived') reason = 'Archived';
              else if (!p.availableToday) reason = 'Off the menu today';
              else if (c.status !== 'available') reason = 'Not available';
              else if (c.price === null) reason = 'No price yet';
              return {
                combinationId: c.id,
                label: ordered.map((v) => v.label).join(', '),
                valueIds: c.valueIds,
                price: c.price,
                priceLabel: c.price === null ? null : config.formatMoney(c.price),
                onHand,
                committed: open,
                sellable: reason === null,
                reason,
                markedUnavailable: c.status !== 'available',
                warning: open > onHand ? `Open orders need ${open} but ${onHand} on hand` : null,
              };
            })
            .sort((a, b) => {
              const ka = sortKey(combos.find((c) => c.id === a.combinationId)!).map((v) => v.order);
              const kb = sortKey(combos.find((c) => c.id === b.combinationId)!).map((v) => v.order);
              for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
                const d = (ka[i] ?? 0) - (kb[i] ?? 0);
                if (d !== 0) return d;
              }
              return 0;
            });

          const prices = combinations.filter((c) => c.sellable && c.price !== null).map((c) => c.price as number);
          return {
            productId: p.id,
            name: p.name,
            category: p.category,
            description: p.description,
            archived: p.status === 'archived',
            availableToday: p.availableToday,
            allergens: p.allergens,
            groups: productGroups,
            combinations,
            priceFromLabel: prices.length ? config.formatMoney(Math.min(...prices)) : null,
            sellable: prices.length > 0,
            can,
          };
        });
    },
  },

  order_list: {
    roles: ['owner', 'cashier'],
    build: async ({ store, config }) => {
      const orders = await store.find<Order>('orders', { orderBy: { field: 'createdAt', dir: 'desc' }, limit: 200 });
      const ids = orders.map((o) => o.id);
      const [lines, payments, refunds] = ids.length
        ? await Promise.all([
            store.find<OrderLine>('orderLines', { where: { orderId: ids } }),
            store.find<Payment>('payments', { where: { orderId: ids } }),
            store.find<Refund>('refunds', { where: { orderId: ids } }),
          ])
        : [[], [], []];
      return orders.map((o) =>
        listItem(
          o,
          lines.filter((l) => l.orderId === o.id),
          payments.filter((p) => p.orderId === o.id),
          refunds.filter((r) => r.orderId === o.id),
          config.formatMoney,
        ),
      );
    },
  },

  order_card: {
    roles: ['owner', 'cashier'],
    build: async (ctx, params) => {
      const { config, session } = ctx;
      const fmt = config.formatMoney;
      const { order, lines, payments, refunds } = await loadOrderBundle(ctx, params.orderId);
      const role = session!.role;
      const base = listItem(order, lines, payments, refunds, fmt);
      const money = moneySummary(lines, payments, refunds);
      const cancelledOrder = base.status === 'cancelled';
      const finished = base.status === 'completed' || cancelledOrder;

      const settings = await loadSettings(ctx.store);
      const quotes = await ctx.store.find<Quote>('quotes', { where: { orderId: order.id } });
      const hasPayments = payments.length > 0;
      const cardLines = lines.map((l): OrderCardLine => {
        const cancelled = l.status === 'cancelled';
        const lineStatus = (l.status as OrderStatus) ?? 'new';
        const custom = isCustom(l) && l.custom;
        const q = custom && l.custom?.quoteId ? quotes.find((x) => x.id === l.custom!.quoteId) : undefined;
        const front = role === 'owner' || role === 'cashier';
        let blocked: string | null = null;
        if (custom && l.status === 'draft') {
          if (!order.deliveryDate) blocked = 'Set the delivery date first. The owner needs it to price the cake.';
          else if (order.deliveryDate < todayLocal(ctx.clock.now())) blocked = 'The delivery date has passed. Choose a new one first.';
        }
        return {
          lineId: l.id,
          title: l.snapshot.productName,
          options: Object.entries(l.snapshot.options).length && custom ? Object.entries(l.snapshot.options).map(([k, v]) => `${k}: ${v}`).join(', ') : Object.values(l.snapshot.options).join(', '),
          allergens: l.snapshot.allergens,
          qty: l.qty,
          unitPriceLabel: custom && needsPrice(l.status) ? 'Not priced yet' : fmt(l.snapshot.unitPrice),
          totalLabel: custom && needsPrice(l.status) ? 'Not priced yet' : fmt(lineTotal(l)),
          status: l.status,
          statusLabel: STATUS_LABEL[lineStatus],
          statusTone: STATUS_TONE[lineStatus],
          cancelled,
          actions: nextActions(order, l, role, settings),
          canRemove: canRemoveLine(l, role, hasPayments),
          kind: custom ? 'custom' : 'catalogue',
          cake: custom ? cakeDetails(l.custom!.spec) : undefined,
          quote: q ? quoteState(q, fmt) : undefined,
          canEdit: !!custom && front && (l.status === 'draft' || l.status === 'new'),
          canRequestQuote: !!custom && front && l.status === 'draft' && blocked === null,
          quoteBlockedReason: blocked,
          canWithdrawQuote: !!custom && front && l.status === 'awaiting_quote',
          maxPhotos: MAX_PHOTOS_PER_CAKE,
        };
      });

      const warnings: string[] = [];
      if (money.balance > 0 && base.status !== 'new' && base.status !== 'empty' && !cancelledOrder)
        warnings.push(`${fmt(money.balance)} is still unpaid.`);
      if (money.overpaid > 0) warnings.push(`${fmt(money.overpaid)} has been paid above the current total.`);
      if (money.quotePending) warnings.push('A custom cake has no price yet, so the total is not final.');

      return {
        ...base,
        source: order.source,
        deliveryAddress: order.deliveryAddress,
        lines: cardLines,
        paidLabel: fmt(money.paid),
        refundedLabel: money.refunded > 0 ? fmt(money.refunded) : null,
        balance: money.balance,
        total: money.total,
        canRecordPayment: (role === 'owner' || role === 'cashier') && !cancelledOrder && !money.quotePending && money.balance > 0,
        canCancel:
          !finished &&
          (role === 'owner' ||
            (role === 'cashier' &&
              money.net <= 0 &&
              !lines.some((l) => isCustom(l) && ['in_production', 'decorating', 'ready', 'out_for_delivery'].includes(l.status)))),
        canEditDelivery: !finished,
        canRefund: role === 'owner' && money.net > 0,
        refundableLabel: fmt(money.net),
        payments: payments
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
          .map((p) => ({
            id: p.id,
            methodLabel: METHOD_LABEL[p.method] ?? p.method,
            amountLabel: fmt(p.amount),
            at: p.receivedAt,
            reference: p.reference,
          })),
        warnings,
      };
    },
  },

  quote_inbox: {
    roles: ['owner', 'cashier'],
    build: async (ctx) => {
      const { store, config, session } = ctx;
      const fmt = config.formatMoney;
      const quotes = await store.list<Quote>('quotes');
      const orderIds = [...new Set(quotes.map((q) => q.orderId))];
      const [orders, lines] = orderIds.length
        ? await Promise.all([
            store.find<Order>('orders', { where: { id: orderIds } }),
            store.find<OrderLine>('orderLines', { where: { orderId: orderIds } }),
          ])
        : [[], []];
      const toRow = (q: Quote): QuoteRow | null => {
        const order = orders.find((o) => o.id === q.orderId);
        const line = lines.find((l) => l.id === q.lineId);
        if (!order || !line?.custom) return null;
        return {
          quoteId: q.id,
          orderId: order.id,
          orderNumber: order.number,
          lineId: line.id,
          customerName: order.customerName,
          deliveryDate: order.deliveryDate,
          fulfilment: order.fulfilment,
          status: q.status,
          statusLabel: QUOTE_LABEL[q.status],
          requestedByName: q.requestedByName,
          requestedAt: q.requestedAt,
          note: q.note,
          priceLabel: q.price !== undefined ? fmt(q.price) : undefined,
          answer: q.answer,
          resolvedAt: q.resolvedAt,
          cake: cakeDetails(line.custom.spec),
        };
      };
      const rows = quotes.map((q) => ({ q, row: toRow(q) })).filter((x): x is { q: Quote; row: QuoteRow } => x.row !== null);
      const open = rows
        .filter((x) => x.q.status === 'sent' || x.q.status === 'seen')
        .sort((a, b) => (a.row.deliveryDate ?? '9999').localeCompare(b.row.deliveryDate ?? '9999') || a.q.requestedAt.localeCompare(b.q.requestedAt))
        .map((x) => x.row);
      const recent = rows
        .filter((x) => x.q.status !== 'sent' && x.q.status !== 'seen')
        .sort((a, b) => (b.q.resolvedAt ?? '').localeCompare(a.q.resolvedAt ?? ''))
        .slice(0, 20)
        .map((x) => x.row);
      return { open, recent, can: { provide: session?.role === 'owner', withdraw: true } };
    },
  },

  bake_queue: {
    roles: ['owner', 'baker'],
    build: async (ctx) => {
      const { store, session, clock } = ctx;
      const settings = await loadSettings(store);
      const lines = (await store.find<OrderLine>('orderLines', { where: { status: ['new', 'in_production', 'decorating', 'ready'] } })).filter(isCustom);
      const orderIds = [...new Set(lines.map((l) => l.orderId))];
      const orders = orderIds.length ? await store.find<Order>('orders', { where: { id: orderIds } }) : [];
      const today = todayLocal(clock.now());
      const rank: Record<string, number> = { late: 0, today: 1, soon: 2, later: 3, undated: 4 };
      const rows = lines
        .map((l): BakeRow | null => {
          const order = orders.find((o) => o.id === l.orderId);
          if (!order || !l.custom) return null;
          const due = dueInfo(order.deliveryDate, today);
          const status = l.status as OrderStatus;
          return {
            lineId: l.id,
            orderId: order.id,
            orderNumber: order.number,
            customerName: order.customerName,
            deliveryDate: order.deliveryDate,
            fulfilment: order.fulfilment,
            dueLabel: due.label,
            urgency: due.urgency,
            status: l.status,
            statusLabel: STATUS_LABEL[status],
            statusTone: STATUS_TONE[status],
            actions: nextActions(order, l, session!.role, settings),
            cake: cakeDetails(l.custom.spec),
          };
        })
        .filter((r): r is BakeRow => r !== null)
        .sort((a, b) => (a.deliveryDate ?? '9999').localeCompare(b.deliveryDate ?? '9999') || rank[a.urgency]! - rank[b.urgency]!);
      const open = rows.filter((r) => r.status !== 'ready');
      return {
        rows,
        counts: {
          late: open.filter((r) => r.urgency === 'late').length,
          today: open.filter((r) => r.urgency === 'today').length,
          toStart: rows.filter((r) => r.status === 'new').length,
          inProduction: rows.filter((r) => r.status === 'in_production' || r.status === 'decorating').length,
          ready: rows.filter((r) => r.status === 'ready').length,
        },
        decoratingStage: settings.decoratingStage,
      };
    },
  },

  shop_settings: {
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    build: async ({ store, session }) => ({
      decoratingStage: (await loadSettings(store)).decoratingStage,
      can: { edit: session?.role === 'owner' },
    }),
  },

  audit_view: {
    roles: ['owner'],
    build: async ({ store }) =>
      (await store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'desc' }, limit: 200 })).map((a) => ({
        id: a.id,
        at: a.at,
        who: a.actorName ?? 'Not signed in',
        role: a.role,
        intent: a.intent,
        summary: a.summary,
        outcome: a.outcome,
      })),
  },

  panel_map: {
    roles: ['it'],
    build: async ({ store, stats, terminals, clock }) => {
      const [outbox, sessions, backup, system] = await Promise.all([
        store.list<OutboxItem>('outbox'),
        store.list<{ id: string; expiresAt: string }>('sessions'),
        terminals.backup ? terminals.backup.status() : Promise.resolve(null),
        terminals.system ? terminals.system.info() : Promise.resolve([]),
      ]);
      const nowMs = clock.now().getTime();
      const s = stats();
      const live = [...s.entries()].map(([name, st]) => ({ name, status: 'live' as const, ...st }));
      const planned = PLANNED_CIRCUITS.map((name) => ({
        name,
        status: 'planned' as const,
        handled: 0,
        denied: 0,
        invalid: 0,
        errors: 0,
        lastActivityAt: null,
      }));
      const backupState = !terminals.backup
        ? 'not set up yet'
        : backup?.lastError
          ? 'last backup failed'
          : backup?.lastOkAt
            ? 'ok'
            : 'no backup yet';
      return {
        circuits: [...live, ...planned],
        outbox: {
          pending: outbox.filter((o) => o.status === 'pending').length,
          sent: outbox.filter((o) => o.status === 'sent').length,
          failed: outbox.filter((o) => o.status === 'failed').length,
        },
        terminals: [
          { name: 'Storage', state: 'connected' },
          { name: 'Backups', state: backupState },
          {
            name: 'Cloud sync',
            state: terminals.sync ? (terminals.sync.isOnline() ? 'online' : 'offline') : 'not set up yet',
          },
          { name: 'WhatsApp and SMS', state: 'not set up yet' },
          { name: 'Printer', state: 'not set up yet' },
          { name: 'Recipe generator', state: 'not set up yet' },
        ],
        activeSessions: sessions.filter((x) => Date.parse(x.expiresAt) > nowMs).length,
        backup,
        system,
      };
    },
  },
};
