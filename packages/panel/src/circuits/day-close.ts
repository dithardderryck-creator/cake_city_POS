import type { AuditEntry, CountDifference, DayClose, HeldAction, Order, OrderLine, Payment, PaymentMethod, Refund, Staff } from '../domain';
import type { FeedDef } from '../feeds';
import { DomainError, type Registry } from '../intents';
import type { Store } from '../ports';
import { hhmm, isIsoDate, localDay, todayLocal } from './dates';
import { METHOD_NAME } from './money-feeds';
import { activeLines, deriveOrderStatus, lineTotal, moneySummary, round2 } from './order-logic';
import { loadSettings } from './settings';

/** Everything the owner sees when she ends a day, plus the cash drawer sum. */
export interface DayReportData {
  /** The day shown, as YYYY-MM-DD. */
  day: string;
  dayLabel: string;
  isToday: boolean;
  money: {
    taken: number;
    takenLabel: string;
    refunded: number;
    refundedLabel: string;
    net: number;
    netLabel: string;
    byMethod: { method: PaymentMethod; label: string; taken: number; takenLabel: string; refunded: number; refundedLabel: string }[];
  };
  refunds: { id: string; time: string; orderNumber: string; amountLabel: string; methodLabel: string; reason: string; byName: string }[];
  orders: { withPayments: number; instantSales: number; itemsSold: number };
  topItems: { name: string; qty: number; totalLabel: string }[];
  /** Sales a till made while offline: those that went through that day, and those still waiting for the owner now. */
  offline: { wentThrough: number; waiting: number };
  outstanding: { count: number; totalLabel: string };
  /** Stock counts that came out different from the books on that day. */
  stockDifferences: number;
  cash: {
    openingFloat: number;
    openingFloatLabel: string;
    cashIn: number;
    cashInLabel: string;
    cashRefunded: number;
    cashRefundedLabel: string;
    expected: number;
    expectedLabel: string;
  };
  /** Null until someone has counted the drawer for this day. */
  closed: null | {
    closedAt: string;
    closedAtLabel: string;
    byName: string;
    countedCash: number;
    countedLabel: string;
    difference: number;
    differenceLabel: string;
    differenceWords: string;
    floatKept: number;
    floatKeptLabel: string;
    note: string | null;
    /** True when payments or refunds were recorded for this day after it was counted, so the sum no longer matches. */
    changedSince: boolean;
    expectedAtCloseLabel: string;
  };
  closeBy: 'owner' | 'cashier_and_owner';
  can: { close: boolean };
}

const longDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

const signed = (n: number, fmt: (n: number) => string) => (n === 0 ? fmt(0) : n > 0 ? `+${fmt(n)}` : `−${fmt(-n)}`);
const words = (n: number, fmt: (n: number) => string) => (n === 0 ? 'The drawer matches.' : n > 0 ? `${fmt(n)} more than expected.` : `${fmt(-n)} short.`);

/** The day that opens a drawer is the one before it that was counted. Nothing counted before: it starts empty. */
function openingFloatFor(closes: DayClose[], day: string): number {
  const before = closes.filter((c) => c.day < day).sort((a, b) => b.day.localeCompare(a.day))[0];
  return before ? before.floatKept : 0;
}

async function cashFigures(store: Store, day: string) {
  const [payments, refunds, closes] = await Promise.all([store.list<Payment>('payments'), store.list<Refund>('refunds'), store.list<DayClose>('dayCloses')]);
  const cashIn = round2(payments.filter((p) => p.method === 'cash' && localDay(p.receivedAt) === day).reduce((s, p) => s + p.amount, 0));
  const cashRefunded = round2(refunds.filter((r) => r.method === 'cash' && localDay(r.at) === day).reduce((s, r) => s + r.amount, 0));
  const openingFloat = openingFloatFor(closes, day);
  return { openingFloat, cashIn, cashRefunded, expected: round2(openingFloat + cashIn - cashRefunded), existing: closes.find((c) => c.id === day) };
}

export const dayCloseFeeds = {
  day_report: {
    roles: ['owner', 'cashier'],
    build: async ({ store, config, clock, session }, params) => {
      const fmt = config.formatMoney;
      const settings = await loadSettings(store);
      const owner = session?.role === 'owner';
      if (!owner && settings.dayCloseBy !== 'cashier_and_owner') throw new Error('Only the owner can see the end-of-day report.');

      const today = todayLocal(clock.now());
      const day = params.day && isIsoDate(params.day) ? params.day : today;
      const [orders, lines, payments, refunds, staff, diffs, audit, held] = await Promise.all([
        store.list<Order>('orders'),
        store.list<OrderLine>('orderLines'),
        store.list<Payment>('payments'),
        store.list<Refund>('refunds'),
        store.list<Staff>('staff'),
        store.list<CountDifference>('countDifferences'),
        store.list<AuditEntry>('audit'),
        store.list<HeldAction>('heldActions'),
      ]);
      const nameOf = (id: string) => staff.find((s) => s.id === id)?.name ?? 'Someone';
      const dayPayments = payments.filter((p) => localDay(p.receivedAt) === day);
      const dayRefunds = refunds.filter((r) => localDay(r.at) === day);

      const methods = (Object.keys(METHOD_NAME) as PaymentMethod[]).map((m) => {
        const taken = round2(dayPayments.filter((p) => p.method === m).reduce((s, p) => s + p.amount, 0));
        const refunded = round2(dayRefunds.filter((r) => r.method === m).reduce((s, r) => s + r.amount, 0));
        return { method: m, label: METHOD_NAME[m], taken, takenLabel: fmt(taken), refunded, refundedLabel: fmt(refunded) };
      });
      const taken = round2(methods.reduce((s, m) => s + m.taken, 0));
      const refunded = round2(methods.reduce((s, m) => s + m.refunded, 0));

      // What was rung up that day: lines of orders made that day that are not cancelled and have a price.
      const dayOrders = orders.filter((o) => localDay(o.createdAt) === day);
      const sold = dayOrders.flatMap((o) => activeLines(lines.filter((l) => l.orderId === o.id)).filter((l) => l.status !== 'draft' && l.status !== 'awaiting_quote'));
      const byItem = new Map<string, { qty: number; total: number }>();
      for (const l of sold) {
        const cur = byItem.get(l.snapshot.productName) ?? { qty: 0, total: 0 };
        byItem.set(l.snapshot.productName, { qty: cur.qty + l.qty, total: round2(cur.total + lineTotal(l)) });
      }

      const outstanding = orders
        .map((o) => {
          const ol = lines.filter((l) => l.orderId === o.id);
          return { status: deriveOrderStatus(ol), m: moneySummary(ol, payments.filter((p) => p.orderId === o.id), refunds.filter((r) => r.orderId === o.id)) };
        })
        .filter(({ status, m }) => status !== 'cancelled' && status !== 'empty' && !m.quotePending && m.balance > 0.005);

      const cash = await cashFigures(store, day);
      const c = cash.existing;
      const expectedNow = cash.expected;

      return {
        day,
        dayLabel: longDate(day),
        isToday: day === today,
        money: { taken, takenLabel: fmt(taken), refunded, refundedLabel: fmt(refunded), net: round2(taken - refunded), netLabel: fmt(round2(taken - refunded)), byMethod: methods },
        refunds: dayRefunds
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((r) => ({ id: r.id, time: hhmm(r.at), orderNumber: orders.find((o) => o.id === r.orderId)?.number ?? '?', amountLabel: fmt(r.amount), methodLabel: METHOD_NAME[r.method], reason: r.reason, byName: nameOf(r.approvedBy) })),
        orders: {
          withPayments: new Set(dayPayments.map((p) => p.orderId)).size,
          instantSales: dayOrders.filter((o) => o.instant).length,
          itemsSold: sold.reduce((s, l) => s + l.qty, 0),
        },
        topItems: [...byItem.entries()]
          .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([name, v]) => ({ name, qty: v.qty, totalLabel: fmt(v.total) })),
        offline: {
          wentThrough: audit.filter((a) => a.intent === 'offline/replay' && a.outcome === 'ok' && localDay(a.at) === day).length,
          waiting: held.filter((h) => h.status === 'held').length,
        },
        outstanding: { count: outstanding.length, totalLabel: fmt(round2(outstanding.reduce((s, x) => s + x.m.balance, 0))) },
        stockDifferences: diffs.filter((d) => localDay(d.at) === day && d.difference !== 0).length,
        cash: {
          openingFloat: cash.openingFloat,
          openingFloatLabel: fmt(cash.openingFloat),
          cashIn: cash.cashIn,
          cashInLabel: fmt(cash.cashIn),
          cashRefunded: cash.cashRefunded,
          cashRefundedLabel: fmt(cash.cashRefunded),
          expected: expectedNow,
          expectedLabel: fmt(expectedNow),
        },
        closed: c
          ? {
              closedAt: c.closedAt,
              closedAtLabel: `${longDate(localDay(c.closedAt))} ${hhmm(c.closedAt)}`,
              byName: c.closedByName,
              countedCash: c.countedCash,
              countedLabel: fmt(c.countedCash),
              difference: c.difference,
              differenceLabel: signed(c.difference, fmt),
              differenceWords: words(c.difference, fmt),
              floatKept: c.floatKept,
              floatKeptLabel: fmt(c.floatKept),
              note: c.note ?? null,
              changedSince: Math.abs(c.expectedCash - expectedNow) > 0.005,
              expectedAtCloseLabel: fmt(c.expectedCash),
            }
          : null,
        closeBy: settings.dayCloseBy,
        can: { close: true },
      };
    },
  } satisfies FeedDef<'day_report'>,
};

export const dayCloseIntents = {
  'day/close': {
    circuit: 'Payments',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const s = await loadSettings(ctx.store);
      const errors: string[] = [];
      if (ctx.session?.role !== 'owner' && s.dayCloseBy !== 'cashier_and_owner') errors.push('Only the owner can close the day.');
      const today = todayLocal(ctx.clock.now());
      const day = p.day ?? today;
      if (!isIsoDate(day)) errors.push('Choose a real date.');
      else if (day > today) errors.push('A day that has not happened yet cannot be closed.');
      const kept = p.floatKept ?? 0;
      if (kept > p.countedCash) errors.push('You cannot leave more in the drawer than you counted.');
      if (errors.length === 0) {
        const cash = await cashFigures(ctx.store, day);
        const difference = round2(p.countedCash - cash.expected);
        if (difference !== 0 && !p.note?.trim()) errors.push(`The count is ${difference > 0 ? 'over' : 'short'} by ${ctx.config.formatMoney(Math.abs(difference))}. Write a short note saying why, then close.`);
      }
      return errors;
    },
    handle: async (p, ctx) => {
      const day = p.day ?? todayLocal(ctx.clock.now());
      const cash = await cashFigures(ctx.store, day);
      const difference = round2(p.countedCash - cash.expected);
      if (difference !== 0 && !p.note?.trim()) throw new DomainError('invalid', ['Write a short note saying why the count is different.']);
      const now = ctx.clock.now().toISOString();
      const [payments, refunds] = await Promise.all([ctx.store.list<Payment>('payments'), ctx.store.list<Refund>('refunds')]);
      const net = round2(
        payments.filter((x) => localDay(x.receivedAt) === day).reduce((s, x) => s + x.amount, 0) - refunds.filter((x) => localDay(x.at) === day).reduce((s, x) => s + x.amount, 0),
      );
      const note = p.note?.trim() || undefined;
      const record: DayClose = {
        id: day,
        day,
        closedAt: now,
        closedById: ctx.session!.userId,
        closedByName: ctx.session!.name,
        openingFloat: cash.openingFloat,
        cashIn: cash.cashIn,
        cashRefunded: cash.cashRefunded,
        expectedCash: cash.expected,
        countedCash: p.countedCash,
        difference,
        floatKept: p.floatKept ?? 0,
        ...(note ? { note } : {}),
        netTotal: net,
      };
      await ctx.store.put('dayCloses', record);
      const fmt = ctx.config.formatMoney;
      const again = cash.existing ? ' (replacing the earlier count)' : '';
      return {
        summary: `Closed ${day}: counted ${fmt(p.countedCash)}, expected ${fmt(cash.expected)}${difference === 0 ? '' : `, ${difference > 0 ? 'over' : 'short'} by ${fmt(Math.abs(difference))}`}${again}`,
        target: day,
        data: { day, difference, expectedCash: cash.expected },
        events: [{ type: 'DayClosed', payload: { day, difference } }],
      };
    },
  },
} satisfies Partial<Registry>;
