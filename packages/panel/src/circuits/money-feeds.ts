import type { Order, OrderLine, Payment, PaymentMethod, Refund, Staff } from '../domain';
import type { FeedDef } from '../feeds';
import { todayLocal } from './dates';
import { STATUS_LABEL, deriveOrderStatus, lineTotal, moneySummary, round2 } from './order-logic';
import { loadSettings } from './settings';

/* ---------- Payments list (today's sales, transactions) ---------- */

export interface LedgerRow {
  id: string;
  at: string;
  /** Local time of day, such as "14:42". */
  time: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  kind: 'payment' | 'deposit' | 'refund';
  kindLabel: string;
  method: PaymentMethod;
  methodLabel: string;
  /** Negative for a refund. */
  amount: number;
  amountLabel: string;
  byName: string;
  /** Refunds only. */
  reason?: string;
  reference?: string;
}
export interface PaymentsLedgerData {
  /** The day shown, as YYYY-MM-DD. */
  day: string;
  isToday: boolean;
  /** Newest first. */
  rows: LedgerRow[];
  totals: { count: number; takenLabel: string; refundedLabel: string; netLabel: string; net: number; refunds: number };
  byMethod: { method: PaymentMethod; label: string; amount: number; amountLabel: string; share: number }[];
  /** Orders that still owe money, whatever day it is. Orders still waiting for a price are not listed. */
  outstanding: { orderId: string; orderNumber: string; customerName: string; balance: number; balanceLabel: string; statusLabel: string; deliveryDate?: string; ready: boolean }[];
  outstandingTotalLabel: string;
  can: { seeOutstanding: boolean };
}

/* ---------- Receipt ---------- */

export interface ReceiptData {
  orderId: string;
  number: string;
  issuedAt: string;
  issuedLabel: string;
  shop: { name: string; address?: string; phone?: string; footer?: string };
  customer: { name: string; phone?: string };
  fulfilmentLabel: string;
  deliveryAddress?: string;
  lines: { title: string; options: string; qty: number; unitPriceLabel: string; totalLabel: string }[];
  totalLabel: string;
  payments: { at: string; atLabel: string; methodLabel: string; amountLabel: string; reference?: string }[];
  refunds: { atLabel: string; amountLabel: string; reason: string }[];
  paidLabel: string;
  balanceLabel: string;
  /** "Paid in full", "Balance due", "Waiting for a price", or "Cancelled". */
  statusLabel: string;
  /** The whole receipt as plain text, ready to print in a fixed-width font or to send in a message. */
  text: string;
  /** Ready-made links. Absent when the customer has no phone number. */
  share: { whatsappUrl?: string; smsUrl?: string };
  /** Why a receipt cannot be given yet, in plain words. Absent when it can. */
  blockedReason: string | null;
}

export const METHOD_NAME: Record<PaymentMethod, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', mobile_money: 'Mobile money' };

const localDay = (iso: string) => todayLocal(new Date(iso));
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const stamp = (iso: string) => `${longDate(iso)} ${hhmm(iso)}`;

type Bundle = { orders: Order[]; lines: OrderLine[]; payments: Payment[]; refunds: Refund[] };
const forOrder = (b: Bundle, id: string) => ({
  order: b.orders.find((o) => o.id === id),
  lines: b.lines.filter((l) => l.orderId === id),
  payments: b.payments.filter((p) => p.orderId === id).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
  refunds: b.refunds.filter((r) => r.orderId === id),
});

export const moneyFeeds = {
  payments_ledger: {
    roles: ['owner', 'cashier'],
    build: async ({ store, config, clock, session }, params) => {
      const fmt = config.formatMoney;
      const today = todayLocal(clock.now());
      const day = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : today;
      const [orders, lines, payments, refunds, staff] = await Promise.all([
        store.list<Order>('orders'),
        store.list<OrderLine>('orderLines'),
        store.list<Payment>('payments'),
        store.list<Refund>('refunds'),
        store.list<Staff>('staff'),
      ]);
      const b: Bundle = { orders, lines, payments, refunds };
      const nameOf = (id: string) => staff.find((s) => s.id === id)?.name ?? 'Someone';

      const rows: LedgerRow[] = [];
      for (const p of payments.filter((x) => localDay(x.receivedAt) === day)) {
        const { order, lines: ol, payments: op } = forOrder(b, p.orderId);
        if (!order) continue;
        // A payment is a deposit when the order was not fully paid once it was taken.
        const upTo = round2(op.filter((x) => x.receivedAt <= p.receivedAt).reduce((s, x) => s + x.amount, 0));
        const total = moneySummary(ol, [], []).total;
        const deposit = total > 0 && upTo + 0.005 < total;
        rows.push({
          id: p.id,
          at: p.receivedAt,
          time: hhmm(p.receivedAt),
          orderId: order.id,
          orderNumber: order.number,
          customerName: order.customerName,
          kind: deposit ? 'deposit' : 'payment',
          kindLabel: deposit ? 'Deposit' : 'Payment',
          method: p.method,
          methodLabel: METHOD_NAME[p.method],
          amount: p.amount,
          amountLabel: fmt(p.amount),
          byName: nameOf(p.receivedBy),
          reference: p.reference,
        });
      }
      for (const r of refunds.filter((x) => localDay(x.at) === day)) {
        const order = orders.find((o) => o.id === r.orderId);
        if (!order) continue;
        rows.push({
          id: r.id,
          at: r.at,
          time: hhmm(r.at),
          orderId: order.id,
          orderNumber: order.number,
          customerName: order.customerName,
          kind: 'refund',
          kindLabel: 'Refund',
          method: r.method,
          methodLabel: METHOD_NAME[r.method],
          amount: -r.amount,
          amountLabel: `−${fmt(r.amount)}`,
          byName: nameOf(r.approvedBy),
          reason: r.reason,
        });
      }
      rows.sort((a, c) => c.at.localeCompare(a.at));

      const taken = round2(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
      const refunded = round2(-rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0));
      const methods = (Object.keys(METHOD_NAME) as PaymentMethod[]).map((m) => ({ m, amount: round2(rows.filter((r) => r.method === m).reduce((s, r) => s + r.amount, 0)) }));
      const positive = methods.reduce((s, x) => s + Math.max(0, x.amount), 0);

      const owner = session?.role === 'owner';
      const outstanding = orders
        .map((o) => {
          const f = forOrder(b, o.id);
          const status = deriveOrderStatus(f.lines);
          const m = moneySummary(f.lines, f.payments, f.refunds);
          return { o, status, m };
        })
        .filter(({ status, m }) => status !== 'cancelled' && status !== 'empty' && !m.quotePending && m.balance > 0.005)
        .sort((a, c) => (a.o.deliveryDate ?? '9999').localeCompare(c.o.deliveryDate ?? '9999') || a.o.number.localeCompare(c.o.number))
        .map(({ o, status, m }) => ({
          orderId: o.id,
          orderNumber: o.number,
          customerName: o.customerName,
          balance: m.balance,
          balanceLabel: fmt(m.balance),
          statusLabel: STATUS_LABEL[status],
          deliveryDate: o.deliveryDate,
          ready: status === 'ready' || status === 'out_for_delivery',
        }));

      return {
        day,
        isToday: day === today,
        rows,
        totals: {
          count: rows.length,
          takenLabel: fmt(taken),
          refundedLabel: fmt(refunded),
          netLabel: fmt(round2(taken - refunded)),
          net: round2(taken - refunded),
          refunds: rows.filter((r) => r.kind === 'refund').length,
        },
        byMethod: methods.map(({ m, amount }) => ({ method: m, label: METHOD_NAME[m], amount, amountLabel: fmt(amount), share: positive > 0 ? Math.round((Math.max(0, amount) / positive) * 100) : 0 })),
        outstanding,
        outstandingTotalLabel: fmt(round2(outstanding.reduce((s, x) => s + x.balance, 0))),
        can: { seeOutstanding: owner || session?.role === 'cashier' },
      };
    },
  } satisfies FeedDef<'payments_ledger'>,

  receipt: {
    roles: ['owner', 'cashier'],
    build: async ({ store, config, clock }, params) => {
      const fmt = config.formatMoney;
      const order = await store.get<Order>('orders', params.orderId);
      if (!order) throw new Error('That order no longer exists.');
      const [lines, payments, refunds, shop] = await Promise.all([
        store.find<OrderLine>('orderLines', { where: { orderId: order.id } }),
        store.find<Payment>('payments', { where: { orderId: order.id } }),
        store.find<Refund>('refunds', { where: { orderId: order.id } }),
        loadSettings(store),
      ]);
      const status = deriveOrderStatus(lines);
      const m = moneySummary(lines, payments, refunds);
      const shown = lines.filter((l) => l.status !== 'cancelled' && l.status !== 'draft' && l.status !== 'awaiting_quote');
      const issuedAt = clock.now().toISOString();
      const statusLabel =
        status === 'cancelled' ? 'Cancelled' : m.quotePending ? 'Waiting for a price' : m.total <= 0 ? 'Nothing to pay' : m.balance <= 0.005 ? 'Paid in full' : 'Balance due';
      const blockedReason =
        status === 'cancelled' ? 'This order was cancelled.' : m.quotePending ? 'A custom cake on this order has no price yet.' : shown.length === 0 ? 'There is nothing on this order yet.' : payments.length === 0 ? 'Nothing has been paid yet.' : null;
      const pays = payments.slice().sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      const rows = shown.map((l) => ({
        title: l.snapshot.productName,
        options: Object.values(l.snapshot.options).join(', '),
        qty: l.qty,
        unitPriceLabel: fmt(l.snapshot.unitPrice),
        totalLabel: fmt(lineTotal(l)),
      }));
      const W = 38;
      const pad = (l: string, r: string) => (l.length + r.length + 1 > W ? `${l.slice(0, Math.max(1, W - r.length - 2))}… ${r}` : `${l}${' '.repeat(W - l.length - r.length)}${r}`);
      const rule = '-'.repeat(W);
      const text = [
        shop.shopName,
        shop.shopAddress,
        shop.shopPhone,
        '',
        `Receipt ${order.number}`,
        stamp(issuedAt),
        `Customer: ${order.customerName}`,
        order.fulfilment === 'delivery' ? `Delivery${order.deliveryDate ? ` on ${order.deliveryDate}` : ''}${order.deliveryAddress ? `: ${order.deliveryAddress}` : ''}` : `Pickup${order.deliveryDate ? ` on ${order.deliveryDate}` : ''}`,
        rule,
        ...rows.flatMap((r) => [pad(`${r.qty} x ${r.title}`, r.totalLabel), ...(r.options ? [`  ${r.options}`] : [])]),
        rule,
        pad('Total', fmt(m.total)),
        ...pays.map((p) => pad(`Paid ${METHOD_NAME[p.method]} ${hhmm(p.receivedAt)}`, fmt(p.amount))),
        ...refunds.map((r) => pad(`Refund: ${r.reason}`, `−${fmt(r.amount)}`)),
        pad(m.balance > 0.005 ? 'Balance due' : 'Balance', fmt(m.balance)),
        '',
        shop.receiptFooter,
      ]
        .filter((x): x is string => x !== undefined)
        .join('\n');
      const phone = order.customerPhone;
      return {
        orderId: order.id,
        number: order.number,
        issuedAt,
        issuedLabel: stamp(issuedAt),
        shop: { name: shop.shopName, address: shop.shopAddress, phone: shop.shopPhone, footer: shop.receiptFooter },
        customer: { name: order.customerName, phone },
        fulfilmentLabel: order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup',
        deliveryAddress: order.deliveryAddress,
        lines: rows,
        totalLabel: fmt(m.total),
        payments: pays.map((p) => ({ at: p.receivedAt, atLabel: stamp(p.receivedAt), methodLabel: METHOD_NAME[p.method], amountLabel: fmt(p.amount), reference: p.reference })),
        refunds: refunds.map((r) => ({ atLabel: stamp(r.at), amountLabel: fmt(r.amount), reason: r.reason })),
        paidLabel: fmt(m.net),
        balanceLabel: fmt(m.balance),
        statusLabel,
        text,
        share: phone ? { whatsappUrl: `https://wa.me/${phone.replace('+', '')}?text=${encodeURIComponent(text)}`, smsUrl: `sms:${phone}?body=${encodeURIComponent(text)}` } : {},
        blockedReason,
      };
    },
  } satisfies FeedDef<'receipt'>,
};
