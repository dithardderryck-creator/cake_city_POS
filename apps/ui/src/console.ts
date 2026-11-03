/**
 * The Console: IT types a command, it becomes the same instruction or feed a screen would use. Nothing here can do more than
 * the screens can: it only turns words into those calls, so the same role checks and previews apply.
 *
 * Commands are English (so they read the same in every shop), and what they print goes through the screen translation.
 * A command that changes something is never run straight away: it shows its preview first (`confirm`), and a destructive one
 * also needs the target's name typed. PINs and keys have no command, so they can never be typed, printed or sealed here.
 * Every command that runs is written to the sealed records once, as the Console understood it (never the raw text typed).
 */
import type { FeedMap, FeedName, IntentMap, IntentName } from '@cake-pos/client';

export interface ConsoleData {
  staff: { id: string; name: string; role: string; active: boolean }[];
  devices: { id: string; name: string }[];
  sessions: { userId: string; name: string }[];
  /** Newest first. */
  points: { file: string; madeAt: string }[];
}

export interface Line {
  /** What it says. Goes through the screen translation, so keep sentences whole. */
  t: string;
  /** A name, number or time that follows the text and is shown as it is. */
  v?: string;
  tone?: 'ok' | 'risk' | 'warn' | 'mute';
  /** Show `v` before `t` (help lists the command first). */
  first?: boolean;
  /** `v` is text the person typed or a command, shown as it is. */
  raw?: boolean;
}

type Arg = { name: string; kind: 'device' | 'session' | 'person' | 'role' | 'point' | 'word' | 'text' | 'number'; optional?: boolean };
type Kind = 'read' | 'run' | 'change';
interface Spec {
  id: string;
  words: string[];
  args: Arg[];
  /** Shown after the words in help, for flags that are not arguments. */
  extra?: string;
  what: string;
  kind: Kind;
}

const ROLES = ['cashier', 'baker', 'inventory', 'it'] as const;

export const SPECS: Spec[] = [
  { id: 'help', words: ['help'], args: [{ name: 'word', kind: 'word', optional: true }], what: 'Lists the commands. Add a word to narrow them, such as: help devices', kind: 'read' },
  { id: 'clear', words: ['clear'], args: [], what: 'Clears this screen.', kind: 'read' },
  { id: 'status', words: ['status'], args: [], what: 'How the system is doing: selling, devices, backups and disk.', kind: 'read' },
  { id: 'devices', words: ['devices'], args: [], what: 'Lists the registered devices.', kind: 'read' },
  { id: 'devices code', words: ['devices', 'code'], args: [{ name: 'name', kind: 'text' }], what: 'Makes a one-time code to register a new device.', kind: 'change' },
  { id: 'devices rename', words: ['devices', 'rename'], args: [{ name: 'device', kind: 'device' }, { name: 'new name', kind: 'text' }], what: 'Renames a device.', kind: 'change' },
  { id: 'devices revoke', words: ['devices', 'revoke'], args: [{ name: 'device', kind: 'device' }], what: 'Switches a device off. You type its name to confirm.', kind: 'change' },
  { id: 'sessions', words: ['sessions'], args: [], what: 'Lists who is signed in.', kind: 'read' },
  { id: 'sessions kill', words: ['sessions', 'kill'], args: [{ name: 'person', kind: 'session' }], what: 'Signs a person out everywhere.', kind: 'change' },
  { id: 'staff', words: ['staff'], args: [], what: 'Lists the people who can sign in.', kind: 'read' },
  { id: 'staff unlock', words: ['staff', 'unlock'], args: [{ name: 'person', kind: 'person' }], what: 'Lets a locked-out person try again.', kind: 'change' },
  { id: 'staff off', words: ['staff', 'off'], args: [{ name: 'person', kind: 'person' }], what: "Turns a person's access off.", kind: 'change' },
  { id: 'staff on', words: ['staff', 'on'], args: [{ name: 'person', kind: 'person' }], what: "Turns a person's access back on.", kind: 'change' },
  { id: 'staff role', words: ['staff', 'role'], args: [{ name: 'person', kind: 'person' }, { name: 'role', kind: 'role' }], what: 'Changes what a person does: cashier, baker, inventory or it.', kind: 'change' },
  { id: 'maintenance', words: ['maintenance'], args: [], what: 'Shows whether selling is paused.', kind: 'read' },
  { id: 'maintenance on', words: ['maintenance', 'on'], args: [{ name: 'message', kind: 'text', optional: true }], what: 'Pauses selling and shows your message on every screen.', kind: 'change' },
  { id: 'maintenance off', words: ['maintenance', 'off'], args: [], what: 'Lets selling carry on.', kind: 'change' },
  { id: 'alerts', words: ['alerts'], args: [], what: 'Lists the open system alerts.', kind: 'read' },
  { id: 'logs', words: ['logs'], args: [{ name: 'errors', kind: 'word', optional: true }], extra: '[--since 1h] [--part sync]', what: 'Shows the newest server log lines. Use errors or warnings to narrow them.', kind: 'read' },
  { id: 'records', words: ['records'], args: [{ name: 'refused', kind: 'word', optional: true }], what: 'Lists the newest sealed records. Use refused or opened to narrow them.', kind: 'read' },
  { id: 'records open', words: ['records', 'open'], args: [{ name: 'number', kind: 'number' }], what: 'Opens one sealed record. The opening is recorded too.', kind: 'run' },
  { id: 'records verify', words: ['records', 'verify'], args: [{ name: 'full', kind: 'word', optional: true }], what: 'Checks the sealed records now. Add full to check everything.', kind: 'run' },
  { id: 'records drive', words: ['records', 'drive'], args: [], what: 'Compares the records with the copy on Drive.', kind: 'run' },
  { id: 'backups', words: ['backups'], args: [], what: 'Lists the backups kept on the server.', kind: 'read' },
  { id: 'backup now', words: ['backup', 'now'], args: [], what: 'Takes a backup now.', kind: 'run' },
  { id: 'backup restore', words: ['backup', 'restore'], args: [{ name: 'number', kind: 'point' }], what: 'Puts a backup back, using its number from backups. Selling must be paused first.', kind: 'change' },
  { id: 'sync now', words: ['sync', 'now'], args: [], what: 'Sends the waiting changes to the online database now.', kind: 'run' },
  { id: 'sync full', words: ['sync', 'full'], args: [], what: 'Sends every record to the online database again.', kind: 'change' },
];

export const usage = (s: Spec): string => [...s.words, ...s.args.map((a) => (a.optional ? `[${a.name}]` : a.kind === 'text' || a.kind === 'device' || a.kind === 'person' || a.kind === 'session' ? `"${a.name}"` : `<${a.name}>`)), ...(s.extra ? [s.extra] : [])].join(' ');

/* ---------- reading what was typed ---------- */

/** Splits on spaces, keeping "quoted words" together. Returns the problem as text when a quote is left open. */
export function tokens(line: string): string[] | string {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'" || ch === '“' || ch === '”') {
      q = ch === '“' ? '”' : ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (q) return 'A quote was opened and not closed.';
  if (has || cur) out.push(cur);
  return out;
}

const quote = (t: string): string => (/[\s"']/.test(t) || t === '' ? `"${t.replace(/"/g, '')}"` : t);

export type Plan =
  | { kind: 'error'; message: string; value?: string }
  | { kind: 'help'; topic: string | null }
  | { kind: 'read'; spec: Spec; line: string; opts: Record<string, string | number | undefined> }
  | { kind: 'run'; spec: Spec; line: string; intent: IntentName; payload: Record<string, unknown> }
  | { kind: 'change'; spec: Spec; line: string; intent: IntentName; payload: Record<string, unknown>; title: string; okLabel: string; okMessage: string; typeName?: string };

const err = (message: string, value?: string): Plan => ({ kind: 'error', message, value });

/** Finds the one person, device or file the typed word means: exact, then the start of a name, then anywhere in it. */
function pick<T>(items: T[], label: (t: T) => string, typed: string, what: string): { ok: T } | { no: Plan } {
  const q = typed.trim().toLowerCase();
  const tiers = [items.filter((i) => label(i).toLowerCase() === q), items.filter((i) => label(i).toLowerCase().startsWith(q)), items.filter((i) => label(i).toLowerCase().includes(q))];
  for (const tier of tiers) {
    if (tier.length === 1) return { ok: tier[0]! };
    if (tier.length > 1) return { no: err(`More than one ${what} matches. Type more of the name:`, tier.map(label).join(', ')) };
  }
  return { no: err(`No ${what} matches:`, typed) };
}

const SPEC_BY_ID = new Map(SPECS.map((s) => [s.id, s]));
const find = (toks: string[]): Spec | null => {
  let best: Spec | null = null;
  for (const s of SPECS) if (s.words.every((w, i) => toks[i]?.toLowerCase() === w) && (!best || s.words.length > best.words.length)) best = s;
  return best;
};

export function plan(input: string, d: ConsoleData): Plan {
  const toks = tokens(input);
  if (typeof toks === 'string') return err(toks);
  if (!toks.length) return err('Type a command, or help to see them.');
  const s = find(toks);
  if (!s) {
    const near = SPECS.filter((x) => x.words[0] === toks[0]!.toLowerCase());
    return near.length ? err('That is not a complete command. Try one of:', near.map(usage).join('   ')) : err('That is not a command. Type help to see them.', toks[0]);
  }
  const rest = toks.slice(s.words.length);
  const need = s.args.filter((a) => !a.optional).length;
  if (s.id !== 'logs' && s.id !== 'help') {
    const last = s.args[s.args.length - 1];
    const maxArgs = last?.kind === 'text' ? Infinity : s.args.length;
    if (rest.length < need) return err('Something is missing. Use:', usage(s));
    if (rest.length > maxArgs) {
      const kin = SPECS.filter((x) => x.words.length > 1 && x.words[0] === s.words[0]);
      return s.words.length === 1 && kin.length ? err('That is not a complete command. Try one of:', kin.map(usage).join('   ')) : err('There is too much after that. Use:', usage(s));
    }
  }
  const words = s.words.join(' ');
  const text = (from: number) => rest.slice(from).join(' ').trim();
  const bad = (p: { no: Plan }) => p.no;

  switch (s.id) {
    case 'help':
      return { kind: 'help', topic: rest.length ? rest.join(' ').toLowerCase() : null };
    case 'status':
    case 'devices':
    case 'sessions':
    case 'staff':
    case 'alerts':
    case 'backups':
    case 'maintenance':
      return { kind: 'read', spec: s, line: words, opts: {} };
    case 'logs': {
      const opts: Record<string, string | number | undefined> = { level: 'all', hours: 24 };
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i]!.toLowerCase();
        if (w === 'errors' || w === 'error') opts.level = 'error';
        else if (w === 'warnings' || w === 'warning' || w === 'warn') opts.level = 'warn';
        else if (w === '--since') {
          const m = /^(\d{1,2})([hd])$/i.exec(rest[++i] ?? '');
          if (!m) return err('Use --since with hours or days, such as 1h or 2d.');
          const h = +m[1]! * (m[2]!.toLowerCase() === 'd' ? 24 : 1);
          if (h < 1 || h > 72) return err('Logs go back at most 72 hours (3d).');
          opts.hours = h;
        } else if (w === '--part') {
          const p = rest[++i];
          if (!p) return err('Say which part after --part, such as sync.');
          opts.part = p.toLowerCase();
        } else return err('Not understood in logs:', rest[i]);
      }
      return { kind: 'read', spec: s, line: ['logs', opts.level === 'error' ? 'errors' : opts.level === 'warn' ? 'warnings' : '', opts.hours !== 24 ? `--since ${opts.hours}h` : '', opts.part ? `--part ${opts.part}` : ''].filter(Boolean).join(' '), opts };
    }
    case 'records': {
      const w = (rest[0] ?? 'all').toLowerCase();
      if (!['all', 'refused', 'opened'].includes(w)) return err('Use records, records refused or records opened.');
      return { kind: 'read', spec: s, line: w === 'all' ? 'records' : `records ${w}`, opts: { kind: w } };
    }
    case 'records open': {
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 1) return err('Give the record number, a whole number from the records list.');
      return { kind: 'run', spec: s, line: `records open ${n}`, intent: 'records/open', payload: { seq: n } };
    }
    case 'records verify': {
      const w = rest[0]?.toLowerCase();
      if (w && w !== 'full') return err('Use records verify or records verify full.');
      return { kind: 'run', spec: s, line: w ? 'records verify full' : 'records verify', intent: 'records/verify', payload: w ? { full: true } : {} };
    }
    case 'records drive':
      return { kind: 'run', spec: s, line: words, intent: 'records/drive_check', payload: {} };
    case 'backup now':
      return { kind: 'run', spec: s, line: words, intent: 'backup/run_now', payload: {} };
    case 'sync now':
      return { kind: 'run', spec: s, line: words, intent: 'sync/flush', payload: {} };
    case 'sync full':
      return { kind: 'change', spec: s, line: words, intent: 'sync/full_copy', payload: {}, title: 'Send every record again?', okLabel: 'Send everything', okMessage: 'Queued to send' };
    case 'devices code': {
      const n = text(0);
      if (!n) return err('Name the device, for example: devices code "Counter tablet"');
      return { kind: 'change', spec: s, line: `devices code ${quote(n)}`, intent: 'devices/create_code', payload: { name: n }, title: `Make a code for ${n}?`, okLabel: 'Make the code', okMessage: 'Code made' };
    }
    case 'devices rename': {
      const dev = pick(d.devices, (x) => x.name, rest[0]!, 'device');
      if ('no' in dev) return bad(dev);
      const n = text(1);
      if (!n) return err('Give the new name.');
      return { kind: 'change', spec: s, line: `devices rename ${quote(dev.ok.name)} ${quote(n)}`, intent: 'devices/rename', payload: { deviceId: dev.ok.id, name: n }, title: `Rename ${dev.ok.name} to ${n}?`, okLabel: 'Rename', okMessage: 'Renamed' };
    }
    case 'devices revoke': {
      const dev = pick(d.devices, (x) => x.name, rest[0]!, 'device');
      if ('no' in dev) return bad(dev);
      return { kind: 'change', spec: s, line: `devices revoke ${quote(dev.ok.name)}`, intent: 'devices/revoke', payload: { deviceId: dev.ok.id }, title: `Revoke ${dev.ok.name}?`, okLabel: 'Revoke', okMessage: `${dev.ok.name} was revoked`, typeName: dev.ok.name };
    }
    case 'sessions kill': {
      const p = pick(d.sessions, (x) => x.name, rest[0]!, 'signed-in person');
      if ('no' in p) return bad(p);
      return { kind: 'change', spec: s, line: `sessions kill ${quote(p.ok.name)}`, intent: 'sessions/end', payload: { userId: p.ok.userId }, title: `Sign ${p.ok.name} out?`, okLabel: 'Sign out', okMessage: 'Signed out' };
    }
    case 'staff unlock':
    case 'staff off':
    case 'staff on':
    case 'staff role': {
      const p = pick(d.staff, (x) => x.name, rest[0]!, 'person');
      if ('no' in p) return bad(p);
      const who = p.ok;
      const l = (extra = '') => `${words} ${quote(who.name)}${extra}`;
      if (s.id === 'staff unlock') return { kind: 'change', spec: s, line: l(), intent: 'staff/unlock', payload: { userId: who.id }, title: `Let ${who.name} back in?`, okLabel: 'Let in', okMessage: 'Let back in' };
      if (s.id === 'staff off') return { kind: 'change', spec: s, line: l(), intent: 'staff/set_active', payload: { userId: who.id, active: false }, title: `Turn off ${who.name}?`, okLabel: 'Turn off', okMessage: 'Turned off' };
      if (s.id === 'staff on') return { kind: 'change', spec: s, line: l(), intent: 'staff/set_active', payload: { userId: who.id, active: true }, title: `Turn on ${who.name}?`, okLabel: 'Turn on', okMessage: 'Turned on' };
      const r = rest[1]!.toLowerCase();
      if (!(ROLES as readonly string[]).includes(r)) return err('The role is one of: cashier, baker, inventory, it.', rest[1]);
      return { kind: 'change', spec: s, line: l(' ' + r), intent: 'staff/set_role', payload: { userId: who.id, role: r }, title: `Change the role of ${who.name}?`, okLabel: 'Change role', okMessage: 'Role changed' };
    }
    case 'maintenance on': {
      const m = text(0);
      return { kind: 'change', spec: s, line: m ? `maintenance on ${quote(m)}` : 'maintenance on', intent: 'maintenance/set', payload: { on: true, ...(m ? { message: m } : {}) }, title: 'Pause selling?', okLabel: 'Pause selling', okMessage: 'Selling is paused' };
    }
    case 'maintenance off':
      return { kind: 'change', spec: s, line: words, intent: 'maintenance/set', payload: { on: false }, title: 'Resume selling?', okLabel: 'Resume selling', okMessage: 'Selling resumed' };
    case 'backup restore': {
      const t = rest[0]!;
      const at = /^\d+$/.test(t) ? d.points[+t - 1] : d.points.find((p) => p.file === t || p.file === t + '.sqlite');
      if (!at) return err(d.points.length ? 'No backup has that number. See backups for the list.' : 'No backups are kept on this server yet.', t);
      const n = d.points.indexOf(at) + 1;
      return { kind: 'change', spec: s, line: `backup restore ${n}`, intent: 'restore/start', payload: { file: at.file }, title: 'Restore this backup?', okLabel: 'Restore', okMessage: 'Restoring. This takes a moment.' };
    }
  }
  return err('That is not a command. Type help to see them.');
}

/* ---------- suggestions ---------- */

function options(a: Arg, d: ConsoleData): string[] {
  switch (a.kind) {
    case 'device':
      return d.devices.map((x) => x.name);
    case 'session':
      return d.sessions.map((x) => x.name);
    case 'person':
      return d.staff.map((x) => x.name);
    case 'role':
      return [...ROLES];
    case 'point':
      return d.points.map((_p, i) => String(i + 1));
    case 'word':
      return a.name === 'errors' ? ['errors', 'warnings'] : a.name === 'refused' ? ['refused', 'opened'] : a.name === 'full' ? ['full'] : [];
    default:
      return [];
  }
}

/** Whole-line completions for what has been typed so far. */
export function suggest(input: string, d: ConsoleData): string[] {
  const t = tokens(input.replace(/\s+$/, ' ').replace(/^\s+/, ''));
  if (typeof t === 'string') return [];
  const ends = /\s$/.test(input);
  const toks = ends ? t : t.slice(0, -1);
  const partial = ends ? '' : (t[t.length - 1] ?? '');
  const base = toks.map(quote).join(' ') + (toks.length ? ' ' : '');
  const out: string[] = [];
  for (const s of SPECS) {
    const fw = s.words;
    if (toks.slice(0, fw.length).some((w, i) => w.toLowerCase() !== fw[i])) continue;
    if (toks.length < fw.length) {
      if (!fw[toks.length]!.startsWith(partial.toLowerCase())) continue;
      out.push(base + fw[toks.length] + (toks.length + 1 < fw.length || s.args.some((a) => !a.optional) ? ' ' : ''));
      continue;
    }
    if (s.id === 'help') continue;
    const a = s.args[toks.length - fw.length];
    if (!a) continue;
    for (const o of options(a, d)) if (o.toLowerCase().includes(partial.toLowerCase())) out.push(base + quote(o) + (toks.length - fw.length + 1 < s.args.length ? ' ' : ''));
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.trimEnd()) ? false : (seen.add(x.trimEnd()), true))).slice(0, 8);
}

/* ---------- running ---------- */

export interface Done {
  ok: boolean;
  data?: unknown;
  message?: string;
}
export interface Io {
  read<K extends FeedName>(name: K, params: FeedMap[K]['params']): Promise<FeedMap[K]['data'] | null>;
  send<K extends IntentName>(type: K, payload: IntentMap[K]): Promise<Done>;
  confirm<K extends IntentName>(type: K, payload: IntentMap[K], o: { title: string; okLabel: string; okMessage: string; typeName?: string }): Promise<Done | null>;
}

const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? hm(iso) : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm(iso)}`;
};
const count = (n: number, one: string, many: string): Line => ({ t: n === 1 ? one : many.replace('{n}', String(n)) });

export function helpLines(topic: string | null): Line[] {
  const list = topic ? SPECS.filter((s) => s.id.includes(topic) || s.words.some((w) => w.startsWith(topic))) : SPECS;
  if (!list.length) return [{ t: 'No command matches that word. Type help to see them all.', tone: 'warn' }];
  return list.map((s) => ({ t: s.what, v: usage(s), first: true }));
}

const newestFirst = <T extends { madeAt: string }>(a: T[]): T[] => [...a].sort((x, y) => y.madeAt.localeCompare(x.madeAt));

const NOT_AVAILABLE: Line = { t: 'This could not be loaded just now.', tone: 'risk' };

/** Runs one planned command and returns what to print. `Done` results of changes come back as lines too. */
export async function run(p: Plan, io: Io): Promise<{ lines: Line[]; ran: string | null }> {
  if (p.kind === 'error') return { lines: [{ t: p.message, v: p.value, tone: 'warn', raw: true }], ran: null };
  if (p.kind === 'help') return { lines: helpLines(p.topic), ran: null };

  if (p.kind === 'read') {
    const lines = await readLines(p, io);
    return { lines, ran: lines[0] === NOT_AVAILABLE ? null : p.line };
  }
  if (p.kind === 'run') {
    const r = await io.send(p.intent as IntentName, p.payload as never);
    if (!r.ok) return { lines: [{ t: r.message ?? 'That did not work.', tone: 'risk' }], ran: null };
    return { lines: ranLines(p, r.data), ran: p.line };
  }
  const r = await io.confirm(p.intent as IntentName, p.payload as never, { title: p.title, okLabel: p.okLabel, okMessage: p.okMessage, ...(p.typeName ? { typeName: p.typeName } : {}) });
  if (!r) return { lines: [{ t: 'Cancelled. Nothing was changed.', tone: 'mute' }], ran: null };
  const lines: Line[] = [{ t: p.okMessage, tone: 'ok' }];
  if (p.intent === 'devices/create_code') {
    const c = r.data as { code: string; expiresAt: string; name: string };
    lines.push({ t: `Code for ${c.name}. Type it on that device. It works once, until`, v: `${c.code} · ${hm(c.expiresAt)}`, tone: 'ok' });
  }
  return { lines, ran: p.line };
}

function ranLines(p: Extract<Plan, { kind: 'run' }>, data: unknown): Line[] {
  switch (p.intent) {
    case 'records/open': {
      const o = data as { kind: string; at: string; who: string; ref: string; summary: string | null; intact: boolean | null };
      return [
        { t: o.kind, v: `${o.ref} · ${when(o.at)} · ${o.who}` },
        { t: o.summary ?? 'The details are in the archive.' },
        o.intact === null ? { t: 'Details not here to compare.', tone: 'warn' } : o.intact ? { t: 'Matches its seal.', tone: 'ok' } : { t: 'Does NOT match its seal.', tone: 'risk' },
      ];
    }
    case 'records/verify': {
      const r = data as { ok: boolean; problems?: string[] };
      return r.ok ? [{ t: 'Everything checked matches its seal.', tone: 'ok' }] : [{ t: 'Something does not match its seal. Do not clear it. Tell the owner.', tone: 'risk' }, ...(r.problems ?? []).slice(0, 5).map((x) => ({ t: '', v: x, tone: 'risk' as const }))];
    }
    case 'records/drive_check': {
      const r = data as { state: string };
      return [r.state === 'ok' ? { t: 'The records match the copy on Drive.', tone: 'ok' } : r.state === 'mismatch' ? { t: 'The records do NOT match Drive. See the Records page.', tone: 'risk' } : r.state === 'off' ? { t: 'No Google account is switched on, so there is no copy to compare.', tone: 'warn' } : { t: 'Drive could not be compared just now.', tone: 'warn' }];
    }
    case 'backup/run_now':
      return [{ t: 'Backup started. It appears in backups in a moment.', tone: 'ok' }];
    case 'sync/flush': {
      const r = data as { sent: number; pending: number };
      return [r.pending ? { t: `${r.sent} sent, ${r.pending} still waiting.`, tone: 'warn' } : { t: r.sent ? `${r.sent} sent. Nothing is waiting.` : 'Nothing was waiting.', tone: 'ok' }];
    }
  }
  return [{ t: 'Done.', tone: 'ok' }];
}

async function readLines(p: Extract<Plan, { kind: 'read' }>, io: Io): Promise<Line[]> {
  const o = p.opts;
  switch (p.spec.id) {
    case 'status': {
      const m = await io.read('panel_map', {});
      if (!m) return [NOT_AVAILABLE];
      const s = m.selling;
      return [
        { t: 'Selling', v: s.state === 'paused' ? `Paused${s.message ? ': ' + s.message : ''}` : 'Normal', tone: s.state === 'paused' ? 'risk' : 'ok' },
        { t: 'Devices seen in the last hour', v: `${s.online} of ${s.devices}`, tone: s.quiet.length ? 'warn' : undefined },
        { t: 'Signed in now', v: String(m.activeSessions) },
        { t: 'Changes waiting to sync', v: String(m.outbox.pending), tone: m.outbox.failed ? 'risk' : undefined },
        { t: 'Failed syncs', v: String(m.outbox.failed), tone: m.outbox.failed ? 'risk' : undefined },
        { t: 'Last good backup', v: m.backup?.lastOkAt ? when(m.backup.lastOkAt) : 'None yet', tone: m.backup?.lastError ? 'risk' : undefined },
        ...(m.space ? [{ t: 'Disk free', v: `${m.space.freePct}%`, tone: m.space.freePct < 10 ? ('risk' as const) : undefined }] : []),
        ...m.system.map((x) => ({ t: x.label, v: x.value })),
      ];
    }
    case 'devices': {
      const d = await io.read('device_list', {});
      if (!d) return [NOT_AVAILABLE];
      return [count(d.devices.length, '1 registered device', '{n} registered devices'), ...d.devices.map((x) => ({ t: x.lastSeenAt ? 'Last used' : 'Not used yet', v: `${x.name}${x.isThis ? ' · this device' : ''}${x.lastSeenAt ? ' · ' + when(x.lastSeenAt) : ''}` })), ...d.openCodes.map((c) => ({ t: 'Code waiting for a device', v: `${c.name} · ${hm(c.expiresAt)}`, tone: 'warn' as const })), ...d.revoked.map((x) => ({ t: 'Revoked', v: `${x.name} · ${when(x.revokedAt)}`, tone: 'mute' as const }))];
    }
    case 'sessions': {
      const d = await io.read('sessions_view', {});
      if (!d) return [NOT_AVAILABLE];
      return [count(d.rows.length, '1 person signed in', '{n} people signed in'), ...d.rows.map((r) => ({ t: 'Signed in', v: `${r.name} (${r.role}) · ${r.deviceName ?? 'device not recorded'} · ${when(r.signedInAt)}` }))];
    }
    case 'staff': {
      const d = await io.read('staff_list', {});
      if (!d) return [NOT_AVAILABLE];
      return [count(d.length, '1 person', '{n} people'), ...d.map((u) => ({ t: u.locked ? 'Locked out' : u.active ? 'Active' : 'Turned off', v: `${u.name} (${u.role})`, tone: u.locked ? ('risk' as const) : u.active ? undefined : ('warn' as const) }))];
    }
    case 'alerts': {
      const d = await io.read('alert_inbox', {});
      if (!d) return [NOT_AVAILABLE];
      return d.open.length ? [count(d.open.length, '1 open alert', '{n} open alerts'), ...d.open.map((a) => ({ t: a.title, v: a.body, tone: a.severity === 'critical' ? ('risk' as const) : ('warn' as const) }))] : [{ t: 'No alerts are open.', tone: 'ok' }];
    }
    case 'maintenance': {
      const m = await io.read('panel_map', {});
      if (!m) return [NOT_AVAILABLE];
      return m.selling.state === 'paused' ? [{ t: 'Selling is paused', v: m.selling.message ?? undefined, tone: 'risk' }] : [{ t: 'Selling is open.', tone: 'ok' }];
    }
    case 'backups': {
      const d = await io.read('restore_points', {});
      if (!d) return [NOT_AVAILABLE];
      return d.points.length ? [count(d.points.length, '1 backup kept', '{n} backups kept'), ...newestFirst(d.points).map((x, i) => ({ t: 'Sealed records and size', v: `${i + 1}  ${when(x.madeAt)} · ${x.sealed} · ${Math.round(x.sizeKb)} KB` }))] : [{ t: 'No backups are kept on this server yet.', tone: 'warn' }];
    }
    case 'logs': {
      const d = await io.read('logs_view', { level: o.level as 'all' | 'warn' | 'error', hours: o.hours as number });
      if (!d) return [NOT_AVAILABLE];
      if (!d.available) return [{ t: d.note ?? 'The log is not available here.', tone: 'warn' }];
      const part = o.part as string | undefined;
      const rows = d.rows.filter((r) => !part || `${r.message} ${r.detail ?? ''}`.toLowerCase().includes(part));
      return [count(rows.length, '1 line', '{n} lines'), ...rows.slice(0, 25).map((r) => ({ t: '', v: `${when(r.at)} ${r.level} ${r.message}`, tone: r.level === 'error' ? ('risk' as const) : r.level === 'warn' ? ('warn' as const) : undefined })), ...(rows.length > 25 ? [{ t: 'Showing the newest 25. Narrow it with --since or --part.', tone: 'mute' as const }] : [])];
    }
    case 'records': {
      const d = await io.read('records_view', { kind: o.kind as 'all' | 'refused' | 'opened' });
      if (!d) return [NOT_AVAILABLE];
      return d.rows.length ? d.rows.slice(0, 15).map((r) => {
        const head = `#${r.seq} · ${when(r.at)} · ${r.who}${r.sealed ? ' · ' + r.kind : ''}`;
        const tone = r.outcome === 'ok' ? undefined : ('risk' as const);
        // A line the Console wrote keeps its command exactly as it was typed, so only the word before it is translated.
        if (r.summary?.startsWith('Console: ')) return { t: 'Console:', v: `${r.summary.slice(9)} · ${head}`, tone, raw: true };
        return { t: r.sealed ? 'Sealed, open it with records open ' + r.seq : (r.summary ?? r.kind), v: head, tone };
      }) : [{ t: 'Nothing recorded yet.', tone: 'mute' }];
    }
  }
  return [NOT_AVAILABLE];
}

export const specById = (id: string): Spec | undefined => SPEC_BY_ID.get(id);
