/**
 * The one script every page loads. It signs people in, reads feeds, sends intents and shows the connection state.
 * It holds no shop logic (BR-22): pages show what a feed says and send what a person taps.
 */
import { createClient, localStorageTokenStore } from '@cake-pos/client';
import type { ClientResult, FeedMap, FeedName, IntentMap, IntentName, Role, SessionInfo, StaffSigninRow } from '@cake-pos/client';

const client = createClient({ tokenStore: localStorageTokenStore() });

/** The page each role works in. */
export const HOME: Record<Role, string> = {
  owner: '/owner.html',
  cashier: '/cashier.html',
  baker: '/baker.html',
  inventory: '/inventory.html',
  it: '/it.html',
};

let session: SessionInfo | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a short message. Uses the page's own #toast if it has one. */
export function toast(message: string): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('on'), 3200);
}

function offlineBanner(): HTMLElement {
  let el = document.getElementById('offline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'offline';
    el.setAttribute('role', 'alert');
    el.hidden = true;
    el.style.cssText =
      'position:fixed;left:0;right:0;top:0;z-index:60;padding:8px 14px;text-align:center;font:600 13px system-ui,sans-serif;background:var(--risk,#b4452f);color:#fff';
    el.textContent = 'Cannot reach the shop server. Check the wifi. Changes are paused until it is back.';
    document.body.appendChild(el);
  }
  return el;
}

/** True while the server cannot be reached. Pages disable buttons that change things while this is set. */
export let offline = false;

function watchConnection(): void {
  const banner = offlineBanner();
  client.onConnection((s) => {
    offline = s === 'offline';
    banner.hidden = !offline;
    document.documentElement.toggleAttribute('data-offline', offline);
  });
}

/** Goes to the sign-in page. */
export function goSignIn(): void {
  location.replace('/');
}

/**
 * Call first on every role page. Restores the sign-in, sends the person elsewhere if this is not their page,
 * and keeps watching: if the sign-in ends (expired, switched off, signed out elsewhere) the page returns to sign-in.
 */
export async function boot(allowed: Role | Role[]): Promise<SessionInfo> {
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  const s = await client.restore();
  if (!s) {
    goSignIn();
    return new Promise<SessionInfo>(() => undefined);
  }
  if (!roles.includes(s.role)) {
    location.replace(HOME[s.role]);
    return new Promise<SessionInfo>(() => undefined);
  }
  session = s;
  client.onSignedOut(goSignIn);
  watchConnection();
  return s;
}

export function me(): SessionInfo | null {
  return session;
}

/**
 * Reads a feed and calls `render` now and after every change anyone makes.
 * A refusal is shown to the person in plain words. Returns a function that stops listening.
 */
export function feed<K extends FeedName>(name: K, params: FeedMap[K]['params'], render: (data: FeedMap[K]['data']) => void): () => void {
  let lastError = '';
  return client.subscribe(name, params, (r) => {
    if (r.ok) {
      lastError = '';
      render(r.data);
    } else {
      const m = r.error.messages[0] ?? 'Something went wrong.';
      if (m !== lastError) toast(m);
      lastError = m;
    }
  });
}

/** Reads a feed once. */
export async function read<K extends FeedName>(name: K, params: FeedMap[K]['params']): Promise<FeedMap[K]['data'] | null> {
  const r = await client.feed(name, params);
  if (r.ok) return r.data;
  toast(r.error.messages[0] ?? 'Something went wrong.');
  return null;
}

export interface SendOutcome {
  ok: boolean;
  /** What the server returned, for pages that need it (for example a new order id). */
  data?: unknown;
  /** The first plain-language message, already shown to the person. */
  message?: string;
}

/**
 * Sends one instruction. A refusal is shown in plain words and nothing is changed.
 * Pages never edit their own data afterwards: the live feed brings the new state.
 */
export async function send<K extends IntentName>(type: K, payload: IntentMap[K], okMessage?: string): Promise<SendOutcome> {
  const r: ClientResult = await client.dispatch(type, payload);
  if (!r.ok) {
    const m = r.error.messages.join(' ') || 'That did not work.';
    toast(m);
    return { ok: false, message: m };
  }
  const note = r.warnings.length ? r.warnings.join(' ') : okMessage;
  if (note) toast(note);
  return { ok: true, data: r.data, message: note };
}

export async function staff(): Promise<StaffSigninRow[]> {
  return client.staff();
}

/** Signs in and goes to the person's own page. Returns the refusal text when it fails. */
export async function signIn(userId: string, pin: string): Promise<string | null> {
  const r = await client.signIn(userId, pin);
  if (!r.ok) return r.messages[0] ?? 'Could not sign in.';
  location.assign(HOME[r.session.role]);
  return null;
}

export async function signOut(): Promise<void> {
  await client.signOut();
  goSignIn();
}

/** A picture as a URL for <img src>. */
export async function photoUrl(photoId: string): Promise<string | null> {
  const r = await client.photo(photoId);
  return r.ok ? URL.createObjectURL(r.blob) : null;
}

/** Escapes text for use inside innerHTML. Every value from a feed that a person typed goes through this. */
export function esc(t: unknown): string {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export { client };
