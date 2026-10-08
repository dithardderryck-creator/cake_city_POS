import type { Combination, CountDifference, CountSession, Ingredient, IngredientMovement, Order, OrderLine, Payment, PaymentMethod, Product, Refund, UsageReport, UsageSuggestion } from '../domain';
import { daysLeftInfo } from '../days-left';
import type { FeedDef } from '../feeds';
import { formatQty } from '../units';
import { hhmm, localDay, todayLocal } from './dates';
import { METHOD_NAME } from './money-feeds';
import { activeLines, lineTotal, round2 } from './order-logic';

/* ---------- Types ---------- */

export interface ReportsParams {
  /** The period: the last 7 or 30 days, ending today. Default 7. */
  days?: 7 | 30;
}
export interface ReportDay {
  day: string;
  /** For example "Mon 5". */
  label: string;
  total: number;
  totalLabel: string;
}
export interface ReportsData {
  range: { days: number; from: string; to: string };
  /** Sales are the money received, less refunds, on the day it happened. */
  sales: {
    total: number;
    totalLabel: string;
    perDay: number;
    perDayLabel: string;
    /** The same number of days just before this period. */
    previousTotal: number;
    previousTotalLabel: string;
    /** Null when there was nothing in the earlier period to compare with. */
    changePercent: number | null;
    today: number;
    todayLabel: string;
    yesterday: number;
    yesterdayLabel: string;
    todayChangePercent: number | null;
    series: ReportDay[];
    /** The best day of the period (the tallest bar), or null when there were no sales. */
    bestDay: ReportDay | null;
  };
  methods: { method: PaymentMethod; label: string; amount: number; amountLabel: string; share: number }[];
  /** By value of the items on orders placed in the period (not cancelled). At most 5, then "Everything else". */
  bestSellers: { name: string; amount: number; amountLabel: string; share: number; units: number }[];
  /** The ingredients that will run out first, from confirmed usage. `noData` counts those without enough history. */
  stockDays: { rows: { ingredientId: string; name: string; daysLeft: number; label: string; level: 'critical' | 'low' | 'ok' }[]; noData: number };
  /** Confirmed usage compared with what the system suggested, for cakes whose usage was confirmed in the period. */
  usage: {
    ingredientId: string;
    name: string;
    unit: string;
    suggested: number;
    suggestedText: string;
    confirmed: number;
    confirmedText: string;
    /** Null when nothing was suggested. */
    differencePercent: number | null;
    /** More than 10% apart. */
    flagged: boolean;
    direction: 'more' | 'less' | null;
  }[];
  refunds: { total: number; totalLabel: string; rows: { refundId: string; day: string; orderNumber: string; customerName: string; amount: number; amountLabel: string; reason: string }[] };
  countDifferences: { at: string; day: string; name: string; expectedText: string; countedText: string; gapText: string; gap: number; big: boolean; note: string }[];
  /** Stock written off as wasted. There are no ingredient prices, so there is no money value. */
  waste: { count: number; rows: { day: string; time: string; name: string; amountText: string; why: string; byName: string }[] };
}

/* ---------- Helpers ---------- */

const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
const daysBack = (now: Date, n: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return todayLocal(d);
};
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
const FLAG = 0.1;

/* ---------- Feed ---------- */

export const reportFeeds = {
  reports: {
    roles: ['owner'],
    build: async ({ store, clock, config }, params) => {
      const fmt = config.formatMoney;
      const n = params.days === 30 ? 30 : 7;
      const now = clock.now();
      const to = todayLocal(now);
      const from = daysBack(now, n - 1);
      const prevFrom = daysBack(now, 2 * n - 1);
      const prevTo = daysBack(now, n);
      const inRange = (iso: string) => {
        const d = localDay(iso);
        return d >= from && d <= to;
      };

      const [orders, lines, payments, refunds, ingredients, movements, reports, suggestions, sessions, diffs, products, combos] = await Promise.all([
        store.list<Order>('orders'),
        store.list<OrderLine>('orderLines'),
        store.list<Payment>('payments'),
        store.list<Refund>('refunds'),
        store.list<Ingredient>('ingredients'),
        store.list<IngredientMovement>('ingredientMovements'),
        store.list<UsageReport>('usageReports'),
        store.list<UsageSuggestion>('usageSuggestions'),
        store.list<CountSession>('countSessions'),
        store.list<CountDifference>('countDifferences'),
        store.list<Product>('products'),
        store.list<Combination>('combinations'),
      ]);
      const orderById = new Map(orders.map((o) => [o.id, o]));

      /* Sales: money received less refunds, by day. */
      const net = new Map<string, number>();
      const add = (day: string, amount: number) => net.set(day, round2((net.get(day) ?? 0) + amount));
      for (const p of payments) add(localDay(p.receivedAt), p.amount);
      for (const r of refunds) add(localDay(r.at), -r.amount);
      const series: ReportDay[] = [];
      for (let i = n - 1; i >= 0; i--) {
        const day = daysBack(now, i);
        const total = net.get(day) ?? 0;
        series.push({ day, label: dayLabel(day), total, totalLabel: fmt(total) });
      }
      const total = round2(series.reduce((s, d) => s + d.total, 0));
      let previousTotal = 0;
      for (const [day, v] of net) if (day >= prevFrom && day <= prevTo) previousTotal += v;
      previousTotal = round2(previousTotal);
      const today = net.get(to) ?? 0;
      const yesterday = net.get(daysBack(now, 1)) ?? 0;
      const best = [...series].sort((a, b) => b.total - a.total)[0];

      /* Payment methods, net of refunds. */
      const byMethod = new Map<PaymentMethod, number>();
      for (const p of payments.filter((x) => inRange(x.receivedAt))) byMethod.set(p.method, round2((byMethod.get(p.method) ?? 0) + p.amount));
      for (const r of refunds.filter((x) => inRange(x.at))) byMethod.set(r.method, round2((byMethod.get(r.method) ?? 0) - r.amount));
      const methodTotal = [...byMethod.values()].reduce((s, v) => s + Math.max(0, v), 0);
      const methods = [...byMethod.entries()]
        .sort((a, b) => b[1] - a[1] || METHOD_NAME[a[0]].localeCompare(METHOD_NAME[b[0]]))
        .map(([method, amount]) => ({ method, label: METHOD_NAME[method], amount, amountLabel: fmt(amount), share: methodTotal > 0 ? Math.round((Math.max(0, amount) / methodTotal) * 1000) / 1000 : 0 }));

      /* Best sellers: value of items on orders placed in the period. */
      const sold = new Map<string, { amount: number; units: number }>();
      for (const o of orders.filter((x) => inRange(x.createdAt))) {
        for (const l of activeLines(lines.filter((x) => x.orderId === o.id))) {
          const value = lineTotal(l);
          if (!(value > 0)) continue; // not priced yet
          const name = l.type === 'custom' ? 'Custom cakes' : l.snapshot.productName;
          const cur = sold.get(name) ?? { amount: 0, units: 0 };
          sold.set(name, { amount: round2(cur.amount + value), units: cur.units + l.qty });
        }
      }
      const ranked = [...sold.entries()].sort((a, b) => b[1].amount - a[1].amount);
      const soldTotal = ranked.reduce((s, [, v]) => s + v.amount, 0);
      const top = ranked.slice(0, 5).map(([name, v]) => ({ name, amount: v.amount, amountLabel: fmt(v.amount), share: soldTotal > 0 ? Math.round((v.amount / soldTotal) * 1000) / 1000 : 0, units: v.units }));
      const rest = ranked.slice(5);
      if (rest.length) {
        const amount = round2(rest.reduce((s, [, v]) => s + v.amount, 0));
        top.push({ name: 'Everything else', amount, amountLabel: fmt(amount), share: Math.round((amount / soldTotal) * 1000) / 1000, units: rest.reduce((s, [, v]) => s + v.units, 0) });
      }

      /* Days of stock left. */
      const stock: ReportsData['stockDays']['rows'] = [];
      let noData = 0;
      for (const i of ingredients.filter((x) => x.active)) {
        const dl = daysLeftInfo(i.onHand, movements.filter((m) => m.ingredientId === i.id), now);
        if (dl.days === null) {
          noData++;
          continue;
        }
        const days = Math.round(dl.days * 10) / 10;
        stock.push({ ingredientId: i.id, name: i.name, daysLeft: days, label: dl.label, level: days < 2 ? 'critical' : days < 4 ? 'low' : 'ok' });
      }
      stock.sort((a, b) => a.daysLeft - b.daysLeft);

      /* Usage: suggested vs confirmed, for cakes confirmed in the period. */
      const confirmedReports = reports.filter((r) => r.status === 'confirmed' && r.confirmedAt && inRange(r.confirmedAt));
      const use = new Map<string, { suggested: number; confirmed: number }>();
      const bump = (id: string, k: 'suggested' | 'confirmed', v: number) => use.set(id, { suggested: 0, confirmed: 0, ...use.get(id), [k]: (use.get(id)?.[k] ?? 0) + v });
      for (const lineId of new Set(confirmedReports.map((r) => r.lineId))) {
        for (const l of suggestions.find((s) => s.lineId === lineId)?.lines ?? []) bump(l.ingredientId, 'suggested', l.qty);
      }
      for (const r of confirmedReports) for (const c of r.confirmed ?? []) bump(c.ingredientId, 'confirmed', c.qty);
      const usage = [...use.entries()]
        .map(([id, v]) => {
          const ing = ingredients.find((i) => i.id === id);
          if (!ing) return null;
          const suggested = Math.round(v.suggested * 1000) / 1000;
          const confirmed = Math.round(v.confirmed * 1000) / 1000;
          const diff = suggested > 0 ? (confirmed - suggested) / suggested : null;
          const flagged = diff !== null ? Math.abs(diff) > FLAG : confirmed > 0;
          return {
            ingredientId: id,
            name: ing.name,
            unit: ing.unit,
            suggested,
            suggestedText: formatQty(suggested, ing.unit),
            confirmed,
            confirmedText: formatQty(confirmed, ing.unit),
            differencePercent: diff === null ? null : Math.round(diff * 100),
            flagged,
            direction: flagged ? ((diff === null || diff > 0 ? 'more' : 'less') as 'more' | 'less') : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.confirmed - a.confirmed);

      /* Refunds. */
      const refundRows = refunds
        .filter((r) => inRange(r.at))
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((r) => ({ refundId: r.id, day: localDay(r.at), orderNumber: orderById.get(r.orderId)?.number ?? '', customerName: orderById.get(r.orderId)?.customerName ?? '', amount: r.amount, amountLabel: fmt(r.amount), reason: r.reason }));

      /* Count differences: the daily count (ingredients and packaging) and counter items found short. */
      const label = (combinationId: string) => {
        const c = combos.find((x) => x.id === combinationId);
        return products.find((p) => p.id === c?.productId)?.name ?? 'Counter item';
      };
      const countRows: ReportsData['countDifferences'] = [];
      for (const s of sessions.filter((x) => x.status === 'submitted' && x.submittedAt && inRange(x.submittedAt))) {
        for (const r of s.results ?? []) {
          if (r.difference === 0) continue;
          countRows.push({ at: s.submittedAt!, day: localDay(s.submittedAt!), name: r.name, expectedText: formatQty(r.expected, r.unit), countedText: formatQty(r.counted, r.unit), gapText: `${r.difference > 0 ? '+' : '−'}${formatQty(Math.abs(r.difference), r.unit)}`, gap: r.difference, big: r.big, note: `Daily count by ${s.startedByName}` });
        }
      }
      for (const d of diffs.filter((x) => inRange(x.at) && x.difference !== 0)) {
        countRows.push({ at: d.at, day: localDay(d.at), name: label(d.combinationId), expectedText: String(d.expected), countedText: String(d.counted), gapText: `${d.difference > 0 ? '+' : '−'}${Math.abs(d.difference)}`, gap: d.difference, big: Math.abs(d.difference) / Math.max(d.expected, 1) >= FLAG, note: d.reason === 'shortfall_at_completion' ? 'Short when an order was completed' : 'Found in a count' });
      }
      countRows.sort((a, b) => b.at.localeCompare(a.at));

      /* Waste: stock written off. */
      const staffName = new Map<string, string>();
      for (const s of await store.list<{ id: string; name: string }>('staff')) staffName.set(s.id, s.name);
      const wasteRows = movements
        .filter((m) => m.reason === 'waste' && inRange(m.at))
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((m) => {
          const ing = ingredients.find((i) => i.id === m.ingredientId);
          return { day: localDay(m.at), time: hhmm(m.at), name: ing?.name ?? 'Item', amountText: ing ? formatQty(Math.abs(m.qty), ing.unit) : String(Math.abs(m.qty)), why: m.note ?? '', byName: staffName.get(m.by) ?? 'Someone' };
        });

      return {
        range: { days: n, from, to },
        sales: {
          total,
          totalLabel: fmt(total),
          perDay: round2(total / n),
          perDayLabel: fmt(round2(total / n)),
          previousTotal,
          previousTotalLabel: fmt(previousTotal),
          changePercent: pct(total, previousTotal),
          today,
          todayLabel: fmt(today),
          yesterday,
          yesterdayLabel: fmt(yesterday),
          todayChangePercent: pct(today, yesterday),
          series,
          bestDay: best && best.total > 0 ? best : null,
        },
        methods,
        bestSellers: top,
        stockDays: { rows: stock.slice(0, 6), noData },
        usage,
        refunds: { total: round2(refundRows.reduce((s, r) => s + r.amount, 0)), totalLabel: fmt(round2(refundRows.reduce((s, r) => s + r.amount, 0))), rows: refundRows },
        countDifferences: countRows,
        waste: { count: wasteRows.length, rows: wasteRows },
      };
    },
  },
} satisfies { reports: FeedDef<'reports'> };
