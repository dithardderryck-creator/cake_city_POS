import type { Alert, Delivery, DeliveryChannel, MessageLevel, NotifyPayload, OutboxItem, PushSubscriptionRecord, Staff } from '../domain';
import type { Registry } from '../intents';
import type { Clock, Ids, PushPayload, SendResult, Store, Terminals } from '../ports';
import { sha256Hex } from '../ports';

/** Waits between tries, in seconds. After the last one the delivery is marked failed and shows in the log. */
export const RETRY_SECONDS = [60, 120, 300, 900, 3600, 10800];
export const MAX_ATTEMPTS = RETRY_SECONDS.length + 1;
/** A send that has been "in flight" this long is assumed lost (the server stopped) and may be tried again. */
const STALE_IN_FLIGHT_MS = 5 * 60_000;
export const NOTIFY_ITEM_TTL_MS = 14 * 24 * 3_600_000;
const TEST_COOLDOWN_MS = 60_000;

/** International format only, because a local number cannot be guessed safely. Tidies spaces, dashes and brackets. */
export function normalisePhone(input: string): string | null {
  const t = input.trim().replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
}

const wants = (level: MessageLevel, severity: Alert['severity'] | 'test') => level === 'all' || severity === 'test' || (level === 'critical' && severity === 'critical');

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export interface Attempt {
  itemId: string;
  deliveryId: string;
  channel: DeliveryChannel;
  userId: string;
  to: string;
  subscription?: PushSubscriptionRecord;
  text: string;
  push: PushPayload;
}

export interface NotifyEnv {
  store: Store;
  ids: Ids;
  clock: Clock;
  terminals: Terminals;
}

const asPayload = (item: OutboxItem) => item.payload as unknown as NotifyPayload;
const withPayload = (item: OutboxItem, payload: NotifyPayload, status?: OutboxItem['status']): OutboxItem => ({ ...item, payload: payload as unknown as Record<string, unknown>, ...(status ? { status } : {}) });

/** Who should be told about one alert, on which channels. Nobody is told twice on the same channel. */
async function expand(env: NotifyEnv, payload: NotifyPayload, alert: Alert | undefined, at: string): Promise<{ deliveries: Delivery[]; skippedNote?: string }> {
  const { store, ids, terminals } = env;
  const staff = (await store.list<Staff>('staff')).filter((s) => s.active);
  const severity = payload.test ? 'test' : alert!.severity;
  const people = payload.test ? staff.filter((s) => s.id === payload.test!.userId) : staff.filter((s) => alert!.to.includes(s.role));
  const subs = await store.list<PushSubscriptionRecord>('pushSubscriptions');
  const providerChannels = new Set(terminals.messages?.channels() ?? []);
  const out: Delivery[] = [];
  const add = (p: Staff, channel: DeliveryChannel, target: string, available: boolean, unavailable: string) =>
    out.push({ id: ids.next('dlv'), userId: p.id, userName: p.name, channel, target, status: available ? 'pending' : 'skipped', attempts: 0, ...(available ? {} : { lastError: unavailable, doneAt: at }) });
  for (const p of people) {
    for (const sub of subs.filter((x) => x.userId === p.id)) add(p, 'push', sub.id, !!terminals.push, 'Push is not set up on this server.');
    const c = p.contact;
    if (c?.phone) {
      if (wants(c.sms, severity)) add(p, 'sms', c.phone, providerChannels.has('sms'), 'No SMS provider is set up on this server.');
      if (wants(c.whatsapp, severity)) add(p, 'whatsapp', c.phone, providerChannels.has('whatsapp'), 'No WhatsApp provider is set up on this server.');
    }
  }
  return { deliveries: out, skippedNote: out.length ? undefined : 'Nobody has a phone or device set up for this.' };
}

const finish = (deliveries: Delivery[]): OutboxItem['status'] | null => {
  if (deliveries.some((d) => d.status === 'pending')) return null;
  return deliveries.some((d) => d.status === 'sent') || !deliveries.some((d) => d.status === 'failed') ? 'sent' : 'failed';
};

/**
 * Phase 1 of a delivery run, inside a transaction. Works out who gets what for new alerts, drops messages that no longer
 * make sense (the problem cleared, or someone has already taken it), and returns the sends that are due now.
 * Nothing here talks to the network, so the shop is never held up waiting on a provider.
 */
export async function planDue(env: NotifyEnv): Promise<Attempt[]> {
  const { store, clock } = env;
  const nowMs = clock.now().getTime();
  const at = clock.now().toISOString();
  const attempts: Attempt[] = [];
  const items = await store.find<OutboxItem>('outbox', { where: { status: 'pending' } });
  for (const item of items.filter((i) => i.kind === 'notify').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    let payload = asPayload(item);
    const alert = payload.alertId ? await store.get<Alert>('alerts', payload.alertId) : undefined;
    if (!payload.test && !alert) {
      await store.put('outbox', withPayload(item, { ...payload, note: 'The alert no longer exists.' }, 'sent'));
      continue;
    }
    if (!payload.deliveries) {
      const { deliveries, skippedNote } = await expand(env, payload, alert, at);
      payload = { ...payload, deliveries, note: skippedNote };
    }
    const due: Delivery[] = [];
    for (const d of payload.deliveries!) {
      if (d.status !== 'pending') {
        due.push(d);
        continue;
      }
      if (alert?.status === 'resolved') {
        due.push({ ...d, status: 'skipped', lastError: 'The problem cleared before this was sent.', doneAt: at, inFlightAt: undefined });
        continue;
      }
      if (alert?.acknowledgedBy && d.attempts === 0) {
        due.push({ ...d, status: 'skipped', lastError: `${alert.acknowledgedBy.name} had already taken it.`, doneAt: at });
        continue;
      }
      const waiting = (d.nextAt && Date.parse(d.nextAt) > nowMs) || (d.inFlightAt && nowMs - Date.parse(d.inFlightAt) < STALE_IN_FLIGHT_MS);
      if (waiting) {
        due.push(d);
        continue;
      }
      const sub = d.channel === 'push' ? await store.get<PushSubscriptionRecord>('pushSubscriptions', d.target) : undefined;
      if (d.channel === 'push' && !sub) {
        due.push({ ...d, status: 'skipped', lastError: 'That device is no longer subscribed.', doneAt: at, inFlightAt: undefined });
        continue;
      }
      const title = alert ? alert.title : 'Test message';
      const body = alert ? alert.body : `This is a test for ${d.userName}. If you can read it, alerts will reach you here.`;
      due.push({ ...d, inFlightAt: at });
      attempts.push({
        itemId: item.id,
        deliveryId: d.id,
        channel: d.channel,
        userId: d.userId,
        to: d.target,
        subscription: sub,
        text: clip(`Cake POS: ${title}. ${body}`, 300),
        push: { title: clip(title, 80), body: clip(body, 200), tag: alert?.id ?? `test-${d.userId}`, severity: alert?.severity ?? 'test', screen: alert?.screen ?? 'alerts', alertId: alert?.id },
      });
    }
    const status = finish(due);
    await store.put('outbox', withPayload(item, { ...payload, deliveries: due }, status ?? undefined));
  }
  return attempts;
}

/** Phase 3: write down what happened. Failed sends are tried again later, up to a limit, with growing waits. */
export async function recordResults(env: NotifyEnv, results: Array<{ attempt: Attempt; result: SendResult }>): Promise<{ sent: number; failed: number; retrying: number }> {
  const { store, clock } = env;
  const nowMs = clock.now().getTime();
  const at = clock.now().toISOString();
  const tally = { sent: 0, failed: 0, retrying: 0 };
  const byItem = new Map<string, typeof results>();
  for (const r of results) byItem.set(r.attempt.itemId, [...(byItem.get(r.attempt.itemId) ?? []), r]);
  for (const [itemId, rs] of byItem) {
    const item = await store.get<OutboxItem>('outbox', itemId);
    if (!item) continue;
    const payload = asPayload(item);
    const deliveries = (payload.deliveries ?? []).map((d): Delivery => {
      const r = rs.find((x) => x.attempt.deliveryId === d.id);
      if (!r) return d;
      const attempts = d.attempts + 1;
      if (r.result.ok) {
        tally.sent++;
        return { ...d, status: 'sent', attempts, doneAt: at, inFlightAt: undefined, lastError: undefined, nextAt: undefined };
      }
      if (r.result.gone) return { ...d, status: 'skipped', attempts, doneAt: at, inFlightAt: undefined, lastError: 'The device has unsubscribed.' };
      if (!r.result.retry || attempts >= MAX_ATTEMPTS) {
        tally.failed++;
        return { ...d, status: 'failed', attempts, doneAt: at, inFlightAt: undefined, lastError: r.result.error };
      }
      tally.retrying++;
      return { ...d, attempts, inFlightAt: undefined, lastError: r.result.error, nextAt: new Date(nowMs + RETRY_SECONDS[attempts - 1]! * 1000).toISOString() };
    });
    for (const r of rs) if (!r.result.ok && r.result.gone && r.attempt.subscription) await store.delete('pushSubscriptions', r.attempt.subscription.id);
    await store.put('outbox', withPayload(item, { ...payload, deliveries }, finish(deliveries) ?? undefined));
  }
  return tally;
}

export const notifyIntents = {
  'staff/set_contact': {
    circuit: 'Notify',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    validate: async (p, ctx) => {
      const me = ctx.session!;
      const person = await ctx.store.get<Staff>('staff', p.userId);
      if (!person) return ['That person does not exist.'];
      if (me.role !== 'owner' && me.userId !== p.userId) return ['You can only change your own contact details.'];
      const errors: string[] = [];
      if (typeof p.phone === 'string' && p.phone.trim() && !normalisePhone(p.phone)) errors.push('Write the number with the country code, like +255712345678.');
      const phone = p.phone === undefined ? person.contact?.phone : p.phone === null || !p.phone.trim() ? undefined : normalisePhone(p.phone);
      // Removing the number turns the levels off by itself. Only a level asked for with no number is a mistake.
      if (!phone && ((p.sms ?? 'off') !== 'off' || (p.whatsapp ?? 'off') !== 'off')) errors.push('Add a phone number before choosing text messages or WhatsApp.');
      return errors;
    },
    handle: async (p, ctx) => {
      const person = (await ctx.store.get<Staff>('staff', p.userId))!;
      const cur = person.contact ?? { sms: 'off' as MessageLevel, whatsapp: 'off' as MessageLevel };
      const phone = p.phone === undefined ? cur.phone : p.phone === null || !p.phone.trim() ? undefined : normalisePhone(p.phone)!;
      // A first phone number turns on critical text messages, so the owner is reachable without extra steps.
      const firstNumber = !cur.phone && phone !== undefined;
      const contact = {
        phone,
        sms: phone ? (p.sms ?? (firstNumber && p.whatsapp === undefined ? 'critical' : cur.sms)) : ('off' as MessageLevel),
        whatsapp: phone ? (p.whatsapp ?? cur.whatsapp) : ('off' as MessageLevel),
      };
      await ctx.store.put('staff', { ...person, contact });
      return {
        summary: `Changed contact details for ${person.name}`,
        target: person.id,
        events: [{ type: 'ContactChanged', payload: { userId: person.id } }],
      };
    },
  },

  'push/subscribe': {
    circuit: 'Notify',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    validate: (p) => (/^https:\/\//.test(p.endpoint) ? [] : ['That device sent an address that is not secure.']),
    handle: async (p, ctx) => {
      const id = `psub_${(await sha256Hex(p.endpoint)).slice(0, 24)}`;
      const record: PushSubscriptionRecord = { id, userId: ctx.session!.userId, endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth, userAgent: p.userAgent?.slice(0, 200), createdAt: ctx.now() };
      await ctx.store.put('pushSubscriptions', record);
      return { summary: 'Turned on notifications on a device', target: id };
    },
  },

  'push/unsubscribe': {
    circuit: 'Notify',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    handle: async (p, ctx) => {
      const id = `psub_${(await sha256Hex(p.endpoint)).slice(0, 24)}`;
      const sub = await ctx.store.get<PushSubscriptionRecord>('pushSubscriptions', id);
      // Only your own devices. Anything else looks the same as "nothing to do".
      if (sub && sub.userId === ctx.session!.userId) await ctx.store.delete('pushSubscriptions', id);
      return { summary: 'Turned off notifications on a device', target: id };
    },
  },

  'notify/send_test': {
    circuit: 'Notify',
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    validate: async (_p, ctx) => {
      const me = ctx.session!.userId;
      const recent = (await ctx.store.find<OutboxItem>('outbox', { where: { status: 'pending' } })).concat(await ctx.store.find<OutboxItem>('outbox', { where: { status: 'sent' } }));
      const nowMs = ctx.clock.now().getTime();
      return recent.some((i) => i.kind === 'notify' && asPayload(i).test?.userId === me && nowMs - Date.parse(i.createdAt) < TEST_COOLDOWN_MS)
        ? ['A test was just sent. Wait a minute before sending another.']
        : [];
    },
    handle: async (_p, ctx) => {
      const item: OutboxItem = { id: ctx.ids.next('out'), kind: 'notify', payload: { test: { userId: ctx.session!.userId } } as unknown as Record<string, unknown>, createdAt: ctx.now(), attempts: 0, status: 'pending' };
      await ctx.store.put('outbox', item);
      return { summary: 'Sent myself a test notification', target: item.id, skipSync: true };
    },
  },
} satisfies Partial<Registry>;
