import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryStore,
  createPanel,
  seedDemo,
  DEMO_STAFF,
  type DispatchResult,
  type MessageTerminal,
  type Panel,
  type PushPayload,
  type PushTerminal,
  type SendResult,
  type Staff,
  type Store,
  type Terminals,
} from './index';
import type { Alert, OutboxItem, PushSubscriptionRecord } from './domain';
import { planDue } from './circuits/notify';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
let errors: unknown[];

type Role = 'owner' | 'cashier' | 'baker' | 'inventory';
const sid: Record<string, string> = {};
const staffOf = async (role: Role) => (await store.list<Staff>('staff')).find((s) => s.role === role)!;
async function signIn(role: Role) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const r = await panel.dispatch('auth/sign_in', { userId: (await staffOf(role)).id, pin });
  if (!r.ok) throw new Error('sign in failed');
  sid[role] = (r.data as { sessionId: string }).sessionId;
}
const relog = async () => {
  for (const r of ['owner', 'cashier', 'baker', 'inventory'] as const) await signIn(r);
};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : `${r.error.code}: ${r.error.messages.join(' ')}`);
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);

// ---- fake providers ----
const texts: Array<{ channel: string; to: string; text: string }> = [];
const pushes: Array<{ endpoint: string; payload: PushPayload }> = [];
let textResult: (m: { channel: 'sms' | 'whatsapp'; to: string; text: string }) => Promise<SendResult>;
let pushResult: (endpoint: string) => Promise<SendResult>;
let providerChannels: Array<'sms' | 'whatsapp'>;
const messages: MessageTerminal = {
  channels: () => providerChannels,
  send: async (m) => {
    texts.push(m);
    return textResult(m);
  },
};
const push: PushTerminal = {
  publicKey: 'PUBLIC-KEY',
  send: async (sub, payload) => {
    pushes.push({ endpoint: sub.endpoint, payload });
    return pushResult(sub.endpoint);
  },
};
let terminals: Terminals;

const HOUR = 3_600_000;
const MIN = 60_000;
const alerts = () => store.list<Alert>('alerts');
const items = async () => (await store.list<OutboxItem>('outbox')).filter((o) => o.kind === 'notify');
const log = async () => {
  const r = await panel.feed('notification_log', {}, sid.owner);
  if (!r.ok) throw new Error('log');
  return r.data;
};

const PHONE = '+255712345678';
async function setPhone(role: Role, phone = PHONE, extra: object = {}) {
  ok(await send('owner', 'staff/set_contact', { userId: (await staffOf(role)).id, phone, ...extra }));
}
const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, p256dh: `key${n}`, auth: `auth${n}` });
/** Makes Inventory run low so an alert for inventory (and, if critical, the owner) is raised. */
async function lowStock(out = false) {
  const made = ok<{ ingredientId: string }>(await send('inventory', 'inventory/create_ingredient', { name: 'Flour', unit: 'kg', openingStock: 5, reorderLevel: 1 }));
  ok(await send('inventory', 'inventory/count', { ingredientId: made.ingredientId, counted: out ? 0 : 0.5 }));
  return made.ingredientId;
}

beforeEach(async () => {
  vi.useRealTimers();
  t = new Date(2026, 9, 4, 8, 0, 0).getTime();
  errors = [];
  texts.length = 0;
  pushes.length = 0;
  providerChannels = ['sms', 'whatsapp'];
  textResult = async () => ({ ok: true });
  pushResult = async () => ({ ok: true });
  terminals = { messages, push };
  store = createMemoryStore();
  panel = createPanel({ store, clock, terminals, onError: (e) => errors.push(e) });
  await seedDemo(store, panel);
  await relog();
});
afterEach(() => vi.useRealTimers());

describe('where alerts reach a person', () => {
  it('takes an international number, tidies it, and turns on critical texts for a first number', async () => {
    await setPhone('owner', '+255 712-345 678');
    const s = await panel.feed('notification_setup', {}, sid.owner);
    expect(s.ok && s.data.me).toMatchObject({ phone: PHONE, sms: 'critical', whatsapp: 'off' });
    const list = await panel.feed('staff_list', {}, sid.owner);
    expect(list.ok && list.data.find((x) => x.role === 'owner')!.contact).toEqual({ phone: PHONE, sms: 'critical', whatsapp: 'off' });
  });

  it('refuses numbers it cannot be sure of, and levels without a number', async () => {
    const id = (await staffOf('owner')).id;
    expect(errOf(await send('owner', 'staff/set_contact', { userId: id, phone: '0712 345 678' }))).toMatch(/country code/);
    expect(errOf(await send('owner', 'staff/set_contact', { userId: id, phone: '+12' }))).toMatch(/country code/);
    expect(errOf(await send('owner', 'staff/set_contact', { userId: id, sms: 'all' }))).toMatch(/Add a phone number/);
    expect(errOf(await send('owner', 'staff/set_contact', { userId: 'ghost', phone: PHONE }))).toMatch(/does not exist/);
  });

  it('lets the owner change anyone but everyone else only themselves, and removing the number turns messages off', async () => {
    const baker = await staffOf('baker');
    expect(errOf(await send('cashier', 'staff/set_contact', { userId: baker.id, phone: PHONE }))).toMatch(/only change your own/);
    ok(await send('baker', 'staff/set_contact', { userId: baker.id, phone: PHONE, sms: 'all', whatsapp: 'critical' }));
    ok(await send('baker', 'staff/set_contact', { userId: baker.id, phone: null }));
    const s = await panel.feed('notification_setup', {}, sid.baker);
    expect(s.ok && s.data.me).toMatchObject({ phone: null, sms: 'off', whatsapp: 'off' });
  });

  it('registers a device for the person who sent it, secure addresses only, and lets only that person remove it', async () => {
    expect(errOf(await send('baker', 'push/subscribe', { ...sub(1), endpoint: 'http://insecure.example/1' }))).toMatch(/not secure/);
    ok(await send('baker', 'push/subscribe', sub(1)));
    ok(await send('baker', 'push/subscribe', sub(1))); // the same device twice is one device
    expect(await store.list('pushSubscriptions')).toHaveLength(1);
    ok(await send('cashier', 'push/unsubscribe', { endpoint: sub(1).endpoint })); // not theirs: nothing happens
    expect(await store.list('pushSubscriptions')).toHaveLength(1);
    const s = await panel.feed('notification_setup', {}, sid.baker);
    expect(s.ok && s.data.push).toEqual({ publicKey: 'PUBLIC-KEY', endpoints: [sub(1).endpoint] });
    expect((await panel.feed('notification_setup', {}, sid.cashier)).ok && (await panel.feed('notification_setup', {}, sid.cashier)).ok).toBe(true);
    ok(await send('baker', 'push/unsubscribe', { endpoint: sub(1).endpoint }));
    expect(await store.list('pushSubscriptions')).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends a critical alert to the owner by text once, and to Inventory’s phone by push', async () => {
    await setPhone('owner');
    ok(await send('inventory', 'push/subscribe', sub(7)));
    await lowStock(true); // out of stock: critical, for Inventory and the owner
    expect(await panel.deliver()).toEqual({ sent: 2, failed: 0, retrying: 0 });
    expect(texts).toEqual([{ channel: 'sms', to: PHONE, text: expect.stringMatching(/^Cake POS: Flour is out of stock\. /) }]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ endpoint: sub(7).endpoint, payload: { title: 'Flour is out of stock', severity: 'critical', screen: 'forecast', tag: (await alerts())[0]!.id } });
    // BR-24: nothing is sent again for the same open alert.
    expect(await panel.deliver()).toEqual({ sent: 0, failed: 0, retrying: 0 });
    await panel.tick();
    await panel.deliver();
    expect(texts).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect((await items())[0]!.status).toBe('sent');
  });

  it('keeps ordinary alerts to push unless the person asked for every text', async () => {
    await setPhone('inventory'); // first number: critical only
    ok(await send('inventory', 'push/subscribe', sub(2)));
    await lowStock(); // a warning
    await panel.deliver();
    expect(texts).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload.severity).toBe('warning');
  });

  it('sends every alert by the channel a person chose, and an owner who asked for none gets none', async () => {
    await setPhone('inventory', PHONE, { sms: 'off', whatsapp: 'all' });
    await setPhone('owner', '+255700000001', { sms: 'off', whatsapp: 'off' });
    await lowStock(); // warning for Inventory
    await panel.deliver();
    expect(texts).toEqual([{ channel: 'whatsapp', to: PHONE, text: expect.stringContaining('Flour is running low') }]);
  });

  it('sends nothing for a problem that cleared before the message went out', async () => {
    await setPhone('owner');
    const flour = await lowStock(true);
    ok(await send('inventory', 'inventory/receive', { ingredientId: flour, qty: 10 }));
    expect(await panel.deliver()).toEqual({ sent: 0, failed: 0, retrying: 0 });
    expect(texts).toEqual([]);
    const l = await log();
    expect(l[0]!.deliveries[0]).toMatchObject({ status: 'skipped', error: 'The problem cleared before this was sent.' });
  });

  it('sends nothing more once somebody has taken the alert', async () => {
    await setPhone('owner');
    ok(await send('inventory', 'push/subscribe', sub(3)));
    await lowStock(true);
    const a = (await alerts())[0]!;
    ok(await send('inventory', 'alerts/acknowledge', { alertId: a.id }));
    await panel.deliver();
    expect(texts).toEqual([]);
    expect(pushes).toEqual([]);
    expect((await log())[0]!.deliveries.every((d) => d.status === 'skipped' && /had already taken it/.test(d.error ?? ''))).toBe(true);
  });

  it('says so, instead of failing quietly, when nothing is set up', async () => {
    terminals.messages = undefined;
    terminals.push = undefined;
    await setPhone('owner');
    ok(await send('inventory', 'push/subscribe', sub(4)));
    await lowStock(true);
    await panel.deliver();
    const l = await log();
    expect(l[0]!.status).toBe('sent'); // nothing is left to try
    expect(l[0]!.deliveries.map((d) => [d.channel, d.status, d.error])).toEqual(
      expect.arrayContaining([
        ['sms', 'skipped', 'No SMS provider is set up on this server.'],
        ['push', 'skipped', 'Push is not set up on this server.'],
      ]),
    );
    const s = await panel.feed('notification_setup', {}, sid.owner);
    expect(s.ok && s.data.notes).toEqual(expect.arrayContaining([expect.stringMatching(/Phone notifications are not set up/), expect.stringMatching(/Text messages are not set up/)]));
  });

  it('records that nobody could be told when nobody has a phone set up', async () => {
    await lowStock(true);
    await panel.deliver();
    expect((await log())[0]).toMatchObject({ status: 'sent', note: 'Nobody has a phone or device set up for this.', deliveries: [] });
  });

  it('warns a person who has both SMS and WhatsApp on that they get each alert twice', async () => {
    await setPhone('owner', PHONE, { sms: 'all', whatsapp: 'all' });
    const s = await panel.feed('notification_setup', {}, sid.owner);
    expect(s.ok && s.data.notes).toContain('You have both SMS and WhatsApp on, so you will get each alert twice.');
  });
});

describe('when sending goes wrong', () => {
  it('tries again later with growing waits, then succeeds', async () => {
    await setPhone('owner');
    let n = 0;
    textResult = async () => (++n < 3 ? { ok: false, retry: true, error: 'Provider is busy.' } : { ok: true });
    await lowStock(true);
    expect(await panel.deliver()).toMatchObject({ sent: 0, retrying: 1 });
    expect(await panel.deliver()).toEqual({ sent: 0, failed: 0, retrying: 0 }); // too soon: waits a minute
    expect(texts).toHaveLength(1);
    t += 61_000;
    expect(await panel.deliver()).toMatchObject({ retrying: 1 });
    const d = (await log())[0]!.deliveries.find((x) => x.channel === 'sms')!;
    expect(d).toMatchObject({ status: 'pending', attempts: 2, error: 'Provider is busy.' });
    expect(Date.parse(d.nextAt!) - t).toBe(120_000); // 1 minute, then 2
    t += 121_000;
    expect(await panel.deliver()).toMatchObject({ sent: 1 });
    expect(texts).toHaveLength(3);
    expect((await log())[0]).toMatchObject({ status: 'sent' });
  });

  it('gives up after the last try and shows it as failed, without ever blocking', async () => {
    await setPhone('owner');
    textResult = async () => ({ ok: false, retry: true, error: 'Network down.' });
    await lowStock(true);
    for (let i = 0; i < 12; i++) {
      await panel.deliver();
      t += 4 * HOUR;
    }
    expect(texts).toHaveLength(7);
    await relog();
    const l = (await log())[0]!;
    expect(l.status).toBe('failed');
    expect(l.deliveries.find((d) => d.channel === 'sms')).toMatchObject({ status: 'failed', attempts: 7, error: 'Network down.' });
  });

  it('does not retry what retrying cannot fix', async () => {
    await setPhone('owner');
    textResult = async () => ({ ok: false, retry: false, error: 'That number is not valid.' });
    await lowStock(true);
    expect(await panel.deliver()).toEqual({ sent: 0, failed: 1, retrying: 0 });
    t += 10 * HOUR;
    await panel.deliver();
    expect(texts).toHaveLength(1);
  });

  it('forgets a phone that has unsubscribed', async () => {
    ok(await send('inventory', 'push/subscribe', sub(5)));
    ok(await send('inventory', 'push/subscribe', sub(6)));
    pushResult = async (endpoint) => (endpoint === sub(5).endpoint ? { ok: false, retry: false, gone: true, error: 'gone' } : { ok: true });
    await lowStock();
    await panel.deliver();
    expect((await store.list<PushSubscriptionRecord>('pushSubscriptions')).map((s) => s.endpoint)).toEqual([sub(6).endpoint]);
    const ds = (await log())[0]!.deliveries;
    expect(ds.map((d) => d.status).sort()).toEqual(['sent', 'skipped']);
  });

  it('treats a provider that throws as a retry, not a crash', async () => {
    await setPhone('owner');
    textResult = async () => {
      throw new Error('socket hang up');
    };
    await lowStock(true);
    expect(await panel.deliver()).toMatchObject({ retrying: 1 });
    expect((await log())[0]!.deliveries.find((d) => d.channel === 'sms')!.error).toBe('socket hang up');
    expect(errors).toEqual([]);
  });

  it('never lets a provider that hangs hold up the shop, and gives up on it after a timeout', async () => {
    await setPhone('owner');
    let release!: (r: SendResult) => void;
    textResult = () => new Promise<SendResult>((resolve) => (release = resolve));
    await lowStock(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = panel.deliver();
    await vi.advanceTimersByTimeAsync(10); // the send is under way and has not answered
    // The shop carries on: a sale is not waiting behind the provider.
    const during = await send('cashier', 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
    expect(during.ok).toBe(true);
    // Two runs at once never send the same message twice.
    expect(await panel.deliver()).toEqual({ sent: 0, failed: 0, retrying: 0 });
    expect(texts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(26_000);
    expect(await running).toMatchObject({ retrying: 1 });
    release({ ok: true }); // a late answer changes nothing
    vi.useRealTimers();
    expect((await log())[0]!.deliveries.find((d) => d.channel === 'sms')).toMatchObject({ status: 'pending', error: 'The provider did not answer in time.' });
  });

  it('does not resend a message that is already out, but does if the server stopped mid-send', async () => {
    await setPhone('owner');
    await lowStock(true);
    const env = { store, ids: { next: (p: string) => `${p}_x${Math.random().toString(36).slice(2, 8)}` }, clock, terminals };
    expect(await planDue(env)).toHaveLength(1);
    expect(await planDue(env)).toHaveLength(0); // still out
    t += 6 * MIN; // the server must have stopped; the result was never written down
    expect(await planDue(env)).toHaveLength(1);
  });
});

describe('test messages', () => {
  it('sends a test to the person who asked, on every channel they have, at most once a minute', async () => {
    await setPhone('baker', PHONE, { sms: 'critical', whatsapp: 'critical' });
    ok(await send('baker', 'push/subscribe', sub(9)));
    ok(await send('baker', 'notify/send_test', {}));
    expect(await panel.deliver()).toMatchObject({ sent: 3 });
    expect(texts.map((m) => m.channel).sort()).toEqual(['sms', 'whatsapp']);
    expect(texts[0]!.text).toMatch(/This is a test for .*Neema/);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload).toMatchObject({ severity: 'test', title: 'Test message' });
    expect(texts.every((m) => m.to === PHONE)).toBe(true);
    expect(errOf(await send('baker', 'notify/send_test', {}))).toMatch(/Wait a minute/);
    t += 61_000;
    await relog();
    ok(await send('baker', 'notify/send_test', {}));
    expect((await log()).filter((x) => x.kind === 'test')).toHaveLength(2);
  });

  it('only ever reaches the person who sent it', async () => {
    await setPhone('owner');
    ok(await send('inventory', 'push/subscribe', sub(1)));
    ok(await send('inventory', 'notify/send_test', {}));
    await panel.deliver();
    expect(texts).toEqual([]);
    expect(pushes).toHaveLength(1);
  });
});

describe('the delivery log and housekeeping', () => {
  it('is for the owner and IT only', async () => {
    expect((await panel.feed('notification_log', {}, sid.owner)).ok).toBe(true);
    expect((await panel.feed('notification_log', {}, sid.baker)).ok).toBe(false);
    expect((await panel.feed('notification_log', {}, sid.cashier)).ok).toBe(false);
  });

  it('tidies away old finished notifications but never a pending one', async () => {
    await setPhone('owner');
    await lowStock(true);
    await panel.deliver();
    ok(await send('owner', 'notify/send_test', {})); // pending, not yet delivered
    expect((await panel.maintain()).notificationsPruned).toBe(0);
    t += 15 * 24 * HOUR;
    await relog();
    expect((await panel.maintain()).notificationsPruned).toBe(1);
    const left = await items();
    expect(left).toHaveLength(1);
    expect(left[0]!.status).toBe('pending');
  });
});
