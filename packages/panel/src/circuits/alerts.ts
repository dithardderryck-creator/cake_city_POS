import type { Alert, AlertKind, AlertSettings, CountDifference, Ingredient, Order, OrderLine, OutboxItem, Product, Quote, Role, StaffRequest, UsageReport, Combination } from '../domain';
import type { Registry } from '../intents';
import { DomainError } from '../intents';
import type { Clock, Ids, Store } from '../ports';
import { buildForecasts } from '../forecast';
import { daysBetween, todayLocal } from './dates';

export const ALERT_KINDS: AlertKind[] = ['low_stock', 'stockout', 'usage_waiting', 'order_not_started', 'quote_waiting', 'overdue_delivery', 'count_difference', 'request_waiting'];

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  low_stock: 'Low stock',
  stockout: 'Running out',
  usage_waiting: 'Usage waiting',
  order_not_started: 'Cake not started',
  quote_waiting: 'Price needed',
  overdue_delivery: 'Overdue order',
  count_difference: 'Count difference',
  request_waiting: 'Request waiting',
};

/** Defaults proposed in blueprint section 8 (A-11). The owner can change every one. */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  id: 'alerts',
  stockoutDays: 3,
  reorderDays: 7,
  usageWaitHours: 4,
  quoteWaitHours: 2,
  dueSoonDays: 2,
  countDifference: 3,
  urgentRequestMinutes: 15,
  requestWaitHours: 4,
  critical: { low_stock: false, stockout: true, usage_waiting: false, order_not_started: false, quote_waiting: false, overdue_delivery: false, count_difference: true, request_waiting: false },
};

export async function loadAlertSettings(store: Pick<Store, 'get'>): Promise<AlertSettings> {
  const saved = await store.get<AlertSettings>('settings', 'alerts');
  return saved ? { ...DEFAULT_ALERT_SETTINGS, ...saved, critical: { ...DEFAULT_ALERT_SETTINGS.critical, ...saved.critical } } : DEFAULT_ALERT_SETTINGS;
}

/** Alerts that report something that happened, rather than something still true. Acknowledging one closes it. */
const EVENT_KINDS: AlertKind[] = ['count_difference'];
const COUNT_WINDOW_MS = 24 * 3_600_000;
/** Alerts that were resolved this long ago are tidied away. */
export const RESOLVED_ALERT_TTL_MS = 30 * 24 * 3_600_000;

export interface DesiredAlert {
  dedupeKey: string;
  kind: AlertKind;
  title: string;
  body: string;
  to: Role[];
  screen: string;
  targetId?: string;
  /** Force this alert to be critical whatever the owner's settings say (an urgent request nobody took). */
  critical?: boolean;
}

const ACTIVE_LINE: OrderLine['status'][] = ['new', 'in_production', 'decorating', 'ready', 'out_for_delivery'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dueText = (date: string, today: string) => {
  const d = daysBetween(today, date);
  return d < -1 ? `${-d} days ago (${date})` : d === -1 ? `yesterday (${date})` : d === 0 ? `today (${date})` : d === 1 ? `tomorrow (${date})` : `in ${d} days (${date})`;
};

/** Everything that should be alerting right now, worked out from the data alone. Pure reading, no writes. */
export async function desiredAlerts(store: Store, now: Date, s: AlertSettings): Promise<DesiredAlert[]> {
  const out: DesiredAlert[] = [];
  const today = todayLocal(now);
  const nowMs = now.getTime();

  // Stock, from the forecast: bookings plus the kitchen's usual use.
  for (const f of await buildForecasts(store, now, { stockoutDays: s.stockoutDays, reorderDays: s.reorderDays })) {
    if (f.status === 'out') out.push({ dedupeKey: `stockout:${f.ingredientId}`, kind: 'stockout', title: `${f.name} is out of stock`, body: f.text, to: ['inventory', 'owner'], screen: 'forecast', targetId: f.ingredientId });
    else if (f.status === 'stockout_soon')
      out.push({
        dedupeKey: `stockout:${f.ingredientId}`,
        kind: 'stockout',
        title: `${f.name} will run out ${f.daysUntilOut === 0 ? 'today' : f.daysUntilOut === 1 ? 'tomorrow' : `in ${f.daysUntilOut} days`}`,
        body: f.text,
        to: ['inventory', 'owner'],
        screen: 'forecast',
        targetId: f.ingredientId,
      });
    else if (f.status === 'reorder_soon') out.push({ dedupeKey: `low_stock:${f.ingredientId}`, kind: 'low_stock', title: `${f.name} is running low`, body: f.text, to: ['inventory'], screen: 'forecast', targetId: f.ingredientId });
  }

  // Lines that are still in the shop: one query, then the orders they belong to.
  const lines = await store.find<OrderLine>('orderLines', { where: { status: ACTIVE_LINE } });
  const quotes = (await store.find<Quote>('quotes', { where: { status: ['sent', 'seen'] } })).filter((q) => nowMs - Date.parse(q.requestedAt) >= s.quoteWaitHours * 3_600_000);
  const reports = (await store.find<UsageReport>('usageReports', { where: { status: 'reported' } })).filter((r) => nowMs - Date.parse(r.reportedAt) >= s.usageWaitHours * 3_600_000);
  const counts = (await store.find<CountDifference>('countDifferences', { orderBy: { field: 'at', dir: 'desc' }, limit: 200 })).filter(
    (c) => nowMs - Date.parse(c.at) <= COUNT_WINDOW_MS && Math.abs(c.difference) >= s.countDifference,
  );
  const orderIds = [...new Set([...lines.map((l) => l.orderId), ...quotes.map((q) => q.orderId), ...reports.map((r) => r.orderId)])];
  const orders = orderIds.length ? await store.find<Order>('orders', { where: { id: orderIds } }) : [];
  const orderOf = (id: string) => orders.find((o) => o.id === id);

  for (const line of lines) {
    const order = orderOf(line.orderId);
    if (!order?.deliveryDate || line.status !== 'new' || !line.custom) continue;
    if (daysBetween(today, order.deliveryDate) > s.dueSoonDays) continue;
    const c = line.custom.spec;
    out.push({
      dedupeKey: `order_not_started:${line.id}`,
      kind: 'order_not_started',
      title: `Cake for ${order.customerName || 'a customer'} has not been started`,
      body: `Order ${order.number}: ${c.servings} servings, ${c.flavor}. Due ${dueText(order.deliveryDate, today)}.`,
      to: ['baker', 'owner'],
      screen: 'bake_queue',
      targetId: line.id,
    });
  }

  const overdue = new Map<string, number>();
  for (const line of lines) {
    const order = orderOf(line.orderId);
    if (order?.deliveryDate && order.deliveryDate < today) overdue.set(order.id, (overdue.get(order.id) ?? 0) + 1);
  }
  for (const [orderId, n] of overdue) {
    const order = orderOf(orderId)!;
    out.push({
      dedupeKey: `overdue_delivery:${orderId}`,
      kind: 'overdue_delivery',
      title: `Order ${order.number} for ${order.customerName || 'a customer'} is overdue`,
      body: `It was due ${dueText(order.deliveryDate!, today)}. ${plural(n, 'item is', 'items are')} not handed over yet.`,
      to: ['cashier', 'owner'],
      screen: 'orders',
      targetId: orderId,
    });
  }

  for (const q of quotes) {
    const order = orderOf(q.orderId);
    const hours = Math.floor((nowMs - Date.parse(q.requestedAt)) / 3_600_000);
    out.push({
      dedupeKey: `quote_waiting:${q.id}`,
      kind: 'quote_waiting',
      title: `A price is needed${order ? ` for order ${order.number}` : ''}`,
      body: `${q.requestedByName} asked ${plural(hours, 'hour', 'hours')} ago. The customer is waiting for a price.`,
      to: ['owner'],
      screen: 'quotes',
      targetId: q.id,
    });
  }

  for (const r of reports) {
    const order = orderOf(r.orderId);
    const hours = Math.floor((nowMs - Date.parse(r.reportedAt)) / 3_600_000);
    const base = { kind: 'usage_waiting' as const, screen: 'usage_inbox', targetId: r.id };
    const body = `${r.reportedByName} reported what was used${order ? ` for order ${order.number}` : ''} ${plural(hours, 'hour', 'hours')} ago. Stock has not changed until it is confirmed.`;
    out.push({ ...base, dedupeKey: `usage_waiting:${r.id}`, title: 'Usage is waiting to be confirmed', body, to: ['inventory'] });
    if (nowMs - Date.parse(r.reportedAt) >= 2 * s.usageWaitHours * 3_600_000)
      out.push({ ...base, dedupeKey: `usage_waiting_owner:${r.id}`, title: 'Usage has been waiting a long time', body, to: ['owner'] });
  }

  if (counts.length) {
    const [combos, products] = await Promise.all([store.list<Combination>('combinations'), store.list<Product>('products')]);
    for (const c of counts) {
      const name = products.find((p) => p.id === combos.find((x) => x.id === c.combinationId)?.productId)?.name ?? 'an item';
      out.push({
        dedupeKey: `count_difference:${c.id}`,
        kind: 'count_difference',
        title: `Count was off for ${name}`,
        body: `Expected ${c.expected}, counted ${c.counted} (${c.difference > 0 ? '+' : ''}${c.difference}).`,
        to: ['owner'],
        screen: 'orders',
        targetId: c.orderId,
      });
    }
  }

  // Staff requests nobody has taken. Urgent ones alert the people they are for at once and the owner after a short wait.
  const waiting = await store.find<StaffRequest>('staffRequests', { where: { status: ['sent', 'seen'] } });
  for (const r of waiting) {
    const mins = Math.floor((nowMs - Date.parse(r.createdAt)) / 60_000);
    const ownerAfter = r.urgent ? s.urgentRequestMinutes : 2 * s.requestWaitHours * 60;
    const targetAfter = r.urgent ? 0 : s.requestWaitHours * 60;
    const age = mins < 60 ? plural(mins, 'minute', 'minutes') : plural(Math.floor(mins / 60), 'hour', 'hours');
    const base = { kind: 'request_waiting' as const, screen: 'requests', targetId: r.id };
    const body = `${r.fromName} asked ${age} ago${r.link ? ` (${r.link})` : ''}. Nobody has taken it yet.`;
    if (r.audience !== 'owner' && r.audience !== 'it' && mins >= targetAfter)
      out.push({ ...base, dedupeKey: `request_waiting:${r.id}`, title: `${r.urgent ? 'Urgent: ' : ''}${r.title}`, body, to: [r.audience] });
    if (r.audience === 'owner' ? mins >= targetAfter : mins >= ownerAfter)
      out.push({
        ...base,
        dedupeKey: `request_waiting_owner:${r.id}`,
        title: r.audience === 'owner' ? `${r.urgent ? 'Urgent: ' : ''}${r.title}` : `Nobody has taken: ${r.title}`,
        body,
        to: ['owner'],
        critical: r.urgent ? true : undefined,
      });
  }
  return out;
}

export interface AlertEnv {
  store: Store;
  ids: Ids;
  clock: Clock;
}

export interface ReconcileResult {
  raised: Alert[];
  resolved: Alert[];
  changed: boolean;
}

/**
 * Brings the stored alerts in line with what is true now (BR-23).
 *  - A condition that is true and has no open alert: a new alert, and one notification request in the outbox (BR-24).
 *  - A condition that is true and has an open alert: the wording is refreshed; nobody is told again.
 *  - An open alert whose condition has stopped being true: resolved by the system.
 * Writes happen in the caller's transaction, so an alert and its notification request appear together or not at all.
 */
export async function reconcileAlerts(env: AlertEnv): Promise<ReconcileResult> {
  const { store, ids, clock } = env;
  const now = clock.now();
  const at = now.toISOString();
  const settings = await loadAlertSettings(store);
  const desired = await desiredAlerts(store, now, settings);
  const open = await store.find<Alert>('alerts', { where: { status: 'open' } });
  const raised: Alert[] = [];
  const resolved: Alert[] = [];
  const wanted = new Set<string>();

  for (const d of desired) {
    wanted.add(d.dedupeKey);
    const critical = !!d.critical || settings.critical[d.kind];
    const to = [...new Set<Role>(critical ? [...d.to, 'owner'] : d.to)];
    const severity = critical ? 'critical' : 'warning';
    const existing = open.find((a) => a.dedupeKey === d.dedupeKey);
    if (existing) {
      const same = existing.title === d.title && existing.body === d.body && existing.severity === severity && existing.to.join() === to.join() && existing.screen === d.screen && existing.targetId === d.targetId;
      if (!same) await store.put('alerts', { ...existing, title: d.title, body: d.body, severity, to, screen: d.screen, targetId: d.targetId, updatedAt: at });
      continue;
    }
    // Something that already happened is raised once only: if it was acknowledged, it stays closed.
    if (EVENT_KINDS.includes(d.kind) && (await store.find<Alert>('alerts', { where: { dedupeKey: d.dedupeKey } })).length > 0) continue;
    const alert: Alert = { id: ids.next('alt'), dedupeKey: d.dedupeKey, kind: d.kind, severity, title: d.title, body: d.body, to, screen: d.screen, targetId: d.targetId, status: 'open', createdAt: at, updatedAt: at, seen: {}, snoozed: {} };
    await store.put('alerts', alert);
    const notice: OutboxItem = { id: ids.next('out'), kind: 'notify', payload: { alertId: alert.id }, createdAt: at, attempts: 0, status: 'pending' };
    await store.put('outbox', notice);
    raised.push(alert);
  }

  for (const a of open) {
    if (wanted.has(a.dedupeKey)) continue;
    const done: Alert = { ...a, status: 'resolved', resolvedAt: at, resolvedBy: 'system', updatedAt: at };
    await store.put('alerts', done);
    resolved.push(done);
  }
  return { raised, resolved, changed: raised.length + resolved.length > 0 };
}

/** Who may see an alert: the people it is for, and always the owner. */
export const canSeeAlert = (a: Pick<Alert, 'to'>, role: Role) => role === 'owner' || a.to.includes(role);

const raisedEvents = (r: ReconcileResult) => [
  ...r.raised.map((a) => ({ type: 'AlertRaised', payload: { alertId: a.id, kind: a.kind, severity: a.severity, to: a.to } })),
  ...r.resolved.map((a) => ({ type: 'AlertResolved', payload: { alertId: a.id, kind: a.kind } })),
];
export { raisedEvents as alertEvents };

const HOURS = { min: 1, max: 72 };

export const alertIntents = {
  'alerts/mark_seen': {
    circuit: 'Alerts',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    validate: async (p, ctx) => {
      if (p.alertIds.length === 0) return ['Choose an alert.'];
      for (const id of p.alertIds) {
        const a = await ctx.store.get<Alert>('alerts', id);
        if (!a || !canSeeAlert(a, ctx.session!.role)) return ['That alert is not available.'];
      }
      return [];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!.userId;
      let n = 0;
      for (const id of p.alertIds) {
        const a = (await ctx.store.get<Alert>('alerts', id))!;
        if (a.seen[me]) continue;
        await ctx.store.put('alerts', { ...a, seen: { ...a.seen, [me]: ctx.now() } });
        n++;
      }
      return { summary: n ? `Saw ${plural(n, 'alert', 'alerts')}` : 'Saw alerts (nothing new)', events: n ? [{ type: 'AlertsSeen', payload: { count: n } }] : [] };
    },
  },

  'alerts/acknowledge': {
    circuit: 'Alerts',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    validate: async (p, ctx) => {
      const a = await ctx.store.get<Alert>('alerts', p.alertId);
      if (!a || !canSeeAlert(a, ctx.session!.role)) return ['That alert is not available.'];
      if (a.status === 'resolved') return ['That alert has already cleared.'];
      if (a.acknowledgedBy) return [`${a.acknowledgedBy.name} has already taken this.`];
      return [];
    },
    handle: async (p, ctx) => {
      const a = (await ctx.store.get<Alert>('alerts', p.alertId))!;
      const s = ctx.session!;
      const at = ctx.now();
      const closes = EVENT_KINDS.includes(a.kind);
      await ctx.store.put('alerts', {
        ...a,
        acknowledgedBy: { userId: s.userId, name: s.name, at },
        seen: { ...a.seen, [s.userId]: a.seen[s.userId] ?? at },
        ...(closes ? { status: 'resolved' as const, resolvedAt: at, resolvedBy: 'acknowledged' as const, updatedAt: at } : { updatedAt: at }),
      });
      return { summary: `Took the alert: ${a.title}`, target: a.id, events: [{ type: 'AlertAcknowledged', payload: { alertId: a.id } }] };
    },
  },

  'alerts/snooze': {
    circuit: 'Alerts',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    validate: async (p, ctx) => {
      const a = await ctx.store.get<Alert>('alerts', p.alertId);
      if (!a || !canSeeAlert(a, ctx.session!.role)) return ['That alert is not available.'];
      if (a.status === 'resolved') return ['That alert has already cleared.'];
      if (!Number.isInteger(p.hours) || p.hours < HOURS.min || p.hours > HOURS.max) return [`Snooze for ${HOURS.min} to ${HOURS.max} hours.`];
      return [];
    },
    handle: async (p, ctx) => {
      const a = (await ctx.store.get<Alert>('alerts', p.alertId))!;
      const until = new Date(ctx.clock.now().getTime() + p.hours * 3_600_000).toISOString();
      await ctx.store.put('alerts', { ...a, snoozed: { ...a.snoozed, [ctx.session!.userId]: until } });
      return { summary: `Snoozed an alert for ${plural(p.hours, 'hour', 'hours')}`, target: a.id };
    },
  },

  'alerts/configure': {
    circuit: 'Alerts',
    roles: ['owner'],
    validate: async (p) => {
      const errors: string[] = [];
      const whole = (v: number | undefined, label: string, min: number, max: number) => {
        if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) errors.push(`${label} must be a whole number from ${min} to ${max}.`);
      };
      whole(p.stockoutDays, 'Days before running out', 0, 30);
      whole(p.reorderDays, 'Days before reorder level', 0, 30);
      whole(p.usageWaitHours, 'Hours usage may wait', 1, 72);
      whole(p.quoteWaitHours, 'Hours a price request may wait', 1, 72);
      whole(p.dueSoonDays, 'Days before a cake is due', 0, 14);
      whole(p.countDifference, 'Count difference', 1, 1000);
      whole(p.urgentRequestMinutes, 'Minutes before an urgent request is escalated', 1, 240);
      whole(p.requestWaitHours, 'Hours a request may wait', 1, 72);
      if (Object.values(p).every((v) => v === undefined)) errors.push('Choose a setting to change.');
      for (const k of Object.keys(p.critical ?? {})) if (!ALERT_KINDS.includes(k as AlertKind)) errors.push(`"${k}" is not an alert type.`);
      return errors;
    },
    handle: async (p, ctx) => {
      const cur = await loadAlertSettings(ctx.store);
      const next: AlertSettings = {
        ...cur,
        stockoutDays: p.stockoutDays ?? cur.stockoutDays,
        reorderDays: p.reorderDays ?? cur.reorderDays,
        usageWaitHours: p.usageWaitHours ?? cur.usageWaitHours,
        quoteWaitHours: p.quoteWaitHours ?? cur.quoteWaitHours,
        dueSoonDays: p.dueSoonDays ?? cur.dueSoonDays,
        countDifference: p.countDifference ?? cur.countDifference,
        urgentRequestMinutes: p.urgentRequestMinutes ?? cur.urgentRequestMinutes,
        requestWaitHours: p.requestWaitHours ?? cur.requestWaitHours,
        critical: { ...cur.critical, ...(p.critical ?? {}) },
      };
      await ctx.store.put('settings', next);
      return { summary: 'Changed the alert settings', target: 'alerts', events: [{ type: 'AlertSettingsChanged' }] };
    },
  },
} satisfies Partial<Registry>;

export { DomainError };
