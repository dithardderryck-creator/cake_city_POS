/**
 * Alarm behaviour for any screen: a sound and a buzz when a new alert arrives, a louder repeating alarm for critical ones
 * until someone sees them, and a way to turn on notifications for when the app is closed.
 *
 * Nothing here draws anything. `createAlertWatcher` holds the rules; `browserAlarm` is the part that makes noise in a
 * browser. They are separate so the rules can be tested without a speaker, and so the UI can use its own sounds.
 */
import type { Client } from './index';
import type { AlertInboxData, AlertRow } from '@cake-pos/panel';

export type { AlertInboxData, AlertRow };

export interface AlarmEffects {
  /** Make a sound for a new alert. Critical should be unmistakable. */
  sound(severity: 'warning' | 'critical'): void;
  /** Buzz the phone, where the browser allows it. */
  vibrate(severity: 'warning' | 'critical'): void;
  /** Show a system notification (the browser decides whether that is useful, for example only when the page is hidden). */
  notify(alert: AlertRow): void;
}

export interface WatcherState {
  open: AlertRow[];
  /** Not yet seen by this person. */
  unseen: number;
  critical: number;
  /** True while a critical alarm is repeating. */
  ringing: boolean;
  /** The sound is switched off for this device. Vibration and notifications still work. */
  muted: boolean;
}

export interface AlertWatcherOptions {
  client: Pick<Client, 'subscribe' | 'dispatch'>;
  effects: AlarmEffects;
  /** How often an unseen critical alert sounds again. Default 30 seconds. */
  repeatEveryMs?: number;
  /** How many times it repeats before giving up, so a forgotten tablet is not loud all night. Default 10. */
  maxRepeats?: number;
  /** On load, alerts newer than this still sound once (you reloaded and might have missed one). Default 15 minutes. */
  freshMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface AlertWatcher {
  readonly state: WatcherState;
  onChange(listener: (s: WatcherState) => void): () => void;
  /** Sound off or on for this device. Remembered by the caller if it wants. */
  setMuted(muted: boolean): void;
  /** Stops a repeating alarm for the alerts that are open now, and tells the server this person has seen them. */
  markAllSeen(): Promise<void>;
  /** Stops listening. */
  stop(): void;
}

export function createAlertWatcher(opts: AlertWatcherOptions): AlertWatcher {
  const repeatEvery = opts.repeatEveryMs ?? 30_000;
  const maxRepeats = opts.maxRepeats ?? 10;
  const fresh = opts.freshMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let state: WatcherState = { open: [], unseen: 0, critical: 0, ringing: false, muted: false };
  const listeners = new Set<(s: WatcherState) => void>();
  const known = new Set<string>();
  let first = true;
  let timer: unknown;
  let repeats = 0;
  let stopped = false;

  const emit = () => {
    for (const l of listeners) l(state);
  };
  const ring = (severity: 'warning' | 'critical') => {
    if (!state.muted) opts.effects.sound(severity);
    opts.effects.vibrate(severity);
  };
  const needsAlarm = (a: AlertRow) => a.severity === 'critical' && !a.seen && !a.acknowledgedByName;
  const stopRepeating = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    repeats = 0;
  };
  const scheduleRepeat = () => {
    timer = setTimer(() => {
      timer = undefined;
      if (stopped || !state.open.some(needsAlarm)) {
        stopRepeating();
        state = { ...state, ringing: false };
        emit();
        return;
      }
      repeats++;
      ring('critical');
      if (repeats < maxRepeats) scheduleRepeat();
      else {
        state = { ...state, ringing: false };
        emit();
      }
    }, repeatEvery);
  };

  const off = opts.client.subscribe('alert_inbox', {}, (r) => {
    if (stopped || !r.ok) return;
    const open = r.data.open;
    const newOnes = open.filter((a) => !known.has(a.alertId) && !a.seen && !a.acknowledgedByName && (!first || now() - Date.parse(a.createdAt) <= fresh));
    for (const a of open) known.add(a.alertId);
    first = false;

    let ringing = state.ringing;
    if (newOnes.length) {
      // One sound per batch, as loud as the most serious alert in it.
      ring(newOnes.some((a) => a.severity === 'critical') ? 'critical' : 'warning');
      for (const a of newOnes) opts.effects.notify(a);
    }
    if (open.some(needsAlarm)) {
      if (timer === undefined) {
        repeats = 0;
        scheduleRepeat();
      }
      ringing = true;
    } else {
      stopRepeating();
      ringing = false;
    }
    state = { ...state, open, unseen: r.data.unseen, critical: r.data.critical, ringing };
    emit();
  });

  return {
    get state() {
      return state;
    },
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setMuted(muted) {
      state = { ...state, muted };
      emit();
    },
    async markAllSeen() {
      const ids = state.open.filter((a) => !a.seen).map((a) => a.alertId);
      stopRepeating();
      state = { ...state, ringing: false };
      emit();
      if (ids.length) await opts.client.dispatch('alerts/mark_seen', { alertIds: ids });
    },
    stop() {
      stopped = true;
      stopRepeating();
      off();
      listeners.clear();
    },
  };
}

/* ---------- Making noise in a browser ---------- */

export interface BrowserAlarm extends AlarmEffects {
  /**
   * Browsers keep a page silent until the person has tapped it once. Call this from a tap (for example when they sign in
   * or press "Turn on alarm sound"). `locked` means no sound will play yet.
   */
  unlock(): Promise<void>;
  readonly audio: 'locked' | 'ready' | 'unsupported';
  /** Plays the sound once so a person can check the volume. */
  test(severity?: 'warning' | 'critical'): void;
  /** Keeps the screen from going to sleep, for a tablet in the kitchen. Returns false where the browser cannot. */
  keepAwake(): Promise<boolean>;
}

interface AudioLike {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): { type: string; frequency: { setValueAtTime(v: number, t: number): void }; connect(n: unknown): void; start(t: number): void; stop(t: number): void };
  createGain(): { gain: { setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): void };
}

/** Beep schedule: [frequency in Hz, start offset in s, length in s]. Warning is two soft beeps, critical is a siren. */
export const TONES = {
  warning: { volume: 0.25, notes: [[880, 0, 0.16], [880, 0.26, 0.16]] as Array<[number, number, number]> },
  critical: {
    volume: 0.7,
    notes: [[960, 0, 0.25], [640, 0.25, 0.25], [960, 0.5, 0.25], [640, 0.75, 0.25], [960, 1, 0.25], [640, 1.25, 0.25], [960, 1.5, 0.25], [640, 1.75, 0.25]] as Array<[number, number, number]>,
  },
};
export const VIBRATION = { warning: [200, 100, 200], critical: [600, 200, 600, 200, 600, 200, 600] };

export interface BrowserEnv {
  AudioContext?: new () => AudioLike;
  navigator?: { vibrate?: (p: number[]) => boolean; wakeLock?: { request(type: 'screen'): Promise<unknown> } };
  Notification?: { permission: string; new (title: string, o?: Record<string, unknown>): unknown };
  document?: { hidden: boolean };
}

export function browserAlarm(env: BrowserEnv = globalThis as unknown as BrowserEnv): BrowserAlarm {
  let ctx: AudioLike | undefined;
  let audio: BrowserAlarm['audio'] = env.AudioContext ? 'locked' : 'unsupported';

  const play = (severity: 'warning' | 'critical') => {
    if (!ctx || ctx.state !== 'running') return;
    const { volume, notes } = TONES[severity];
    const t0 = ctx.currentTime;
    for (const [freq, at, len] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = severity === 'critical' ? 'square' : 'sine';
      osc.frequency.setValueAtTime(freq, t0 + at);
      // A short fade in and out stops the clicks a hard start and stop would make.
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + at + len);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
  };

  return {
    get audio() {
      return audio;
    },
    async unlock() {
      if (!env.AudioContext) return;
      try {
        ctx ??= new env.AudioContext();
        await ctx.resume();
        audio = ctx.state === 'running' ? 'ready' : 'locked';
      } catch {
        audio = 'locked';
      }
    },
    sound: play,
    test: (severity = 'warning') => play(severity),
    vibrate(severity) {
      try {
        env.navigator?.vibrate?.(VIBRATION[severity]);
      } catch {
        /* some browsers refuse; the sound and the screen still work */
      }
    },
    notify(alert) {
      // On screen, the alert list is the notification. A system notification is for when the page is out of sight.
      if (!env.Notification || env.Notification.permission !== 'granted' || !env.document?.hidden) return;
      try {
        new env.Notification(alert.title, { body: alert.body, tag: alert.alertId, requireInteraction: alert.severity === 'critical' });
      } catch {
        /* phones that only allow notifications from a service worker use phone notifications instead */
      }
    },
    async keepAwake() {
      try {
        if (!env.navigator?.wakeLock) return false;
        await env.navigator.wakeLock.request('screen');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* ---------- Notifications when the app is closed (Web Push) ---------- */

export type PhoneNotificationResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'insecure' | 'not_set_up' | 'denied' | 'failed'; message: string };

const MESSAGES: Record<Exclude<PhoneNotificationResult, { ok: true }>['reason'], string> = {
  unsupported: 'This browser cannot receive notifications when it is closed. On an iPhone, add the app to the Home Screen first.',
  insecure: 'Phone notifications need the shop address to start with https://. Ask IT to set up a secure address.',
  not_set_up: 'Phone notifications are not set up on the shop server yet. Ask IT.',
  denied: 'Notifications are blocked for this site. Allow them in the browser settings, then try again.',
  failed: 'Could not turn notifications on. Try again.',
};
const fail = (reason: keyof typeof MESSAGES): PhoneNotificationResult => ({ ok: false, reason, message: MESSAGES[reason] });

export interface PushEnv {
  isSecureContext?: boolean;
  Notification?: { permission: string; requestPermission(): Promise<string> };
  navigator?: {
    userAgent?: string;
    serviceWorker?: { register(url: string): Promise<{ pushManager: PushManagerLike }>; ready?: Promise<{ pushManager: PushManagerLike }> };
  };
  PushManager?: unknown;
}
interface PushManagerLike {
  getSubscription(): Promise<SubLike | null>;
  subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<SubLike>;
}
interface SubLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

/** The browser wants the server's public key as bytes, and the server gives it as URL-safe base64 text. */
export function urlBase64ToBytes(text: string): Uint8Array {
  const b64 = (text + '='.repeat((4 - (text.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Turns on notifications for this phone or browser. Call it from a tap (browsers insist). The person is asked for
 * permission, the device registers with its maker's push service, and the shop server is told how to reach it.
 */
export async function enablePhoneNotifications(client: Pick<Client, 'feed' | 'dispatch'>, opts: { serviceWorkerUrl?: string; env?: PushEnv } = {}): Promise<PhoneNotificationResult> {
  const env = opts.env ?? (globalThis as unknown as PushEnv);
  if (env.isSecureContext === false) return fail('insecure');
  if (!env.navigator?.serviceWorker || !env.PushManager || !env.Notification) return fail('unsupported');
  const setup = await client.feed('notification_setup', {});
  if (!setup.ok || !setup.data.push.publicKey) return fail(setup.ok ? 'not_set_up' : 'failed');
  try {
    const permission = env.Notification.permission === 'granted' ? 'granted' : await env.Notification.requestPermission();
    if (permission !== 'granted') return fail('denied');
    const reg = await env.navigator.serviceWorker.register(opts.serviceWorkerUrl ?? '/alert-sw.js');
    const manager = (await env.navigator.serviceWorker.ready)?.pushManager ?? reg.pushManager;
    const sub = (await manager.getSubscription()) ?? (await manager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(setup.data.push.publicKey) }));
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return fail('failed');
    const r = await client.dispatch('push/subscribe', { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, userAgent: env.navigator.userAgent });
    return r.ok ? { ok: true } : fail('failed');
  } catch {
    return fail('failed');
  }
}

/** Stops notifications on this device and tells the server to forget it. */
export async function disablePhoneNotifications(client: Pick<Client, 'dispatch'>, opts: { env?: PushEnv } = {}): Promise<boolean> {
  const env = opts.env ?? (globalThis as unknown as PushEnv);
  try {
    const reg = await env.navigator?.serviceWorker?.ready;
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return true;
    await client.dispatch('push/unsubscribe', { endpoint: sub.endpoint });
    return await sub.unsubscribe();
  } catch {
    return false;
  }
}
