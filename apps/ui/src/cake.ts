/**
 * The one script every page loads. It signs people in, reads feeds, sends intents and shows the connection state.
 * It holds no shop logic (BR-22): pages show what a feed says and send what a person taps.
 */
import { createClient, localStorageTokenStore } from '@cake-pos/client';
import type { ClientResult, FeedMap, FeedName, IntentMap, IntentName, Role, SessionInfo, StaffSigninRow } from '@cake-pos/client';

const client = createClient({ tokenStore: localStorageTokenStore(), deviceStore: localStorageTokenStore('cake-pos-device') });

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
  // The shop's own settings (currency, accepted payment methods, thresholds) come from the server, never from the page.
  if (s.role !== 'it') {
    await new Promise<void>((done) => {
      feed('shop_settings', {}, (d) => {
        shop = d;
        currency = d.currencyLabel;
        for (const l of shopListeners) l(d);
        done();
      });
      setTimeout(done, 4000);
    });
  }
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
  return client.subscribe(name, params, (r) => {
    if (r.ok) {
      lastError = '';
      loadFailures.delete(key);
      showLoadFailures();
      render(r.data);
    } else {
      const m = r.error.messages[0] ?? 'Something went wrong.';
      if (m !== lastError) toast(m);
      lastError = m;
      // A screen that could not load must say so on the screen, not only in a message that disappears.
      if (r.error.code !== 'unauthenticated') loadFailures.set(key, m);
      showLoadFailures();
    }
  });
}

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
.cx-ntc{display:grid;gap:8px;margin:0 0 10px}.cx-ntc[hidden]{display:none}
.cx-n{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;background:var(--cop-s);border:1px solid var(--cop);color:var(--ink);font-size:14px}
.cx-n small{display:block;color:var(--mute)}.cx-n button{flex:none;min-height:38px;padding:0 14px;border-radius:10px;background:var(--cop);color:var(--on,#fff);font-weight:600;border:0;cursor:pointer;font:inherit}
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
