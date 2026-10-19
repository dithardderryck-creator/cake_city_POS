/**
 * Showing the screens in Kiswahili while the server stays in English.
 *
 * Everything the server sends and every page is written in English. When the shop's language is Kiswahili this file
 * translates what is on the screen: text, placeholders, tooltips, dialogs and dates. Words with no translation stay in English,
 * so a missing translation is never a broken screen. Nothing here touches what is sent to the server or what it stores.
 *
 * The Kiswahili words live in `lang-sw.js` (built from `src/lang/sw.ts`) and are only fetched when the language is Kiswahili.
 * An entry is a sentence with `{n}` for a number and `{*}` for any text (which is translated too), so one entry covers
 * "3 in stock", "12 in stock" and so on.
 */

export type Lang = 'en' | 'sw';
export type Entries = Record<string, string>;

const KEY = 'cake-pos-lang';

let lang: Lang = 'en';
let entries: Entries | null = null;
let exact = new Map<string, string>();
let templates: Array<{ re: RegExp; to: string }> = [];
const memo = new Map<string, string>();
const listeners = new Set<(l: Lang) => void>();

/** Strings with no translation, kept when `?collect` mode is on (used by the tests to see what is missing). */
const missed = new Set<string>();
let collecting = false;

const NUM = /\d[\d,.:]*/g;

function compile(e: Entries) {
  exact = new Map();
  templates = [];
  for (const [from, to] of Object.entries(e)) {
    if (!from.includes('{*}')) {
      exact.set(from, to);
      continue;
    }
    const src = from
      .split(/(\{\*\}|\{n\})/)
      .map((part) => (part === '{*}' ? '(.+?)' : part === '{n}' ? '(\\d[\\d,.:]*)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    templates.push({ re: new RegExp('^' + src + '$', 's'), to });
  }
  // Longer (more specific) templates first.
  templates.sort((a, b) => b.re.source.length - a.re.source.length);
  memo.clear();
}

const MONTHS: Record<string, string> = { Jan: 'Jan', Feb: 'Feb', Mar: 'Mac', Apr: 'Apr', May: 'Mei', Jun: 'Jun', Jul: 'Jul', Aug: 'Ago', Sep: 'Sep', Oct: 'Okt', Nov: 'Nov', Dec: 'Des', January: 'Januari', February: 'Februari', March: 'Machi', April: 'Aprili', June: 'Juni', July: 'Julai', August: 'Agosti', September: 'Septemba', October: 'Oktoba', November: 'Novemba', December: 'Desemba' };
const DAYS: Record<string, string> = { Mon: 'Jtatu', Tue: 'Jnne', Wed: 'Jtano', Thu: 'Alh', Fri: 'Iju', Sat: 'Jmosi', Sun: 'Jpili', Monday: 'Jumatatu', Tuesday: 'Jumanne', Wednesday: 'Jumatano', Thursday: 'Alhamisi', Friday: 'Ijumaa', Saturday: 'Jumamosi', Sunday: 'Jumapili' };
const MONTH_RE = '(' + Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|') + ')';
const DAY_RE = '(' + Object.keys(DAYS).sort((a, b) => b.length - a.length).join('|') + ')';
const DATE_A = new RegExp(`\\b(\\d{1,2}) ${MONTH_RE}\\b`, 'g'); // 17 October
const DATE_B = new RegExp(`\\b${MONTH_RE} (\\d{1,2})\\b`, 'g'); // Oct 17
const DAY_A = new RegExp(`\\b${DAY_RE}(?=[ ,·.]*(?:\\d|$))`, 'g'); // Saturday 17 / Saturday,

function dates(s: string): string {
  return s
    .replace(DATE_A, (_m, d: string, mo: string) => `${d} ${MONTHS[mo]}`)
    .replace(DATE_B, (_m, mo: string, d: string) => `${MONTHS[mo]} ${d}`)
    .replace(DAY_A, (_m, d: string) => DAYS[d] ?? d);
}

/** Translates one piece of text. The spaces around it are kept. Returns it unchanged when nothing matches. */
export function tr(text: string): string {
  if (lang === 'en' || !entries || !text) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const core = m[2]!;
  if (!core) return text;
  const hit = memo.get(core);
  if (hit !== undefined) return m[1] + hit + m[3];
  const out = translateCore(core);
  if (memo.size > 5000) memo.clear();
  memo.set(core, out);
  return m[1] + out + m[3];
}

function translateCore(core: string): string {
  const direct = exact.get(core);
  if (direct !== undefined) return direct;
  // Numbers become {n}, so "3 in stock" is found as "{n} in stock".
  const nums: string[] = [];
  const shape = core.replace(NUM, (n) => {
    nums.push(n);
    return '{n}';
  });
  if (nums.length) {
    const viaShape = exact.get(shape);
    if (viaShape !== undefined) return fill(viaShape, nums);
  }
  for (const t of templates) {
    const x = t.re.exec(core);
    if (x) return fill(t.to, x.slice(1).map((c) => (/^\d[\d,.:]*$/.test(c) ? c : tr(c))));
  }
  // Templates that also carry numbers: try the number shape against them as well.
  if (nums.length) {
    for (const t of templates) {
      const x = t.re.exec(shape);
      if (x) return fill(t.to, [...x.slice(1).map((c) => (c === '{n}' ? nums.shift() ?? c : tr(c)))]);
    }
  }
  const d = dates(core);
  if (d !== core) return d;
  const pieces = byPieces(core);
  if (pieces !== core) return pieces;
  if (collecting && /[A-Za-z]{3}/.test(core)) {
    if (!missed.has(core)) {
      missed.add(core);
      // The browser tests read this line and collect it.
      console.debug('@@MISSED ' + JSON.stringify(core));
    }
  }
  return core;
}

/**
 * Lines the pages join together ("Order S-12 · Amani · Today", "Slice, Vanilla cream", "Baraka (Cashier)", "· Added …")
 * are translated piece by piece when the whole line has no entry of its own. Returns the line unchanged when no piece changes.
 */
function byPieces(core: string): string {
  {
    const lead = /^([·‹−-]\s*)([\s\S]+)$/.exec(core);
    if (lead) {
      const rest = tr(lead[2]!);
      return rest === lead[2] ? core : lead[1] + rest;
    }
    if (core.includes(' · ') || core.includes(', ')) {
      const parts = core.split(/( · |, )/);
      const out = parts.map((p, i) => (i % 2 ? p : tr(p)));
      const joined = out.join('');
      if (joined !== core) return joined;
    }
    const who = /^(.{1,60}?\)): (.+)$/s.exec(core); // "Amina (Owner): Added Lemon loaf"
    if (who) {
      const rest = tr(who[2]!);
      const head = tr(who[1]!);
      if (rest !== who[2] || head !== who[1]) return `${head}: ${rest}`;
    }
    const paren = /^(.+?) \(([^()]+)\)$/.exec(core);
    if (paren) {
      const a = tr(paren[1]!);
      const b = tr(paren[2]!);
      if (a !== paren[1] || b !== paren[2]) return `${a} (${b})`;
    }
    return core;
  }
}

function fill(template: string, parts: string[]): string {
  let i = 0;
  return dates(template.replace(/\{[n*]\}/g, () => parts[i++] ?? ''));
}

/* ---------- the screen ---------- */

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
/** What each node said in English, so switching back (or a page redrawing it in English) both work. */
const textNodes = new WeakMap<Text, { en: string; shown: string }>();
const attrOwn = new WeakMap<Element, Record<string, { en: string; shown: string }>>();
let observer: MutationObserver | null = null;
let busy = false;

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT']);

function doText(n: Text) {
  const parent = n.parentElement;
  if (!parent || SKIP.has(parent.tagName)) return;
  if (parent.closest('[data-notr]')) return;
  const rec = textNodes.get(n);
  const now = n.data;
  // The page wrote new text (English) over what we showed, or this node is new.
  const en = rec && rec.shown === now ? rec.en : now;
  const shown = lang === 'sw' ? tr(en) : en;
  if (shown !== now) n.data = shown;
  textNodes.set(n, { en, shown });
}

function doAttrs(el: Element) {
  if (el.closest('[data-notr]')) return;
  let rec = attrOwn.get(el);
  for (const a of ATTRS) {
    const now = el.getAttribute(a);
    if (now === null) continue;
    const prev = rec?.[a];
    const en = prev && prev.shown === now ? prev.en : now;
    const shown = lang === 'sw' ? tr(en) : en;
    if (shown !== now) el.setAttribute(a, shown);
    if (!rec) attrOwn.set(el, (rec = {}));
    rec[a] = { en, shown };
  }
  if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit') && el.value) {
    const now = el.value;
    const shown = lang === 'sw' ? tr(now) : now;
    if (shown !== now) el.value = shown;
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (SKIP.has(el.tagName)) return;
  doAttrs(el);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n: Node | null = w.nextNode();
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else if (!SKIP.has((n as Element).tagName)) doAttrs(n as Element);
    n = w.nextNode();
  }
}

function translateTitle() {
  const t = document.querySelector('title');
  if (!t) return;
  const own = (t as unknown as { __en?: string }).__en ?? t.textContent ?? '';
  (t as unknown as { __en?: string }).__en = own;
  t.textContent = lang === 'sw' ? tr(own) : own;
}

function startObserving() {
  if (observer || !document.body) return;
  observer = new MutationObserver((list) => {
    if (busy) return;
    busy = true;
    try {
      for (const m of list) {
        if (m.type === 'childList') m.addedNodes.forEach((n) => walk(n));
        else if (m.type === 'characterData') doText(m.target as Text);
        else if (m.type === 'attributes') doAttrs(m.target as Element);
      }
    } finally {
      busy = false;
      // Our own edits were made while `busy`, so their records are already right. Drop the notifications they caused.
      observer?.takeRecords();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Translates everything on the page now (and again whenever the page changes). */
export function apply() {
  if (!document.body) return;
  busy = true;
  try {
    walk(document.body);
    translateTitle();
    document.documentElement.lang = lang;
  } finally {
    busy = false;
    observer?.takeRecords();
  }
  startObserving();
}

/* ---------- dialogs ---------- */

let wrapped = false;
function wrapDialogs() {
  if (wrapped) return;
  wrapped = true;
  const a = window.alert.bind(window);
  const c = window.confirm.bind(window);
  const p = window.prompt.bind(window);
  window.alert = (m?: unknown) => a(tr(String(m ?? '')));
  window.confirm = (m?: string) => c(tr(String(m ?? '')));
  window.prompt = (m?: string, d?: string) => p(tr(String(m ?? '')), d);
}

/* ---------- choosing the language ---------- */

export function current(): Lang {
  return lang;
}

/** What the browser remembers from last time, so the first screen is already in the right language. */
export function remembered(): Lang {
  try {
    return localStorage.getItem(KEY) === 'sw' ? 'sw' : 'en';
  } catch {
    return 'en';
  }
}

export function onChange(fn: (l: Lang) => void) {
  listeners.add(fn);
}

function loadDictionary(): Promise<boolean> {
  if (entries) return Promise.resolve(true);
  return new Promise((done) => {
    const g = window as unknown as { __cakeSw?: Entries };
    if (g.__cakeSw) {
      entries = g.__cakeSw;
      compile(entries);
      return done(true);
    }
    const s = document.createElement('script');
    s.src = '/lang-sw.js';
    s.onload = () => {
      if (g.__cakeSw) {
        entries = g.__cakeSw;
        compile(entries);
        done(true);
      } else done(false);
    };
    s.onerror = () => done(false);
    document.head.appendChild(s);
  });
}

/**
 * Switches the screens to `next`. Kiswahili needs its word list from the server first; if that cannot be fetched the
 * screens stay in English rather than half translated.
 */
export async function setLanguage(next: Lang): Promise<void> {
  if (next === lang && (next === 'en' || entries)) return;
  if (next === 'sw') {
    if (!(await loadDictionary())) return;
  }
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the screens still work; the next page just asks the server again */
  }
  wrapDialogs();
  apply();
  for (const l of listeners) l(lang);
}

/** Runs at the start of every page: hides the English flash when the last language was Kiswahili. */
export function early() {
  collecting = /[?&]collect\b/.test(location.search) || (() => {
    try {
      return localStorage.getItem('cake-pos-collect') === '1';
    } catch {
      return false;
    }
  })();
  if (remembered() !== 'sw') return;
  const css = document.createElement('style');
  css.id = 'i18n-wait';
  css.textContent = 'html.i18n-wait body{visibility:hidden}';
  document.head.appendChild(css);
  document.documentElement.classList.add('i18n-wait');
  const show = () => document.documentElement.classList.remove('i18n-wait');
  // Never leave the screen blank: show it after a moment even if the word list did not arrive.
  const fail = setTimeout(show, 2500);
  const go = async () => {
    await setLanguage('sw');
    clearTimeout(fail);
    show();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void go());
  else void go();
}
