import type {
  AuditEntry,
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
import { PLANNED_CIRCUITS, type CircuitName, type PanelConfig } from './intents';
import type { Clock, Store, Terminals } from './ports';
import {
  PAYMENT_LABEL,
  PAYMENT_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  deriveOrderStatus,
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
}

export interface StaffSigninRow {
  id: string;
  name: string;
  role: Role;
}

export type ScreenId = 'sell' | 'orders' | 'catalogue' | 'audit' | 'panel_map';
export interface NavItem {
  id: ScreenId;
  label: string;
}

export interface FeedMap {
  navigation: { params: Record<string, never>; data: NavItem[] };
  staff_signin: { params: Record<string, never>; data: StaffSigninRow[] };
  catalogue_grid: { params: { includeArchived?: boolean }; data: CatalogueGridItem[] };
  order_list: { params: Record<string, never>; data: OrderListItem[] };
  order_card: { params: { orderId: string }; data: OrderCardData };
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
  activeSessions: () => number;
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

const OPEN_LINE_STATUSES = ['new', 'ready', 'out_for_delivery'];

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
  };
}

/* ---------- Feeds ---------- */

const NAV: Record<Role, NavItem[]> = {
  owner: [
    { id: 'sell', label: 'Sell' },
    { id: 'orders', label: 'Orders' },
    { id: 'catalogue', label: 'Catalogue' },
    { id: 'audit', label: 'Activity' },
  ],
  cashier: [
    { id: 'sell', label: 'Sell' },
    { id: 'orders', label: 'Orders' },
    { id: 'catalogue', label: 'Catalogue' },
  ],
  baker: [{ id: 'catalogue', label: 'Catalogue' }],
  inventory: [{ id: 'catalogue', label: 'Catalogue' }],
  it: [{ id: 'panel_map', label: 'Panel map' }],
};

export const feeds: FeedRegistry = {
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
        store.list<OrderLine>('orderLines'),
      ]);
      const committed = new Map<string, number>();
      for (const l of lines) {
        if (OPEN_LINE_STATUSES.includes(l.status)) committed.set(l.combinationId, (committed.get(l.combinationId) ?? 0) + l.qty);
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
      const [orders, lines, payments, refunds] = await Promise.all([
        store.list<Order>('orders'),
        store.list<OrderLine>('orderLines'),
        store.list<Payment>('payments'),
        store.list<Refund>('refunds'),
      ]);
      return orders
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((o) =>
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

      const cardLines = lines.map((l): OrderCardLine => {
        const cancelled = l.status === 'cancelled';
        const lineStatus = (l.status as OrderStatus) ?? 'new';
        return {
          lineId: l.id,
          title: l.snapshot.productName,
          options: Object.values(l.snapshot.options).join(', '),
          allergens: l.snapshot.allergens,
          qty: l.qty,
          unitPriceLabel: fmt(l.snapshot.unitPrice),
          totalLabel: fmt(lineTotal(l)),
          status: l.status,
          statusLabel: STATUS_LABEL[lineStatus],
          statusTone: STATUS_TONE[lineStatus],
          cancelled,
          actions: nextActions(order, l, role),
          canRemove: !cancelled && l.status === 'new' && (payments.length === 0 || role === 'owner'),
        };
      });

      const warnings: string[] = [];
      if (money.balance > 0 && base.status !== 'new' && base.status !== 'empty' && !cancelledOrder)
        warnings.push(`${fmt(money.balance)} is still unpaid.`);
      if (money.overpaid > 0) warnings.push(`${fmt(money.overpaid)} has been paid above the current total.`);

      return {
        ...base,
        source: order.source,
        deliveryAddress: order.deliveryAddress,
        lines: cardLines,
        paidLabel: fmt(money.paid),
        refundedLabel: money.refunded > 0 ? fmt(money.refunded) : null,
        balance: money.balance,
        total: money.total,
        canRecordPayment: (role === 'owner' || role === 'cashier') && !cancelledOrder && money.balance > 0,
        canCancel: !finished && (role === 'owner' || (role === 'cashier' && money.net <= 0)),
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

  audit_view: {
    roles: ['owner'],
    build: async ({ store }) =>
      (await store.list<AuditEntry>('audit'))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 200)
        .map((a) => ({
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
    build: async ({ store, stats, terminals, activeSessions }) => {
      const outbox = await store.list<OutboxItem>('outbox');
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
      return {
        circuits: [...live, ...planned],
        outbox: {
          pending: outbox.filter((o) => o.status === 'pending').length,
          sent: outbox.filter((o) => o.status === 'sent').length,
          failed: outbox.filter((o) => o.status === 'failed').length,
        },
        terminals: [
          { name: 'Local storage', state: 'connected' },
          {
            name: 'Cloud sync',
            state: terminals.sync ? (terminals.sync.isOnline() ? 'online' : 'offline') : 'not set up yet',
          },
          { name: 'WhatsApp and SMS', state: 'not set up yet' },
          { name: 'Printer', state: 'not set up yet' },
          { name: 'Recipe generator', state: 'not set up yet' },
        ],
        activeSessions: activeSessions(),
      };
    },
  },
};
