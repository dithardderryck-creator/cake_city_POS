import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  TONES,
  VIBRATION,
  browserAlarm,
  createAlertWatcher,
  disablePhoneNotifications,
  enablePhoneNotifications,
  urlBase64ToBytes,
  type AlarmEffects,
  type AlertInboxData,
  type AlertRow,
  type BrowserEnv,
  type PushEnv,
} from '@cake-pos/client';

const row = (id: string, o: Partial<AlertRow> = {}): AlertRow => ({
  alertId: id,
  kind: 'low_stock',
  kindLabel: 'Low stock',
  severity: 'warning',
  title: `Alert ${id}`,
  body: 'Body',
  screen: 'forecast',
  createdAt: new Date(NOW - 60_000).toISOString(),
  seen: false,
  acknowledgedByName: null,
  to: ['inventory'],
  can: { acknowledge: true, snooze: true },
  ...o,
});
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function harness(o: { repeatEveryMs?: number; maxRepeats?: number } = {}) {
  const sounds: string[] = [];
  const buzzes: string[] = [];
  const notified: string[] = [];
  const effects: AlarmEffects = { sound: (s) => sounds.push(s), vibrate: (s) => buzzes.push(s), notify: (a) => notified.push(a.alertId) };
  const dispatched: Array<{ type: string; payload: unknown }> = [];
  let push!: (r: { ok: true; data: AlertInboxData } | { ok: false; error: { code: 'error'; messages: string[] } }) => void;
  let unsubscribed = false;
  const client = {
    subscribe: ((_name: string, _p: unknown, l: typeof push) => {
      push = l;
      return () => {
        unsubscribed = true;
      };
    }) as never,
    dispatch: (async (type: string, payload: unknown) => {
      dispatched.push({ type, payload });
      return { ok: true, data: {}, warnings: [], summary: '' };
    }) as never,
  };
  // A clock we move by hand, so "30 seconds later" takes no time.
  let clockMs = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const watcher = createAlertWatcher({
    client,
    effects,
    now: () => clockMs,
    setTimer: (fn, ms) => (timers.set(nextId, { at: clockMs + ms, fn }), nextId++),
    clearTimer: (id) => void timers.delete(id as number),
    ...o,
  });
  const snapshot = (open: AlertRow[]) =>
    push({ ok: true, data: { open, snoozed: [], recent: [], unseen: open.filter((a) => !a.seen).length, critical: open.filter((a) => a.severity === 'critical').length } });
  const advance = (ms: number) => {
    const end = clockMs + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      clockMs = next[1].at;
      next[1].fn();
    }
    clockMs = end;
  };
  return { watcher, sounds, buzzes, notified, dispatched, snapshot, advance, timers, unsubscribed: () => unsubscribed };
}

describe('the alert watcher', () => {
  it('sounds once for a new alert, never again for the same one, and says nothing for what was already seen', () => {
    const h = harness();
    h.snapshot([row('a', { seen: true })]);
    expect(h.sounds).toEqual([]);
    h.snapshot([row('a', { seen: true }), row('b')]);
    expect(h.sounds).toEqual(['warning']);
    expect(h.buzzes).toEqual(['warning']);
    expect(h.notified).toEqual(['b']);
    h.snapshot([row('a', { seen: true }), row('b')]);
    expect(h.sounds).toEqual(['warning']);
  });

  it('after a reload, sounds for a recent unseen alert but not for an old one', () => {
    const h = harness();
    h.snapshot([row('old', { createdAt: new Date(NOW - 3 * 3_600_000).toISOString() }), row('fresh', { createdAt: new Date(NOW - 2 * 60_000).toISOString() })]);
    expect(h.notified).toEqual(['fresh']);
    expect(h.sounds).toHaveLength(1);
    expect(h.watcher.state).toMatchObject({ unseen: 2, open: expect.any(Array) });
  });

  it('gives one sound for a batch, as serious as the worst alert in it', () => {
    const h = harness();
    h.snapshot([]);
    h.snapshot([row('a'), row('b', { severity: 'critical' }), row('c')]);
    expect(h.sounds).toEqual(['critical']);
    expect(h.notified.sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps sounding an unseen critical alert until it is seen, taken, or gone', () => {
    const h = harness({ repeatEveryMs: 30_000 });
    h.snapshot([]);
    h.snapshot([row('x', { severity: 'critical' })]);
    expect(h.sounds).toEqual(['critical']);
    expect(h.watcher.state.ringing).toBe(true);
    h.advance(95_000);
    expect(h.sounds).toEqual(['critical', 'critical', 'critical', 'critical']);
    // Somebody else takes it: the alarm stops here too.
    h.snapshot([row('x', { severity: 'critical', acknowledgedByName: 'Juma' })]);
    expect(h.watcher.state.ringing).toBe(false);
    h.advance(120_000);
    expect(h.sounds).toHaveLength(4);
    expect(h.timers.size).toBe(0);
  });

  it('stops the alarm when the alert is marked seen somewhere else', () => {
    const h = harness();
    h.snapshot([]);
    h.snapshot([row('x', { severity: 'critical' })]);
    expect(h.watcher.state.ringing).toBe(true);
    h.snapshot([row('x', { severity: 'critical', seen: true })]);
    expect(h.watcher.state.ringing).toBe(false);
    h.advance(300_000);
    expect(h.sounds).toHaveLength(1);
  });

  it('stops the alarm when the problem clears', () => {
    const h = harness();
    h.snapshot([]);
    h.snapshot([row('x', { severity: 'critical' })]);
    h.snapshot([]);
    h.advance(300_000);
    expect(h.sounds).toHaveLength(1);
    expect(h.watcher.state.ringing).toBe(false);
  });

  it('does not repeat for ordinary alerts', () => {
    const h = harness();
    h.snapshot([]);
    h.snapshot([row('w')]);
    h.advance(600_000);
    expect(h.sounds).toEqual(['warning']);
    expect(h.watcher.state.ringing).toBe(false);
  });

  it('gives up after a limit, so a forgotten tablet is not loud all night', () => {
    const h = harness({ repeatEveryMs: 30_000, maxRepeats: 3 });
    h.snapshot([]);
    h.snapshot([row('x', { severity: 'critical' })]);
    h.advance(10 * 60_000);
    expect(h.sounds).toHaveLength(1 + 3);
    expect(h.watcher.state.ringing).toBe(false);
    expect(h.timers.size).toBe(0);
  });

  it('marks everything seen on request, stops the alarm, and tells the server', async () => {
    const h = harness();
    h.snapshot([]);
    h.snapshot([row('x', { severity: 'critical' }), row('y'), row('z', { seen: true })]);
    await h.watcher.markAllSeen();
    expect(h.dispatched).toEqual([{ type: 'alerts/mark_seen', payload: { alertIds: ['x', 'y'] } }]);
    expect(h.watcher.state.ringing).toBe(false);
    h.advance(120_000);
    expect(h.sounds).toHaveLength(1);
    // The server answers with the same alerts, now seen; there is nothing left to mark.
    h.snapshot([row('x', { severity: 'critical', seen: true }), row('y', { seen: true }), row('z', { seen: true })]);
    await h.watcher.markAllSeen();
    expect(h.dispatched).toHaveLength(1);
  });

  it('can be muted: no sound, but the phone still buzzes and notifies', () => {
    const h = harness();
    h.snapshot([]);
    h.watcher.setMuted(true);
    h.snapshot([row('x', { severity: 'critical' })]);
    expect(h.sounds).toEqual([]);
    expect(h.buzzes).toEqual(['critical']);
    expect(h.notified).toEqual(['x']);
    h.advance(65_000);
    expect(h.sounds).toEqual([]);
    expect(h.watcher.state.muted).toBe(true);
  });

  it('ignores an error answer, and stops completely when told to', () => {
    const h = harness();
    h.snapshot([]);
    (h as unknown as { snapshot: unknown }).snapshot;
    h.snapshot([row('x', { severity: 'critical' })]);
    h.watcher.stop();
    expect(h.unsubscribed()).toBe(true);
    expect(h.timers.size).toBe(0);
    h.advance(300_000);
    expect(h.sounds).toHaveLength(1);
  });

  it('tells listeners when the state changes', () => {
    const h = harness();
    const seen: number[] = [];
    h.watcher.onChange((s) => seen.push(s.unseen));
    h.snapshot([row('a'), row('b')]);
    h.snapshot([row('a', { seen: true }), row('b')]);
    expect(seen).toEqual([2, 1]);
  });
});

describe('the browser alarm', () => {
  function audioEnv(startState = 'suspended') {
    const made = { oscillators: [] as Array<{ freq: number; type: string; start: number; stop: number }>, resumed: 0 };
    class Ctx {
      state = startState;
      currentTime = 10;
      destination = {};
      async resume() {
        made.resumed++;
        this.state = 'running';
      }
      createOscillator() {
        const o = { type: 'sine', freq: 0, start: 0, stop: 0 };
        made.oscillators.push(o);
        return { set type(v: string) { o.type = v; }, get type() { return o.type; }, frequency: { setValueAtTime: (v: number) => void (o.freq = v) }, connect() {}, start: (t: number) => void (o.start = t), stop: (t: number) => void (o.stop = t) };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
      }
    }
    return { made, Ctx: Ctx as unknown as NonNullable<BrowserEnv['AudioContext']> };
  }

  it('is silent until a tap unlocks sound, then plays the right tune for each level', async () => {
    const { made, Ctx } = audioEnv();
    const a = browserAlarm({ AudioContext: Ctx });
    expect(a.audio).toBe('locked');
    a.sound('critical');
    expect(made.oscillators).toHaveLength(0); // browsers would refuse; do not pretend
    await a.unlock();
    expect(a.audio).toBe('ready');
    a.sound('warning');
    expect(made.oscillators.map((o) => [o.freq, o.type])).toEqual([[880, 'sine'], [880, 'sine']]);
    made.oscillators.length = 0;
    a.sound('critical');
    expect(made.oscillators).toHaveLength(TONES.critical.notes.length);
    expect(made.oscillators.every((o) => o.type === 'square')).toBe(true);
    expect(new Set(made.oscillators.map((o) => o.freq))).toEqual(new Set([960, 640]));
    expect(made.oscillators[0]!.start).toBe(10);
    expect(Math.max(...made.oscillators.map((o) => o.stop))).toBeGreaterThan(11.7);
  });

  it('says so on a browser with no audio at all', async () => {
    const a = browserAlarm({});
    await a.unlock();
    expect(a.audio).toBe('unsupported');
    expect(() => a.sound('critical')).not.toThrow();
  });

  it('stays locked, without throwing, if the browser refuses to start sound', async () => {
    class Stubborn {
      state = 'suspended';
      async resume() {
        throw new Error('NotAllowedError');
      }
    }
    const a = browserAlarm({ AudioContext: Stubborn as never });
    await a.unlock();
    expect(a.audio).toBe('locked');
  });

  it('buzzes the phone with a pattern that fits the level, and survives a browser that refuses', () => {
    const calls: number[][] = [];
    const a = browserAlarm({ navigator: { vibrate: (p) => (calls.push(p), true) } });
    a.vibrate('warning');
    a.vibrate('critical');
    expect(calls).toEqual([VIBRATION.warning, VIBRATION.critical]);
    expect(() => browserAlarm({ navigator: { vibrate: () => { throw new Error('no'); } } }).vibrate('critical')).not.toThrow();
    expect(() => browserAlarm({}).vibrate('critical')).not.toThrow();
  });

  it('shows a system notification only when allowed and the page is out of sight', () => {
    const shown: Array<[string, Record<string, unknown>]> = [];
    class N {
      static permission = 'granted';
      constructor(title: string, o: Record<string, unknown>) {
        shown.push([title, o]);
      }
    }
    const alert = row('a1', { severity: 'critical', title: 'Flour is out of stock', body: 'Order more.' });
    browserAlarm({ Notification: N as never, document: { hidden: false } }).notify(alert);
    expect(shown).toEqual([]);
    browserAlarm({ Notification: N as never, document: { hidden: true } }).notify(alert);
    expect(shown).toEqual([['Flour is out of stock', { body: 'Order more.', tag: 'a1', requireInteraction: true }]]);
    N.permission = 'denied';
    browserAlarm({ Notification: N as never, document: { hidden: true } }).notify(alert);
    expect(shown).toHaveLength(1);
  });

  it('keeps the screen awake where it can', async () => {
    expect(await browserAlarm({ navigator: { wakeLock: { request: async () => ({}) } } }).keepAwake()).toBe(true);
    expect(await browserAlarm({ navigator: {} }).keepAwake()).toBe(false);
    expect(await browserAlarm({ navigator: { wakeLock: { request: async () => { throw new Error('battery saver'); } } } }).keepAwake()).toBe(false);
  });
});

describe('turning on phone notifications', () => {
  const setupFeed = (publicKey: string | null) => async () => ({ ok: true as const, data: { push: { publicKey, endpoints: [] } } });
  function env(o: { permission?: string; request?: string; secure?: boolean; existing?: boolean; noSw?: boolean } = {}) {
    const subscribed: Array<{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }> = [];
    const manager = {
      getSubscription: async () => (o.existing ? sub : null),
      subscribe: async (opts: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => (subscribed.push(opts), sub),
    };
    const sub = { endpoint: 'https://push.example/abc', toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'PK', auth: 'AK' } }), unsubscribe: async () => true };
    const registered: string[] = [];
    const e: PushEnv = {
      isSecureContext: o.secure ?? true,
      Notification: { permission: o.permission ?? 'default', requestPermission: async () => o.request ?? 'granted' },
      PushManager: {},
      navigator: o.noSw ? {} : { userAgent: 'Test Phone', serviceWorker: { register: async (u: string) => (registered.push(u), { pushManager: manager }), ready: Promise.resolve({ pushManager: manager }) } },
    };
    return { e, subscribed, registered, sub };
  }
  const client = (publicKey: string | null = 'AQAB-_w') => {
    const dispatched: Array<{ type: string; payload: unknown }> = [];
    return { c: { feed: setupFeed(publicKey), dispatch: async (type: string, payload: unknown) => (dispatched.push({ type, payload }), { ok: true as const, data: {}, warnings: [], summary: '' }) } as never, dispatched };
  };

  it('registers the service worker, subscribes with the shop’s key, and tells the server', async () => {
    const { e, subscribed, registered } = env();
    const { c, dispatched } = client();
    expect(await enablePhoneNotifications(c, { env: e })).toEqual({ ok: true });
    expect(registered).toEqual(['/alert-sw.js']);
    expect(subscribed[0]!.userVisibleOnly).toBe(true);
    expect([...subscribed[0]!.applicationServerKey]).toEqual([1, 0, 1, 251, 252]);
    expect(dispatched).toEqual([{ type: 'push/subscribe', payload: { endpoint: 'https://push.example/abc', p256dh: 'PK', auth: 'AK', userAgent: 'Test Phone' } }]);
  });

  it('reuses a subscription the browser already has instead of making a second', async () => {
    const { e, subscribed } = env({ existing: true, permission: 'granted' });
    expect((await enablePhoneNotifications(client().c, { env: e })).ok).toBe(true);
    expect(subscribed).toEqual([]);
  });

  it('explains each way it can fail, in plain words', async () => {
    const reason = async (o: Parameters<typeof env>[0], key: string | null = 'AQAB') => {
      const r = await enablePhoneNotifications(client(key).c, { env: env(o).e });
      return r.ok ? 'ok' : r.reason;
    };
    expect(await reason({ secure: false })).toBe('insecure');
    expect(await reason({ noSw: true })).toBe('unsupported');
    expect(await reason({}, null)).toBe('not_set_up');
    expect(await reason({ request: 'denied' })).toBe('denied');
    const insecure = await enablePhoneNotifications(client().c, { env: env({ secure: false }).e });
    expect(!insecure.ok && insecure.message).toMatch(/https:\/\//);
    const noPermission = await enablePhoneNotifications(client().c, { env: env({ request: 'denied' }).e });
    expect(!noPermission.ok && noPermission.message).toMatch(/blocked/);
  });

  it('fails cleanly when the server refuses or the browser throws', async () => {
    const refusing = { feed: setupFeed('AQAB'), dispatch: async () => ({ ok: false as const, error: { code: 'invalid' as const, messages: ['no'] } }) } as never;
    expect(await enablePhoneNotifications(refusing, { env: env().e })).toMatchObject({ ok: false, reason: 'failed' });
    const e = env().e;
    e.navigator!.serviceWorker!.register = async () => {
      throw new Error('SecurityError');
    };
    expect(await enablePhoneNotifications(client().c, { env: e })).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('turns notifications off on this device and tells the server', async () => {
    const { e } = env({ existing: true });
    const { c, dispatched } = client();
    expect(await disablePhoneNotifications(c, { env: e })).toBe(true);
    expect(dispatched).toEqual([{ type: 'push/unsubscribe', payload: { endpoint: 'https://push.example/abc' } }]);
  });

  it('reads the server’s key into bytes', () => {
    expect([...urlBase64ToBytes('AQAB-_w')]).toEqual([1, 0, 1, 251, 252]);
    expect(urlBase64ToBytes('').length).toBe(0);
  });
});

describe('the reference service worker', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/service-worker/alert-sw.js'), 'utf8');
  function load(windows: Array<{ focus: () => Promise<unknown>; postMessage: (m: unknown) => void }> = []) {
    const listeners: Record<string, (e: any) => void> = {};
    const shown: Array<[string, Record<string, any>]> = [];
    const opened: string[] = [];
    const self = {
      addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
      registration: { showNotification: async (title: string, o: Record<string, any>) => void shown.push([title, o]) },
      clients: { matchAll: async () => windows, openWindow: async (u: string) => void opened.push(u) },
    };
    vm.runInNewContext(source, { self });
    return { listeners, shown, opened };
  }
  const pushEvent = (data: unknown) => {
    const waits: Promise<unknown>[] = [];
    return { event: { data: { json: () => data, text: () => String(data) }, waitUntil: (p: Promise<unknown>) => waits.push(p) }, done: () => Promise.all(waits) };
  };

  it('shows a critical notification that stays until tapped, and replaces an earlier one with the same tag', async () => {
    const w = load();
    const p = pushEvent({ title: 'Flour is out of stock', body: 'Order more.', tag: 'alt_1', severity: 'critical', screen: 'forecast', alertId: 'alt_1' });
    w.listeners.push!(p.event);
    await p.done();
    expect(w.shown).toEqual([['Flour is out of stock', expect.objectContaining({ body: 'Order more.', tag: 'alt_1', renotify: true, requireInteraction: true, data: { screen: 'forecast', alertId: 'alt_1' } })]]);
    expect(w.shown[0]![1].vibrate).toEqual([600, 200, 600, 200, 600]);
  });

  it('lets an ordinary notification go away by itself, and copes with a message it cannot read', async () => {
    const w = load();
    const a = pushEvent({ title: 'Low', body: 'b', severity: 'warning' });
    w.listeners.push!(a.event);
    await a.done();
    expect(w.shown[0]![1]).toMatchObject({ requireInteraction: false, vibrate: [200, 100, 200], data: { screen: 'alerts' } });
    const broken = { data: { json: () => { throw new Error('bad json'); }, text: () => 'plain words' }, waitUntil: (p: Promise<unknown>) => void p };
    w.listeners.push!(broken);
    await Promise.resolve();
    expect(w.shown[1]![0]).toBe('Cake POS');
    expect(w.shown[1]![1].body).toBe('plain words');
  });

  it('opens the right screen when tapped: in the open window if there is one, otherwise a new one', async () => {
    const messages: unknown[] = [];
    let focused = 0;
    const w = load([{ focus: async () => void focused++, postMessage: (m) => void messages.push(m) }]);
    let closed = 0;
    const waits: Promise<unknown>[] = [];
    w.listeners.notificationclick!({ notification: { close: () => void closed++, data: { screen: 'usage_inbox' } }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(closed).toBe(1);
    expect(messages).toEqual([{ type: 'open-screen', screen: 'usage_inbox' }]);
    expect(focused).toBe(1);
    const none = load([]);
    const w2: Promise<unknown>[] = [];
    none.listeners.notificationclick!({ notification: { close() {}, data: { screen: 'bake queue' } }, waitUntil: (p: Promise<unknown>) => w2.push(p) });
    await Promise.all(w2);
    expect(none.opened).toEqual(['/?screen=bake%20queue']);
  });
});

describe('the whole thing joins up', () => {
  it('a snapshot in the shape the server sends makes the watcher ring', () => {
    const h = harness();
    h.snapshot([]);
    const data: AlertInboxData = { open: [row('e2e', { severity: 'critical' })], snoozed: [], recent: [], unseen: 1, critical: 1 };
    expect(data.open[0]!.title).toBe('Alert e2e');
    h.snapshot(data.open);
    expect(h.watcher.state).toMatchObject({ unseen: 1, critical: 1, ringing: true });
  });
});
