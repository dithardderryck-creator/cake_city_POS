/**
 * The one script every page loads. It signs people in, reads feeds, sends intents and shows the connection state.
 * It holds no shop logic (BR-22): pages show what a feed says and send what a person taps.
 */
import { createClient, localStorageTokenStore } from '@cake-pos/client';
import type { ClientResult, FeedMap, FeedName, IntentMap, IntentName, Role, SessionInfo, StaffSigninRow } from '@cake-pos/client';

import { buildChrome } from './chrome';
import type { Chrome, ChromeOptions } from './chrome';
import * as i18n from './i18n';
import type { Lang } from './i18n';

i18n.early();

/** Translates a piece of text into the shop's language (Kiswahili), or leaves it as it is. */
export const tr = i18n.tr;
export const setLanguage = i18n.setLanguage;
export const language = i18n.current;
export const onLanguage = i18n.onChange;

/** Follows a language: used after sign-in and whenever a setting changes. */
function followLanguage(l: Lang | undefined) {
  if (l === 'en' || l === 'sw') void i18n.setLanguage(l);
}

/** The language this person chose for themselves, once the server has told us. Null means they follow the shop. */
let myLanguage: Lang | null = null;
/** The shop's language applies only to people who have not chosen their own. */
function followShopLanguage(l: Lang | undefined) {
  if (!myLanguage) followLanguage(l);
}

const client = createClient({ tokenStore: localStorageTokenStore(), deviceStore: localStorageTokenStore('cake-pos-device'), offlineStore: localStorageTokenStore('cake-pos-offline') });

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
    // Sticky and first in the page, so it pushes the page down instead of covering the header. Display is set in refreshBanner, never here:
    // a display written inline would beat the hidden attribute and show an empty bar all the time.
    el.style.cssText =
      'position:sticky;left:0;right:0;top:0;z-index:60;padding:8px 14px;text-align:center;font:600 13px system-ui,sans-serif;background:var(--risk,#b4452f);color:#fff;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap';
    el.style.display = 'none';
    el.innerHTML =
      '<span id="offline-t"></span><button id="offline-b" hidden style="font:inherit;color:inherit;border:1px solid #fff8;border-radius:8px;padding:4px 12px;background:none;cursor:pointer">See them</button>';
    document.body.prepend(el);
    el.querySelector('#offline-b')!.addEventListener('click', showOfflineNotices);
  }
  return el;
}

/** True while the server cannot be reached. Pages disable buttons that change things while this is set. */
export let offline = false;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the bar across the top says. Three things can be true at once: the server is gone, sales are waiting, sales need a person to look. */
function refreshBanner(): void {
  const el = offlineBanner();
  const st = client.offline.status();
  const needs = st.notices.length;
  let text = '';
  let colour = 'var(--risk,#b4452f)';
  if (offline) {
    text = st.canSell
      ? `Cannot reach the shop server. You can keep selling ready-made items: each sale is saved on this till and sent when the server is back.${st.waiting ? ` ${plural(st.waiting, 'sale is', 'sales are')} waiting.` : ''}`
      : 'Cannot reach the shop server. Check the wifi. Changes are paused until it is back.';
  } else if (st.waiting) {
    const old = st.oldestWaitingAt && Date.now() - Date.parse(st.oldestWaitingAt) > 2 * 3_600_000;
    text = old
      ? `${plural(st.waiting, 'offline sale has', 'offline sales have')} been waiting since ${clock(st.oldestWaitingAt!)}. Keep this till connected to the shop wifi until they are sent.`
      : `${plural(st.waiting, 'offline sale', 'offline sales')} saved on this till, sending now.`;
    colour = old ? 'var(--risk,#b4452f)' : 'var(--cop,#a8602a)';
  } else if (needs) {
    text = `${plural(needs, 'offline sale needs', 'offline sales need')} a look.`;
  }
  el.hidden = !text;
  el.style.display = text ? 'flex' : 'none';
  el.style.background = colour;
  el.querySelector('#offline-t')!.textContent = text;
  (el.querySelector('#offline-b') as HTMLElement).hidden = !needs;
  document.documentElement.toggleAttribute('data-offline', offline);
}

const KIND_LABEL = { held: 'Waiting for the owner to decide', refused: 'The server refused it', stuck: 'Could not be sent' } as const;

/** The sales that were saved offline but did not simply go through. They stay here until someone has read them. */
function showOfflineNotices(): void {
  const st = client.offline.status();
  if (!st.notices.length) return;
  const rows = st.notices
    .map((n) => {
      const items = n.items.reduce((a, i) => a + i.qty, 0);
      return `<div class="cx-c" style="margin:8px 0"><div class="cx-t"><b>Sale ${n.seq} · ${esc(money(n.total))}</b><span class="cx-k ${n.kind === 'held' ? 'cop' : 'risk'}">${esc(KIND_LABEL[n.kind])}</span></div><div class="cx-m">${esc(clock(n.madeAt))} · ${plural(items, 'item', 'items')} · ${esc(n.method.replace('_', ' '))}</div><div>${esc(n.message)}</div></div>`;
    })
    .join('');
  const d = dialog(
    `<h2>Offline sales that need a look</h2><p class="cx-e">These were sold while the server could not be reached. Write them down, and tell the owner. They are not lost: the owner can see the held ones and decide.</p>${rows}<div class="cx-a" style="justify-content:flex-end"><button class="cx-b p" id="off-ok">I have noted them</button></div>`,
  );
  d.el.querySelector('#off-ok')!.addEventListener('click', () => {
    client.offline.clearNotices();
    d.close();
  });
}

function watchConnection(): void {
  offlineBanner();
  client.onConnection((s) => {
    offline = s === 'offline';
    refreshBanner();
    for (const l of offlineListeners) l();
  });
  client.offline.onChange(() => {
    refreshBanner();
    for (const l of offlineListeners) l();
  });
  refreshBanner();
}

const offlineListeners = new Set<() => void>();
/** Calls `fn` whenever the server is lost or found, or the offline queue changes. */
export function onOffline(fn: () => void): void {
  offlineListeners.add(fn);
}
/** What the till can do offline right now, and what is waiting. */
export function offlineStatus() {
  return client.offline.status();
}

export interface SaleOutcome extends SendOutcome {
  /** True when the sale was saved on this till because the server could not be reached. */
  queued?: boolean;
  /** The till's own number for a saved sale. */
  seq?: number;
  madeAt?: string;
}

/**
 * Sells ready-made items now. If the server cannot be reached and this till holds an offline pass, the sale is saved on the
 * till and sent later (`queued: true`); the page shows a provisional slip, not a receipt.
 */
export async function quickSale(sale: { items: Array<{ combinationId: string; qty: number }>; method: IntentMap['orders/quick_sale']['method']; customerName?: string; expectedTotal: number }): Promise<SaleOutcome> {
  const r = await client.offline.quickSale(sale);
  if (!r.ok) {
    const m = r.error.messages.join(' ') || 'That did not work.';
    if (m.startsWith(LOBBY_PREFIX)) {
      void checkPlace();
      return { ok: false, message: m };
    }
    toast(m);
    return { ok: false, message: m };
  }
  if (r.queued) return { ok: true, queued: true, seq: r.seq, madeAt: r.madeAt, message: r.message };
  if (r.warnings.length) toast(r.warnings.join(' '));
  return { ok: true, data: r.data, message: r.warnings.join(' ') || undefined };
}

const ME_KEY = 'cake-pos-me';
function saveMe(who: SessionInfo | null): void {
  try {
    if (who) localStorage.setItem(ME_KEY, JSON.stringify(who));
    else localStorage.removeItem(ME_KEY);
  } catch {
    /* storage blocked: a page opened with no server just goes to sign-in */
  }
}
function cachedMe(): SessionInfo | null {
  try {
    const j = JSON.parse(localStorage.getItem(ME_KEY) ?? 'null') as SessionInfo | null;
    return j && typeof j.userId === 'string' && typeof j.role === 'string' ? j : null;
  } catch {
    return null;
  }
}

/** Goes to the sign-in page. */
export function goSignIn(): void {
  saveMe(null);
  location.replace('/');
}

// The pages are kept on the device so they still open when the shop server cannot be reached (see sw.js).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}

/**
 * Call first on every role page. Restores the sign-in, sends the person elsewhere if this is not their page,
 * and keeps watching: if the sign-in ends (expired, switched off, signed out elsewhere) the page returns to sign-in.
 */
export async function boot(allowed: Role | Role[]): Promise<SessionInfo> {
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  let s = await client.restore();
  // The page was opened while the server cannot be reached (a tablet that woke up, a browser that restarted). If this device
  // is still signed in, carry on as the same person: they can keep selling offline. The server checks the sign-in again
  // as soon as it can be reached, and ends it then if it is no longer good.
  if (!s && client.signedIn) {
    const c = cachedMe();
    if (c) {
      client.assume(c);
      s = c;
    }
  } else if (s) saveMe(s);
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
  // The person's own language comes first, so the first screen is already right; it also follows a change made on another device.
  await new Promise<void>((done) => {
    feed('my_language', {}, (d) => {
      myLanguage = d.mine;
      followLanguage(d.effective);
      done();
    });
    setTimeout(done, 4000);
  });
  // Roles without the shop settings feed (IT) ask the server which language the shop uses.
  void client.deviceStatus().then((d) => followShopLanguage(d?.language));
  // The shop's own settings (currency, accepted payment methods, thresholds) come from the server, never from the page.
  if (s.role !== 'it') {
    await new Promise<void>((done) => {
      feed('shop_settings', {}, (d) => {
        shop = d;
        currency = d.currencyLabel;
        followShopLanguage(d.language);
        for (const l of shopListeners) l(d);
        done();
      });
      setTimeout(done, 4000);
    });
  }
  wireAccountChip();
  watchPlace();
  return s;
}

type ShopData = FeedMap['shop_settings']['data'];
let shop: ShopData | null = null;
let currency = '';
const shopListeners = new Set<(s: ShopData) => void>();

/** The shop's settings as last heard from the server, or null before they arrive. */
export function shopSettings(): ShopData | null {
  return shop;
}

/** Calls `fn` now (if the settings are known) and again whenever the owner changes them. */
export function onShop(fn: (s: ShopData) => void): void {
  shopListeners.add(fn);
  if (shop) fn(shop);
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
  const key = `${name}:${Math.random()}`;
  const saved = `cake-pos-feed:${name}:${JSON.stringify(params)}`;
  let heard = false;
  // What a till needs to keep selling (the catalogue and the shop's settings) is kept on the device. It is only shown when
  // the server has not answered within a moment, so a till that is online never works from a saved copy.
  const fallback = FEED_SAVED.has(name)
    ? setTimeout(() => {
        if (heard) return;
        try {
          const raw = localStorage.getItem(saved);
          if (raw) render(JSON.parse(raw) as FeedMap[K]['data']);
        } catch {
          /* nothing saved, or unreadable: the screen waits for the server */
        }
      }, 1500)
    : undefined;
  const stop = client.subscribe(name, params, (r) => {
    heard = heard || r.ok;
    if (r.ok && FEED_SAVED.has(name)) {
      try {
        localStorage.setItem(saved, JSON.stringify(r.data));
      } catch {
        /* storage full or blocked */
      }
    }
    if (r.ok) {
      lastError = '';
      loadFailures.delete(key);
      showLoadFailures();
      render(r.data);
    } else {
      const m = r.error.messages[0] ?? 'Something went wrong.';
      // Outside the fence the server only opens the lobby. That is shown by the lobby, not as a failure.
      if (m.startsWith(LOBBY_PREFIX)) {
        void checkPlace();
        return;
      }
      if (m !== lastError) toast(m);
      lastError = m;
      // A screen that could not load must say so on the screen, not only in a message that disappears.
      if (r.error.code !== 'unauthenticated') loadFailures.set(key, m);
      showLoadFailures();
    }
  });
  return () => {
    clearTimeout(fallback);
    stop();
  };
}

const FEED_SAVED = new Set<FeedName>(['catalogue_grid', 'shop_settings']);

/** Feeds that are failing right now, with the reason. While any are, a bar says so and offers to try again. */
const loadFailures = new Map<string, string>();
function showLoadFailures(): void {
  let el = document.getElementById('loaderr');
  if (!loadFailures.size) {
    if (el) el.hidden = true;
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'loaderr';
    el.setAttribute('role', 'alert');
    el.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:12px;z-index:59;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;font:600 13px system-ui,sans-serif;background:var(--risk,#b4452f);color:#fff;box-shadow:0 8px 24px #0004';
    el.innerHTML = '<span id="loaderr-t"></span><button id="loaderr-b" style="font:inherit;color:inherit;border:1px solid #fff8;border-radius:8px;padding:6px 12px;background:none;cursor:pointer">Try again</button>';
    document.body.appendChild(el);
    el.querySelector('#loaderr-b')!.addEventListener('click', () => location.reload());
  }
  el.hidden = false;
  const first = [...loadFailures.values()][0]!;
  el.querySelector('#loaderr-t')!.textContent = `Some information on this screen could not be loaded. ${first}`;
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

/** Is this browser registered? Null when the shop server cannot be reached. */
export function deviceStatus() {
  return client.deviceStatus();
}

/** Registers this browser with a one-time code. Returns the device's name, or the refusal in plain words. */
export async function pairDevice(code: string): Promise<{ name: string } | { error: string }> {
  const r = await client.pairDevice(code);
  return r.ok ? { name: r.name } : { error: r.messages[0] ?? 'Could not register this device.' };
}

export async function staff(): Promise<StaffSigninRow[]> {
  return client.staff();
}

/** Signs in and goes to the person's own page. Returns the refusal text when it fails. */
export async function signIn(userId: string, pin: string): Promise<string | null> {
  const r = await client.signIn(userId, pin);
  if (!r.ok) return r.messages[0] ?? 'Could not sign in.';
  saveMe(r.session);
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

/** Formats an amount the way the server's own labels do, for the few places a page shows a figure it just added up. */
export function money(n: number): string {
  return `${currency ? currency + ' ' : ''}${new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(Math.round(n) + 0)}`;
}

/** Formats a plain quantity (not money). */
export function num(n: number): string {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(n);
}

/* ---------- Parts every role page shares: announcements notice, requests and alerts ---------- */

const PART_CSS = `
/* A long word with no spaces (a pasted link, a slip of the keyboard) wraps instead of pushing the page sideways. */
body{overflow-wrap:anywhere}
.cx-ntc{display:grid;gap:8px;margin:0 0 10px}.cx-ntc[hidden]{display:none}
.cx-n{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;background:var(--cop-s);border:1px solid var(--cop);color:var(--ink);font-size:14px}
.cx-ntc>*{min-width:0}.cx-n>div:first-child{min-width:0;overflow-wrap:anywhere}.cx-n small{display:block;color:var(--mute)}.cx-n button{flex:none;min-height:38px;padding:0 14px;border-radius:10px;background:var(--cop);color:var(--on,#fff);font-weight:600;border:0;cursor:pointer;font:inherit}
.cx-r{display:grid;gap:10px}.cx-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.cx-c{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:14px;display:grid;gap:6px}.cx-c.me{border-left:3px solid var(--cop)}.cx-c.dim{opacity:.65}
.cx-t{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cx-t b{font-weight:600}.cx-m{color:var(--mute);font-size:12px}
.cx-k{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--paper);color:var(--mute);white-space:nowrap}.cx-k.cop{background:var(--cop-s);color:var(--cop)}.cx-k.risk{background:var(--risk-s);color:var(--risk)}.cx-k.ok{background:var(--sage-s);color:var(--sage)}
.cx-a{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.cx-b{min-height:40px;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit;font-weight:600;cursor:pointer}.cx-b.p{background:var(--cop);border-color:var(--cop);color:var(--on,#fff)}.cx-b.r{border-color:var(--risk);color:var(--risk)}.cx-b:disabled{opacity:.4;cursor:not-allowed}.cx-b[aria-pressed=true]{background:var(--cop);border-color:var(--cop);color:var(--on,#fff)}
.cx-ov{position:fixed;inset:0;background:#000a;display:grid;place-items:center;z-index:50;padding:16px}
.cx-d{background:var(--surf);color:var(--ink);border:1px solid var(--line);border-radius:18px;padding:20px;width:min(460px,100%);max-height:90dvh;overflow-y:auto}.cx-d h2{margin:0 0 8px;font:600 18px "Fraunces",Georgia,serif}
.cx-d label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}.cx-d input:not([type=checkbox]),.cx-d select,.cx-d textarea{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit}.cx-d textarea{padding:10px 12px;min-height:64px;resize:none}
.cx-g{display:flex;gap:6px;flex-wrap:wrap}.cx-e{color:var(--mute);margin:8px 0}
.cx-d h3{margin:18px 0 2px;font-size:14px;font-weight:700}.cx-d .cx-m{margin:2px 0}.cx-d hr{border:0;border-top:1px solid var(--line);margin:16px 0}
.cx-d .cx-row{display:flex;justify-content:space-between;gap:12px;align-items:center}.cx-d .cx-row h2{margin:0}
.xrole[role=button],.xnm[role=button],.who[role=button]{cursor:pointer}.xrole[role=button]:hover,.xnm[role=button]:hover,.who[role=button]:hover{opacity:.8}
.cx-lobby{position:fixed;inset:0;z-index:45;background:var(--bg);color:var(--ink);display:grid;place-items:center;padding:20px;overflow-y:auto}
.cx-lb{width:min(480px,100%);display:grid;gap:12px;text-align:center;justify-items:center}
.cx-lb h1{margin:0;font:600 26px "Fraunces",Georgia,serif}.cx-lb p{margin:0}
.cx-lb-mk{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;background:var(--cop);color:var(--on,#fff);font:600 26px "Fraunces",Georgia,serif}
.cx-lb .cx-a{justify-content:center}.cx-lb .cx-ntc{width:100%;text-align:left}
.cx-drv{display:grid;gap:10px}.cx-drv p{margin:0}.cx-drv .cx-m{font-size:13px}.cx-drv label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}.cx-drv input{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit}
.cx-ac{border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:var(--surf);display:grid;gap:6px}.cx-ac.off{opacity:.75}
.cx-ach{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.cx-ach b{overflow-wrap:anywhere;font-weight:600}
.cx-st{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;background:var(--paper);color:var(--mute);white-space:nowrap}.cx-st.ok{background:var(--sage-s,#5E72471c);color:var(--sage,#5E7247)}.cx-st.bad{background:var(--risk-s,#B4452F18);color:var(--risk,#B4452F)}.cx-st.cop{background:var(--cop-s,#C47F3D1f);color:var(--cop-d,#9A5F2A)}
.cx-pbar{height:6px;border-radius:999px;background:var(--paper);overflow:hidden}.cx-pbar i{display:block;height:100%;background:var(--cop)}.cx-pbar.hi i{background:var(--risk,#B4452F)}
.cx-bad{color:var(--risk,#B4452F);font-size:13px}
.cx-code{text-align:center;border:1px dashed var(--cop);border-radius:14px;padding:14px;background:var(--cop-s,#C47F3D1f)}.cx-code strong{display:block;font:700 28px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.14em;margin:8px 0}.cx-code a{color:var(--cop-d,#9A5F2A);font-weight:700;overflow-wrap:anywhere}
.cx-ac .cx-a{margin-top:2px}.cx-ac .cx-b{min-height:36px;padding:0 12px;font-size:13px}
`;

function partsCss(): void {
  if (document.getElementById('cx-css')) return;
  const s = document.createElement('style');
  s.id = 'cx-css';
  s.textContent = PART_CSS;
  document.head.appendChild(s);
}

const clock = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A small modal. Returns the element inside it and a function to close it. */
export function dialog(html: string): { el: HTMLElement; close: () => void } {
  partsCss();
  const ov = document.createElement('div');
  ov.className = 'cx-ov';
  ov.innerHTML = `<div class="cx-d" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) close();
  });
  document.body.appendChild(ov);
  return { el: ov.firstElementChild as HTMLElement, close };
}

/**
 * Shows what the owner has announced. Announcements that ask for it show an "I have read this" button.
 * Showing one counts as seeing it. Returns a function that stops it.
 */
export function mountNotice(el: HTMLElement): () => void {
  partsCss();
  el.classList.add('cx-ntc');
  const told = new Set<string>();
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ack]');
    if (!b) return;
    b.disabled = true;
    void send('announcements/acknowledge', { announcementId: b.dataset.ack! }).then((r) => {
      if (!r.ok) b.disabled = false;
    });
  });
  return feed('announcements', {}, (d) => {
    for (const a of d.rows) {
      if (!a.seenByMe && !told.has(a.announcementId)) {
        told.add(a.announcementId);
        void client.dispatch('announcements/mark_seen', { announcementId: a.announcementId });
      }
    }
    const rows = d.rows.slice(0, 3);
    el.hidden = rows.length === 0;
    el.innerHTML =
      rows
        .map(
          (a) =>
            `<div class="cx-n"><div>${esc(a.text)}<small>${esc(a.postedByName)} · ${esc(clock(a.createdAt))}</small></div>${a.needsAck ? `<button data-ack="${esc(a.announcementId)}">I have read this</button>` : ''}</div>`,
        )
        .join('') + (d.rows.length > 3 ? `<div class="cx-m">${d.rows.length - 3} more announcements</div>` : '');
  });
}

export interface RequestsCounts {
  /** Alerts not seen yet. */
  unseen: number;
  /** Requests waiting for this person to act. */
  needsYou: number;
}

/**
 * The requests and alerts list, with the new-request form. Every button is something the server says this person may do.
 * `visible` says whether the list is on screen: alerts and requests are marked seen only then. Returns `{ stop, shown }`;
 * call `shown()` when the list becomes visible.
 */
export function mountRequests(
  el: HTMLElement,
  opts: { visible: () => boolean; onCounts?: (c: RequestsCounts) => void },
): { stop: () => void; shown: () => void } {
  partsCss();
  type Inbox = FeedMap['request_inbox']['data'];
  type Alerts = FeedMap['alert_inbox']['data'];
  let inbox: Inbox | null = null;
  let alerts: Alerts | null = null;
  let filter: 'all' | 'alerts' | 'requests' | 'closed' = 'all';
  const told = new Set<string>();
  const pending = new Set<string>();

  const btn = (act: string, id: string, label: string, cls = '', choice?: string) =>
    `<button class="cx-b ${cls}" data-act="${act}" data-id="${esc(id)}" ${choice !== undefined ? `data-choice="${esc(choice)}"` : ''} ${pending.has(act + id + (choice ?? '')) ? 'disabled' : ''}>${esc(label)}</button>`;

  function render(): void {
    if (!inbox || !alerts) return;
    opts.onCounts?.({ unseen: alerts.unseen, needsYou: inbox.counts.needsYou });
    const open = inbox.rows.filter((r) => !r.final);
    const closed = inbox.rows.filter((r) => r.final);
    const parts: string[] = [];
    if (filter === 'all' || filter === 'alerts') {
      for (const a of alerts.open) {
        parts.push(`<div class="cx-c ${a.seen ? '' : 'me'}"><div class="cx-t"><span class="cx-k ${a.severity === 'critical' ? 'risk' : 'cop'}">${esc(a.kindLabel)}</span><b>${esc(a.title)}</b></div>
<div class="cx-m">${esc(clock(a.createdAt))}${a.acknowledgedByName ? ` · taken by ${esc(a.acknowledgedByName)}` : ''}</div><div>${esc(a.body)}</div>
<div class="cx-a">${a.can.acknowledge && !a.acknowledgedByName ? btn('ack', a.alertId, "I'm on it", 'p') : ''}${a.can.snooze ? btn('snooze', a.alertId, 'Hide for 4 hours') : ''}</div></div>`);
      }
    }
    if (filter === 'all' || filter === 'requests' || filter === 'closed') {
      for (const r of filter === 'closed' ? closed : open) {
        const acts = r.actions
          .map((a) =>
            a === 'acknowledge'
              ? btn('racknowledge', r.requestId, "I'll take it", 'p')
              : a === 'done'
                ? btn('rdone', r.requestId, 'Mark done')
                : a === 'confirm'
                  ? btn('rconfirm', r.requestId, 'Confirm it is fixed', 'p')
                  : a === 'reopen'
                    ? btn('rreopen', r.requestId, 'Not fixed')
                    : a === 'withdraw'
                      ? btn('rwithdraw', r.requestId, 'Take it back', 'r')
                      : (r.choices ?? []).map((c) => btn('rdecide', r.requestId, c, 'p', c)).join(''),
          )
          .join('');
        parts.push(`<div class="cx-c ${r.needsYou ? 'me' : ''} ${r.final ? 'dim' : ''}"><div class="cx-t"><span class="cx-k">${esc(r.category)}</span>${r.urgent ? '<span class="cx-k risk">Urgent</span>' : ''}<b>${esc(r.title)}</b><span class="cx-k ${r.final ? 'ok' : ''}">${esc(r.statusLabel)}</span></div>
<div class="cx-m">${r.mine ? 'You' : esc(r.from.name)} to ${esc(r.to.label)} · ${esc(clock(r.createdAt))}${r.takenByName ? ` · taken by ${esc(r.takenByName)}` : ''}${r.escalated ? ' · sent up to the owner' : ''}</div>
${r.body ? `<div>${esc(r.body)}</div>` : ''}${r.outcome ? `<div class="cx-m">Outcome: ${esc(r.outcome)}</div>` : ''}<div class="cx-a">${acts}</div></div>`);
      }
    }
    el.innerHTML = `<div class="cx-bar"><div class="seg">${(['all', 'alerts', 'requests', 'closed'] as const)
      .map((k) => `<button aria-pressed="${k === filter}" data-f="${k}">${{ all: 'All', alerts: 'Alerts', requests: 'Requests', closed: 'Closed' }[k]}</button>`)
      .join('')}</div><button class="cx-b p" data-act="new">New request</button></div><div class="cx-r">${parts.join('') || '<p class="cx-e">Nothing here.</p>'}</div>`;
    markSeen();
  }

  function markSeen(): void {
    if (!opts.visible() || !inbox || !alerts) return;
    const ids = alerts.open.filter((a) => !a.seen && !told.has(a.alertId)).map((a) => a.alertId);
    if (ids.length) {
      ids.forEach((i) => told.add(i));
      void client.dispatch('alerts/mark_seen', { alertIds: ids });
    }
    for (const r of inbox.rows) {
      if (r.forMe && r.status === 'sent' && !told.has(r.requestId)) {
        told.add(r.requestId);
        void client.dispatch('requests/mark_seen', { requestId: r.requestId });
      }
    }
  }

  async function run(act: string, id: string, choice?: string): Promise<void> {
    const key = act + id + (choice ?? '');
    pending.add(key);
    render();
    const calls: Record<string, () => ReturnType<typeof send>> = {
      ack: () => send('alerts/acknowledge', { alertId: id }),
      snooze: () => send('alerts/snooze', { alertId: id, hours: 4 }, 'Hidden for 4 hours.'),
      racknowledge: () => send('requests/acknowledge', { requestId: id }),
      rdone: () => send('requests/done', { requestId: id }, 'Marked done. They will be asked to confirm.'),
      rconfirm: () => send('requests/confirm', { requestId: id }, 'Closed. Thank you.'),
      rreopen: () => send('requests/reopen', { requestId: id }),
      rwithdraw: () => send('requests/withdraw', { requestId: id }, 'Taken back.'),
      rdecide: () => send('requests/decide', { requestId: id, choice: choice! }),
    };
    await calls[act]!();
    pending.delete(key);
    render();
  }

  function newRequest(): void {
    if (!inbox) return;
    const t = inbox.targets;
    let cat = '';
    const d = dialog(`<h2>New request</h2><label for="cx-to">To</label><select id="cx-to"><optgroup label="Role">${t.roles.map((r) => `<option value="role:${esc(r.role)}">${esc(r.label)}</option>`).join('')}</optgroup>${t.people.length ? `<optgroup label="Person">${t.people.map((p) => `<option value="user:${esc(p.userId)}">${esc(p.name)}</option>`).join('')}</optgroup>` : ''}</select>
<label>Category</label><div class="cx-g" id="cx-cat">${inbox.categories.map((c) => `<button class="cx-b" aria-pressed="false" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
<div id="cx-tagw" hidden><label for="cx-tag">Short tag</label><input id="cx-tag" maxlength="24" placeholder="e.g. Parking"></div>
<label for="cx-ti">What is the issue?</label><input id="cx-ti" maxlength="80"><label for="cx-bd">Details (optional)</label><textarea id="cx-bd"></textarea>
<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cx-ur" style="width:auto;min-height:0"> Urgent: shown first, and sent up to the owner sooner if nobody takes it</label>
<div class="cx-a" style="margin-top:14px;justify-content:flex-end"><button class="cx-b" id="cx-x">Cancel</button><button class="cx-b p" id="cx-go">Send request</button></div>`);
    const q = <T extends HTMLElement>(s: string) => d.el.querySelector<T>(s)!;
    q('#cx-cat').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      cat = b.dataset.c!;
      d.el.querySelectorAll('#cx-cat button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      q('#cx-tagw').hidden = cat !== 'Other';
    });
    q('#cx-x').onclick = d.close;
    q<HTMLButtonElement>('#cx-go').onclick = async () => {
      const [kind, val] = q<HTMLSelectElement>('#cx-to').value.split(':') as [string, string];
      const title = q<HTMLInputElement>('#cx-ti').value.trim();
      if (!cat) return toast('Pick a category.');
      if (!title) return toast('Say what the issue is.');
      const go = q<HTMLButtonElement>('#cx-go');
      go.disabled = true;
      const tag = q<HTMLInputElement>('#cx-tag').value.trim();
      const body = q<HTMLTextAreaElement>('#cx-bd').value.trim();
      const r = await send(
        'requests/send',
        {
          ...(kind === 'role' ? { toRole: val as Role } : { toUserId: val }),
          category: cat as IntentMap['requests/send']['category'],
          ...(cat === 'Other' && tag ? { tag } : {}),
          title,
          ...(body ? { body } : {}),
          urgent: q<HTMLInputElement>('#cx-ur').checked,
        },
        'Request sent.',
      );
      if (r.ok) {
        filter = 'all';
        d.close();
      } else go.disabled = false;
    };
    q<HTMLSelectElement>('#cx-to').focus();
  }

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const f = t.closest<HTMLElement>('[data-f]');
    if (f) {
      filter = f.dataset.f as typeof filter;
      render();
      return;
    }
    const b = t.closest<HTMLButtonElement>('[data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'new') newRequest();
    else void run(b.dataset.act!, b.dataset.id!, b.dataset.choice);
  });

  const stops = [
    feed('request_inbox', {}, (d) => {
      inbox = d;
      render();
    }),
    feed('alert_inbox', {}, (d) => {
      alerts = d;
      render();
    }),
  ];
  return { stop: () => stops.forEach((s) => s()), shown: markSeen };
}


/* ---------- My account: what every person can change about themselves ---------- */

const ROLE_NAME: Record<Role, string> = { owner: 'Owner', cashier: 'Cashier', baker: 'Baker', inventory: 'Inventory', it: 'IT' };
const LEVELS: Array<[string, string]> = [
  ['off', 'Off'],
  ['critical', 'Only critical alerts'],
  ['all', 'Every alert'],
];

function currentTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Opens the person's own settings. Every role gets the same sheet, from the name at the top of the page. */
export async function openAccount(): Promise<void> {
  const who = session;
  if (!who) return;
  const dev = await client.deviceStatus().catch(() => null);
  const setup = who.role === 'it' ? null : await client.feed('notification_setup', {}).then((r) => (r.ok ? r.data : null));
  const my = await client.feed('my_language', {}).then((r) => (r.ok ? r.data : null));
  const langPick = `<select id="cx-lg"><option value="en" ${my?.mine === 'en' ? 'selected' : ''}>English</option><option value="sw" ${my?.mine === 'sw' ? 'selected' : ''}>Kiswahili</option><option value="shop" ${my && !my.mine ? 'selected' : ''}>Same as the shop (${my?.shop === 'sw' ? 'Kiswahili' : 'English'})</option></select>`;
  const level = (name: string, cur: string) => `<select id="${name}">${LEVELS.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const d = dialog(`
    <div class="cx-row"><h2>My account</h2><button class="cx-b" data-x="close">Close</button></div>
    <p class="cx-m"><b>${esc(who.name)}</b>${who.name.toLowerCase().includes(ROLE_NAME[who.role].toLowerCase()) ? '' : ` · ${esc(ROLE_NAME[who.role])}`}</p>
    <p class="cx-m">This device: ${esc(dev?.name ?? 'Not registered')}</p>
    <h3>Change my PIN</h3>
    <label for="cx-pc">Current PIN</label><input id="cx-pc" type="password" inputmode="numeric" autocomplete="current-password" maxlength="6">
    <label for="cx-pn">New PIN (4 to 6 digits)</label><input id="cx-pn" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6">
    <label for="cx-pr">New PIN again</label><input id="cx-pr" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6">
    <div class="cx-a"><button class="cx-b p" data-x="pin">Change PIN</button></div>
    ${
      setup
        ? `<hr><h3>How I get alerts</h3><p class="cx-m">Alerts reach you in the app. You can also get them by text message or WhatsApp.</p>
    <label for="cx-ph">Phone number, with the country code</label><input id="cx-ph" inputmode="tel" placeholder="+255712345678" value="${esc(setup.me.phone ?? '')}">
    <label for="cx-sm">Text message</label>${level('cx-sm', setup.me.sms)}
    <label for="cx-wa">WhatsApp</label>${level('cx-wa', setup.me.whatsapp)}
    ${setup.notes.map((n) => `<p class="cx-m">${esc(n)}</p>`).join('')}
    <div class="cx-a"><button class="cx-b p" data-x="contact">Save contact details</button></div>`
        : ''
    }
    <hr><h3>Appearance</h3>
    <div class="cx-g" id="cx-th"><button class="cx-b" data-th="light" aria-pressed="${currentTheme() === 'light'}">Light</button><button class="cx-b" data-th="dark" aria-pressed="${currentTheme() === 'dark'}">Dark</button></div>
    <h3>Language</h3><p class="cx-m">Only your own screens change. Other people keep theirs.</p>
    <label for="cx-lg">Language I see on screen</label>${langPick}
    <hr><div class="cx-a"><button class="cx-b r" data-x="out">Sign out</button></div>`);
  const q = <T extends HTMLElement>(sel: string) => d.el.querySelector<T>(sel)!;
  d.el.addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.id !== 'cx-lg') return;
    const v = sel.value as 'en' | 'sw' | 'shop';
    sel.disabled = true;
    void send('auth/set_language', { language: v }, 'Language saved').then((r) => {
      sel.disabled = false;
      if (!r.ok) return;
      myLanguage = v === 'shop' ? null : v;
      followLanguage(v === 'shop' ? (my?.shop ?? 'en') : v);
    });
  });
  d.el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const th = t.closest<HTMLElement>('[data-th]');
    if (th) {
      document.documentElement.dataset.theme = th.dataset.th;
      try {
        localStorage.setItem('theme', th.dataset.th!);
      } catch {
        /* storage blocked: the choice lasts until the page closes */
      }
      d.el.querySelectorAll<HTMLElement>('[data-th]').forEach((b) => b.setAttribute('aria-pressed', String(b === th)));
      return;
    }
    const b = t.closest<HTMLButtonElement>('[data-x]');
    if (!b || b.disabled) return;
    const k = b.dataset.x;
    if (k === 'close') d.close();
    else if (k === 'out') void signOut();
    else if (k === 'pin') {
      const cur = q<HTMLInputElement>('#cx-pc').value;
      const nw = q<HTMLInputElement>('#cx-pn').value;
      if (!/^\d{4,6}$/.test(nw)) return toast('The new PIN must be 4 to 6 digits.');
      if (nw !== q<HTMLInputElement>('#cx-pr').value) return toast('The two new PINs do not match.');
      b.disabled = true;
      void send('auth/change_pin', { currentPin: cur, newPin: nw }, 'PIN changed').then((r) => {
        b.disabled = false;
        if (r.ok) for (const id of ['#cx-pc', '#cx-pn', '#cx-pr']) q<HTMLInputElement>(id).value = '';
      });
    } else if (k === 'contact') {
      b.disabled = true;
      const level = (id: string) => q<HTMLSelectElement>(id).value as 'off' | 'critical' | 'all';
      void send('staff/set_contact', { userId: who.userId, phone: q<HTMLInputElement>('#cx-ph').value.trim() || null, sms: level('#cx-sm'), whatsapp: level('#cx-wa') }, 'Contact details saved').then(() => {
        b.disabled = false;
      });
    }
  });
}

/** Builds the top bar and the menu of this page: the same for every role. Call it after `boot`. */
export function mountChrome(o: Omit<ChromeOptions, 'roleName'>): Chrome {
  const who = session!;
  return buildChrome(
    { ...o, roleName: ROLE_NAME[who.role] },
    { name: who.name, account: () => void openAccount(), signOut: () => void signOut(), onConnection: (fn) => client.onConnection(fn) },
  );
}

/** Makes the role chip and the name at the top of every page open My account. */
function wireAccountChip(): void {
  partsCss();
  for (const el of document.querySelectorAll<HTMLElement>('.xrole, .xnm, .who')) {
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'My account');
    el.title = 'My account';
    el.tabIndex = 0;
    el.addEventListener('click', () => void openAccount());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void openAccount();
      }
    });
  }
}

/* ---------- The location check: staff away from the shop get the lobby ---------- */

/** The server's refusal while someone is held in the lobby starts like this. */
const LOBBY_PREFIX = 'You are outside the shop';

type Away = { kind: 'far'; distanceM?: number } | { kind: 'vague' | 'denied' | 'unavailable' | 'timeout' };
let lobbyEl: HTMLElement | null = null;
let lobbyStop: (() => void) | null = null;
let placeBusy = false;

export function getPosition(): Promise<{ lat: number; lng: number; accuracyM: number } | { error: 'denied' | 'unavailable' | 'timeout' }> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ error: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      (e) => resolve({ error: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

function whyAway(a: Away): string {
  if (a.kind === 'far') {
    const d = a.distanceM;
    if (d === undefined) return 'You are not at the shop. Work screens open when you are at the shop.';
    return d >= 1000 ? `You are about ${(d / 1000).toFixed(1)} km from the shop. Work screens open when you are at the shop.` : `You are about ${d} m from the shop. Work screens open when you are at the shop.`;
  }
  if (a.kind === 'vague') return 'This device cannot tell where it is accurately enough. Move near a window or switch on precise location, then check again.';
  if (a.kind === 'denied') return 'Location is switched off for this page. Allow location for this site in the browser settings, then check again.';
  if (a.kind === 'timeout') return 'Finding the location took too long. Check again in a moment.';
  return 'This device cannot share its location, so it cannot open the work screens. Ask the owner.';
}

function showLobby(a: Away): void {
  partsCss();
  if (!lobbyEl) {
    const el = document.createElement('div');
    el.id = 'cx-lobby';
    el.className = 'cx-lobby';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'cx-lb-t');
    el.innerHTML = `<div class="cx-lb"><div class="cx-lb-mk">C</div><p class="cx-m" id="cx-lb-shop"></p><h1 id="cx-lb-t">You are outside the shop</h1><p id="cx-lb-why"></p>
      <div class="cx-ntc" id="cx-lb-n" hidden></div>
      <div class="cx-a"><button class="cx-b p" id="cx-lb-again">Check again</button><button class="cx-b" id="cx-lb-acct">My account</button><button class="cx-b" id="cx-lb-out">Sign out</button></div>
      <p class="cx-m">The shop has turned on a location check. Your PIN and the announcements stay available here.</p></div>`;
    document.body.appendChild(el);
    el.querySelector('#cx-lb-again')!.addEventListener('click', () => void checkPlace());
    el.querySelector('#cx-lb-acct')!.addEventListener('click', () => void openAccount());
    el.querySelector('#cx-lb-out')!.addEventListener('click', () => void signOut());
    lobbyEl = el;
    lobbyStop = mountNotice(el.querySelector<HTMLElement>('#cx-lb-n')!);
  }
  lobbyEl.querySelector('#cx-lb-shop')!.textContent = shop?.shopName ?? '';
  lobbyEl.querySelector('#cx-lb-why')!.textContent = whyAway(a);
}

function hideLobby(): void {
  lobbyStop?.();
  lobbyEl?.remove();
  lobbyEl = null;
  lobbyStop = null;
}

/** Asks this device where it is, tells the server, and shows or hides the lobby by the answer. */
async function checkPlace(): Promise<void> {
  if (placeBusy) return;
  const check = shop?.locationCheck;
  if (!session || session.role === 'owner' || session.role === 'it' || !check?.enabled) {
    hideLobby();
    return;
  }
  if (offline) return; // a till that cannot reach the server keeps working; the server decides once it can be reached
  placeBusy = true;
  const again = document.getElementById('cx-lb-again');
  if (again) again.textContent = 'Checking…';
  try {
    const p = await getPosition();
    if ('error' in p) return showLobby({ kind: p.error });
    const r = await client.dispatch('session/report_place', { lat: p.lat, lng: p.lng, accuracyM: Math.round(p.accuracyM) });
    if (!r.ok) return;
    const d = r.data as { inside: boolean; distanceM: number; reason?: 'far' | 'vague' };
    if (d.inside) hideLobby();
    else showLobby(d.reason === 'vague' ? { kind: 'vague' } : { kind: 'far', distanceM: d.distanceM });
  } finally {
    placeBusy = false;
    const b = document.getElementById('cx-lb-again');
    if (b) b.textContent = 'Check again';
  }
}

/** Keeps the position fresh while a page is open: now, every couple of minutes, and whenever the page comes back to the front. */
function watchPlace(): void {
  if (!session || session.role === 'owner' || session.role === 'it') return;
  onShop(() => void checkPlace());
  setInterval(() => {
    if (!document.hidden) void checkPlace();
  }, 120_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkPlace();
  });
}


/* ---------- Google accounts: the same panel on the Owner Settings screen and on the IT page ---------- */

const DRIVE_STATE: Record<string, [string, string]> = {
  ok: ['Working', 'ok'],
  full: ['Full', 'bad'],
  needs_signin: ['Sign in again', 'bad'],
  unreachable: ['Cannot reach Google', 'cop'],
  error: ['Problem', 'bad'],
  paused: ['Paused', ''],
  unknown: ['Not checked yet', ''],
};

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(n >= 10_737_418_240 ? 0 : 1)} GB`;
  if (n >= 1_048_576) return `${Math.round(n / 1_048_576)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

type DriveData = FeedMap['drive_accounts']['data'];
let driveStop: (() => void) | null = null;

/** Stops the Google accounts panel that is showing, if any. */
export function unmountDrive(): void {
  driveStop?.();
  driveStop = null;
}

/**
 * Shows the shop's Google accounts inside `el` and keeps them fresh. Only one is shown at a time.
 * Owner and IT use it to sign accounts in (by a code typed on google.com/device), reorder them, pause, check and disconnect them.
 */
export function mountDrive(el: HTMLElement): () => void {
  unmountDrive();
  partsCss();
  let data: DriveData | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const dismissed = new Set<string>();
  el.classList.add('cx-drv');
  const q = (sel: string) => el.querySelector<HTMLInputElement>(sel);

  function render(): void {
    if (!data) {
      el.innerHTML = '<p class="cx-m">Loading…</p>';
      return;
    }
    const d = data;
    // Keep what someone is typing while the panel refreshes itself.
    const typed = { id: q('[data-k="gid"]')?.value ?? '', secret: q('[data-k="gsec"]')?.value ?? '' };
    const focus = document.activeElement instanceof HTMLElement ? (document.activeElement.dataset.k ?? null) : null;
    if (!d.available) {
      el.innerHTML = '<p class="cx-m">Google Drive is not available on this server.</p>';
      return;
    }
    const waiting = d.connect?.state === 'waiting';
    const accounts = d.accounts
      .map((a) => {
        const [label, tone] = DRIVE_STATE[a.state] ?? DRIVE_STATE.unknown!;
        const pct = a.limitBytes && a.usedBytes !== null ? Math.min(100, Math.round((a.usedBytes / a.limitBytes) * 100)) : null;
        const usage =
          a.usedBytes === null
            ? ''
            : a.limitBytes
              ? `<div class="cx-pbar ${pct! >= 90 ? 'hi' : ''}" role="img" aria-label="${pct}%"><i style="width:${pct}%"></i></div><p class="cx-m"><span>${fmtBytes(a.usedBytes)}</span> <span>of</span> <span>${fmtBytes(a.limitBytes)}</span> <span>used</span></p>`
              : `<p class="cx-m"><span>${fmtBytes(a.usedBytes)}</span> <span>used</span></p>`;
        const last = d.accounts.length;
        return `<div class="cx-ac ${a.state === 'paused' ? 'off' : ''}" data-id="${esc(a.id)}">
          <div class="cx-ach"><b>${a.position} · ${esc(a.email ?? a.id)}</b><span class="cx-st ${tone}">${label}</span></div>
          ${usage}${a.problem ? `<p class="cx-bad">${esc(a.problem)}</p>` : ''}
          <div class="cx-a">
            <button class="cx-b" data-x="up" ${a.position === 1 ? 'disabled' : ''} aria-label="Use earlier" title="Use earlier">↑</button>
            <button class="cx-b" data-x="down" ${a.position === last ? 'disabled' : ''} aria-label="Use later" title="Use later">↓</button>
            <button class="cx-b" data-x="pause" data-p="${a.state === 'paused' ? '0' : '1'}">${a.state === 'paused' ? 'Resume' : 'Pause'}</button>
            <button class="cx-b" data-x="test">Check</button>
            ${a.state === 'needs_signin' ? '<button class="cx-b p" data-x="signin" ' + (waiting ? 'disabled' : '') + '>Sign in again</button>' : ''}
            <button class="cx-b r" data-x="remove" data-e="${esc(a.email ?? a.id)}">Disconnect</button>
          </div>
        </div>`;
      })
      .join('');
    let connect = '';
    const c = d.connect;
    if (c?.state === 'waiting') {
      const mins = Math.max(1, Math.round((Date.parse(c.expiresAt ?? '') - Date.now()) / 60000));
      connect = `<div class="cx-code"><p>On your phone or any computer, open</p><a href="${esc(c.url ?? '')}" target="_blank" rel="noopener">${esc(c.url ?? '')}</a><p>and enter this code</p><strong>${esc(c.userCode ?? '')}</strong><p class="cx-m">Sign in with the Google account to add, then press Allow. The code works for about ${Number.isFinite(mins) ? mins : 10} more minutes.</p><div class="cx-a" style="justify-content:center"><button class="cx-b" data-x="cancel">Cancel</button></div></div>`;
    } else if (c && !dismissed.has(c.at)) {
      connect = `<div class="cx-ac"><p class="${c.state === 'failed' ? 'cx-bad' : ''}">${c.state === 'done' ? '✓ ' : ''}${esc(c.message ?? '')}</p><div class="cx-a"><button class="cx-b" data-x="dismiss" data-at="${esc(c.at)}">OK</button></div></div>`;
    }
    const setup = d.clientReady
      ? `<div class="cx-a"><button class="cx-b p" data-x="add" ${waiting ? 'disabled' : ''}>${d.accounts.length ? 'Add another Google account' : 'Add a Google account'}</button></div>`
      : `<div class="cx-ac"><b>Set up Google first</b>
          <p class="cx-m">This is done once, by someone comfortable with the Google Cloud Console (IT): make a project, switch on the Google Drive API, publish the consent screen, and create an OAuth client of the type "TVs and Limited Input devices". Then paste its two values here.</p>
          <label for="cx-gid">Client ID</label><input id="cx-gid" data-k="gid" autocomplete="off" spellcheck="false">
          <label for="cx-gsec">Client secret</label><input id="cx-gsec" data-k="gsec" type="password" autocomplete="off" spellcheck="false">
          <div class="cx-a"><button class="cx-b p" data-x="client">Save</button></div></div>`;
    el.innerHTML = `${d.problem ? `<p class="cx-bad">${esc(d.problem)}</p>` : ''}
      <p class="cx-m">Backups, and old orders when the database fills up, are copied to Google Drive. Accounts are used in order: when one is full or stops working, the next one takes over by itself.</p>
      ${d.accounts.length ? accounts : '<p class="cx-m">No Google account is connected yet. Everything stays on the shop computer until one is.</p>'}
      ${connect}${setup}
      <p class="cx-m">Files go in the folder "${esc(d.folderName)}" of each account. Only files this app made are visible to it.</p>`;
    if (typed.id) q('[data-k="gid"]')!.value = typed.id;
    if (typed.secret) q('[data-k="gsec"]')!.value = typed.secret;
    if (focus) q(`[data-k="${focus}"]`)?.focus();
  }

  async function pull(): Promise<void> {
    const r = await client.feed('drive_accounts', {}).catch(() => null);
    if (stopped) return;
    if (r?.ok) {
      data = r.data;
      render();
    }
    clearTimeout(timer);
    // Quick while a code is waiting to be typed, slow otherwise.
    timer = setTimeout(() => void pull(), data?.connect?.state === 'waiting' ? 3000 : 20_000);
  }

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-x]');
    if (!b || b.disabled) return;
    const id = b.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
    const x = b.dataset.x;
    const run = async (fn: () => Promise<unknown>) => {
      b.disabled = true;
      try {
        await fn();
      } finally {
        await pull();
      }
    };
    if (x === 'dismiss') {
      dismissed.add(b.dataset.at ?? '');
      render();
    } else if (x === 'client') {
      const clientId = q('[data-k="gid"]')?.value.trim() ?? '';
      const clientSecret = q('[data-k="gsec"]')?.value.trim() ?? '';
      if (!clientId || !clientSecret) return toast('Paste both the client ID and the client secret.');
      void run(async () => {
        const r = await send('drive/save_client', { clientId, clientSecret }, 'Google details saved');
        if (r.ok) {
          q('[data-k="gid"]')!.value = '';
          q('[data-k="gsec"]')!.value = '';
        }
      });
    } else if (x === 'add' || x === 'signin') void run(() => send('drive/connect_start', {}));
    else if (x === 'cancel') void run(() => send('drive/connect_cancel', {}));
    else if (x === 'up' || x === 'down') void run(() => send('drive/move_account', { accountId: id, direction: x }));
    else if (x === 'pause') void run(() => send('drive/pause_account', { accountId: id, paused: b.dataset.p === '1' }));
    else if (x === 'test') void run(() => send('drive/test', { accountId: id }, 'Checked'));
    else if (x === 'remove') {
      if (!confirm(`Disconnect ${b.dataset.e}? Copies already in that Google Drive stay there, and the server stops using the account. To remove the app's access completely, also remove it in that Google account's security settings.`)) return;
      void run(() => send('drive/remove_account', { accountId: id }, 'Account disconnected'));
    }
  });

  render();
  void pull();
  driveStop = () => {
    stopped = true;
    clearTimeout(timer);
    el.innerHTML = '';
  };
  return unmountDrive;
}
