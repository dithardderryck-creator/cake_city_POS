/**
 * The top bar and the menu, built once for every role.
 *
 * The bar is the same on every page: the logo, the connection dot, search, the bell and the menu button. Everything else lives in the menu,
 * in groups (the pages of the role, then the person's own account, then sign out). A page only says which pages it has and how to open them.
 */

export interface ChromeItem {
  /** The page it opens; also what `setPage` highlights. */
  id: string;
  label: string;
  /** Items that are not a page (the shop settings sheet) run this instead of `go`. */
  run?: () => void;
}
export interface ChromeGroup {
  title: string;
  items: ChromeItem[];
}
export interface ChromeOptions {
  /** The empty element the bar is built into. Defaults to the page's `.xhead`. */
  host?: HTMLElement;
  roleName: string;
  groups: ChromeGroup[];
  go: (id: string) => void;
  /** Opens the search of this page. No search button when left out. */
  search?: () => void;
  /** The page the bell opens. No bell when left out. */
  bell?: string;
  /** The alert sound switch of the roles that have one. */
  sound?: { get: () => boolean; set: (on: boolean) => void };
  /** The page sets the connection text itself (the till says more than "unreachable"). */
  ownStatus?: boolean;
}
export interface ChromeEnv {
  name: string;
  account: () => void;
  signOut: () => void;
  onConnection: (fn: (state: string) => void) => void;
}
export interface Chrome {
  /** Highlights the page the person is on (null for none). */
  setPage: (id: string | null) => void;
  /** The number on the bell and on the page the bell opens. */
  setBadge: (n: number) => void;
  ring: () => void;
  /** The number beside one menu item (open tickets, say). */
  setItemBadge: (id: string, n: number) => void;
  setStatus: (up: boolean, text: string) => void;
  openMenu: () => void;
  closeMenu: () => void;
}

const CSS = `
.xhead{position:sticky;top:0;z-index:12;background:var(--bg);padding-top:env(safe-area-inset-top,0px)}
.xtop{display:flex;align-items:center;gap:12px;padding:10px clamp(16px,3vw,40px) 6px;max-width:1260px;margin:0 auto}
.brand{font:600 20px Fraunces,serif;margin:0}.brand i{font-style:normal;color:var(--cop)}
.xtop .brand{flex:none;display:flex;align-items:center;gap:8px}
.xmk{display:none;width:36px;height:36px;border-radius:50%;background:var(--cop);color:#fff;place-items:center;font:600 17px Fraunces,serif}
.xpw{flex:1 1 0;min-width:0;display:flex;justify-content:flex-end}
.xpill{display:flex;flex-wrap:nowrap;align-items:center;gap:2px;padding:3px 5px;max-width:100%;border:1px solid var(--line);border-radius:999px;background:var(--surf);box-shadow:var(--sh)}
.xpill>*{flex:none}
.xst{position:relative;display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%}
.xst i{display:block;width:12px;height:12px;border-radius:50%;background:var(--sage);box-shadow:0 0 0 6px var(--sage-s)}
.xst.off i{background:var(--risk);box-shadow:0 0 0 6px var(--risk-s)}
.xsl{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.xib{width:44px;height:44px;border-radius:50%;border:0;background:none;display:inline-grid;place-items:center;color:var(--mute);position:relative;transition:background .3s,color .3s}
.xib:hover,.xib[aria-expanded="true"]{background:var(--cop-s);color:var(--ink)}
.xib svg{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.xbd{position:absolute;top:2px;right:2px;min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--cop);color:#fff;font-size:11px;font-weight:600;display:inline-grid;place-items:center}
.xbd:empty{display:none}
.xib.ring svg{animation:xring 1.2s ease;transform-origin:50% 10%}
@keyframes xring{0%,100%{transform:rotate(0)}15%{transform:rotate(14deg)}30%{transform:rotate(-12deg)}45%{transform:rotate(9deg)}60%{transform:rotate(-6deg)}}
@media(max-width:480px){.xtop .brand .xtx{display:none}.xmk{display:grid}}
@media(max-width:359px){.xpill .xib,.xst{width:38px;height:38px}}
.xmn[hidden]{display:none}
.xmn{position:fixed;inset:0;z-index:40}
.xsc{position:absolute;inset:0;background:#1f1a1361}
.xpn{position:absolute;top:var(--xt,64px);left:8px;right:8px;max-height:calc(100dvh - var(--xt,64px) - 12px);overflow-y:auto;overscroll-behavior:contain;background:var(--surf);border:1px solid var(--line);border-radius:20px;box-shadow:0 24px 60px -18px #0006;padding-bottom:6px;animation:xpop .28s cubic-bezier(.32,.72,0,1)}
@keyframes xpop{from{opacity:0;transform:translateY(-8px) scale(.985)}}
@media(min-width:720px){.xpn{left:auto;right:clamp(16px,3vw,40px);width:360px}}
@media(prefers-reduced-motion:reduce){.xpn{animation:none}}
.xmn button{font:inherit;color:inherit;cursor:pointer}
.xacct{width:100%;min-height:72px;padding:10px 18px;display:flex;align-items:center;gap:12px;border:0;border-bottom:1px solid var(--line);background:none;text-align:left}
.xacct:hover,.xmi:hover{background:var(--paper)}
.xav{width:44px;height:44px;border-radius:50%;background:var(--cop-s);color:var(--cop-d);display:grid;place-items:center;flex:none}
.xav svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.xwho{flex:1 1 auto;min-width:0;display:grid;line-height:1.3}
.xnm{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xsub{font-size:13px;color:var(--mute)}
.xchev{width:18px;height:18px;flex:none;fill:none;stroke:var(--mute);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.xgt{margin:0;padding:14px 18px 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.xmi{width:100%;min-height:48px;padding:0 18px;display:flex;align-items:center;justify-content:space-between;gap:10px;border:0;background:none;font-size:16px;text-align:left}
.xmi[aria-current]{background:var(--cop-s);font-weight:600}
.xmb{min-width:22px;height:22px;padding:0 7px;border-radius:11px;background:var(--cop-d);color:#fff;font-size:12px;font-weight:600;display:inline-grid;place-items:center}
.xmb:empty{display:none}
.xfoot{margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
.xmi svg{width:20px;height:20px;flex:none;fill:none;stroke:var(--mute);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.xmi .xst2{font-size:13px;color:var(--mute);font-weight:400}
`;

const ICON = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 1.5h-15zM10 21h4"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
  chev: '<svg class="xchev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6v14h4M14 8l4 4-4 4M18 12H9"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>',
};

const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function buildChrome(o: ChromeOptions, env: ChromeEnv): Chrome {
  if (!document.getElementById('cx-chrome')) {
    const s = document.createElement('style');
    s.id = 'cx-chrome';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const host = o.host ?? document.querySelector<HTMLElement>('.xhead')!;
  const groupsHtml = o.groups
    .map(
      (g, gi) => `<div role="group" aria-labelledby="xg${gi}"><p class="xgt" id="xg${gi}">${esc(g.title)}</p>${g.items
        .map((it) => `<button class="xmi" data-id="${esc(it.id)}"><span>${esc(it.label)}</span><b class="xmb" data-bd="${esc(it.id)}"></b></button>`)
        .join('')}</div>`,
    )
    .join('');
  host.innerHTML = `
<div class="xtop">
<div class="brand"><span class="xmk" aria-hidden="true">C</span><span class="xtx">Cake <i>POS</i></span></div>
<div class="xpw"><div class="xpill" role="group" aria-label="Session">
<span class="xst" id="net" role="img" aria-label="Server connected" title="Server connected"><i></i><span class="xsl">Server connected</span></span>
${o.search ? `<button class="xib" id="xsearch" aria-label="Search" title="Search (Ctrl K)">${ICON.search}</button>` : ''}
${o.bell ? `<button class="xib" id="xbell" aria-label="Requests and alerts" title="Requests and alerts">${ICON.bell}<b class="xbd" id="xbn"></b></button>` : ''}
<button class="xib" id="xmenu" aria-label="Menu" title="Menu" aria-haspopup="dialog" aria-expanded="false" aria-controls="xmn">${ICON.menu}</button>
</div></div>
</div>
<div class="xmn" id="xmn" hidden>
<div class="xsc" data-close></div>
<div class="xpn" role="dialog" aria-label="Menu">
<button class="xacct" data-acct><span class="xav" aria-hidden="true">${ICON.person}</span><span class="xwho"><span class="xnm"></span><span class="xsub"><span class="xrole"></span> · <span>My account</span></span></span>${ICON.chev}</button>
${groupsHtml}
<div class="xfoot">
${o.sound ? `<button class="xmi" data-snd aria-pressed="false"><span>Sound and vibration alerts</span><span class="xst2" data-sndv></span></button>` : ''}
<button class="xmi" data-out id="xout"><span>Sign out</span>${ICON.out}</button>
</div>
</div>
</div>`;
  const $ = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  host.querySelector('.xnm')!.textContent = env.name;
  // "Amina (Owner)" already says the role, so it is not said twice.
  const roleSaid = env.name.toLowerCase().includes(o.roleName.toLowerCase());
  host.querySelector('.xrole')!.textContent = roleSaid ? '' : o.roleName;
  if (roleSaid) host.querySelector('.xsub')!.innerHTML = '<span class="xrole" hidden></span><span>My account</span>';
  const menu = $<HTMLElement>('#xmn');
  const btn = $<HTMLButtonElement>('#xmenu');
  const items = new Map<string, ChromeItem>(o.groups.flatMap((g) => g.items).map((i) => [i.id, i]));

  let isOpen = false;
  const focusables = () => [...menu.querySelectorAll<HTMLElement>('button')];
  const closeMenu = (back = true) => {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = ICON.menu;
    btn.setAttribute('aria-label', 'Menu');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey, true);
    if (back) btn.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      const f = focusables();
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const openMenu = () => {
    if (isOpen) return;
    isOpen = true;
    // The panel hangs from the bottom of the bar, wherever the page is scrolled to.
    menu.style.setProperty('--xt', `${Math.round(host.getBoundingClientRect().bottom + 6)}px`);
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.innerHTML = ICON.close;
    btn.setAttribute('aria-label', 'Close menu');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    $<HTMLElement>('[data-acct]').focus();
  };
  btn.addEventListener('click', () => (isOpen ? closeMenu() : openMenu()));

  const syncSound = () => {
    if (!o.sound) return;
    const on = o.sound.get();
    const b = $<HTMLElement>('[data-snd]');
    b.setAttribute('aria-pressed', String(on));
    $<HTMLElement>('[data-sndv]').textContent = on ? 'On' : 'Off';
  };
  syncSound();

  menu.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) return closeMenu();
    if (t.closest('[data-acct]')) {
      closeMenu(false);
      return env.account();
    }
    if (t.closest('[data-out]')) {
      closeMenu(false);
      return env.signOut();
    }
    if (t.closest('[data-snd]')) {
      o.sound!.set(!o.sound!.get());
      return syncSound();
    }
    const mi = t.closest<HTMLElement>('[data-id]');
    if (!mi) return;
    const it = items.get(mi.dataset.id!)!;
    closeMenu(false);
    if (it.run) it.run();
    else o.go(it.id);
  });
  if (o.search) $<HTMLElement>('#xsearch').addEventListener('click', o.search);
  if (o.bell) $<HTMLElement>('#xbell').addEventListener('click', () => o.go(o.bell!));

  const chrome: Chrome = {
    setPage(id) {
      menu.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => (b.dataset.id === id ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    },
    setBadge(n) {
      const bn = host.querySelector<HTMLElement>('#xbn');
      if (bn) bn.textContent = n ? String(n) : '';
      const bell = host.querySelector<HTMLElement>('#xbell');
      if (bell) bell.title = n ? `${n} need you` : 'Requests and alerts';
      if (o.bell) host.querySelectorAll<HTMLElement>(`[data-bd="${CSS_ESC(o.bell)}"]`).forEach((b) => (b.textContent = n ? String(n) : ''));
    },
    setItemBadge(id, n) {
      host.querySelectorAll<HTMLElement>(`[data-bd="${CSS_ESC(id)}"]`).forEach((b) => (b.textContent = n ? String(n) : ''));
    },
    ring() {
      const b = host.querySelector<HTMLElement>('#xbell');
      if (!b) return;
      b.classList.remove('ring');
      void b.offsetWidth;
      if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
      b.classList.add('ring');
      setTimeout(() => b.classList.remove('ring'), 1400);
    },
    setStatus(up, text) {
      const el = $<HTMLElement>('#net');
      el.className = 'xst' + (up ? '' : ' off');
      el.setAttribute('aria-label', text);
      el.title = text;
      $<HTMLElement>('.xsl').textContent = text;
    },
    openMenu,
    closeMenu: () => closeMenu(false),
  };
  if (!o.ownStatus) env.onConnection((s) => chrome.setStatus(s !== 'offline', s !== 'offline' ? 'Server connected' : 'Server unreachable'));
  return chrome;
}

const CSS_ESC = (s: string): string => s.replace(/["\\]/g, '\\$&');
