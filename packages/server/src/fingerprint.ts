import fs from 'node:fs';
import path from 'node:path';
import { linkId, refOf, todayLocal, type ChainHead, type ChainLink, type FingerprintStatus, type FingerprintTerminal, type Store } from '@cake-pos/panel';
import { DriveError, type DriveClient } from './google-drive';
import { errorFields, type Logger } from './log';

/**
 * A second copy of the record chain's newest fingerprint, kept on the shop's Google Drive.
 *
 * The chain proves nobody changed an old record by accident or behind the screens, but whoever can rewrite the database can
 * also re-seal it. A fingerprint kept somewhere else, in an account the owner can open, is what such a rewrite cannot reach.
 * The file's NAME carries everything (the day, how many records were sealed, and the fingerprint itself), so comparing never
 * needs to download anything. Files are a few bytes and are never removed here.
 *
 *   chain_2026-11-01_s0000001234_<64 hex>.txt
 */

const NAME = /^chain_(\d{4}-\d{2}-\d{2})_s(\d{10})_([0-9a-f]{64})\.txt$/;
const FOLDER = 'Fingerprints';
/** A new fingerprint is saved when the records have moved on and the last one is older than this. */
const SAVE_EVERY_MS = 6 * 3_600_000;
/** Drive is compared with the records this often when nothing asks for it. */
const COMPARE_EVERY_MS = 3 * 3_600_000;
/** After a failure (no internet, Google signed out) it tries again after this. */
const RETRY_MS = 10 * 60_000;
/** Records have moved on but no fingerprint has reached Drive for this long: someone should look. */
const LATE_MS = 24 * 3_600_000;
const COMPARE_DAYS = 120;
const COMPARE_MAX = 600;
const MAX_PROBLEMS = 10;

interface State {
  savedAt: string | null;
  savedSeq: number | null;
  comparedAt: string | null;
  matchedAt: string | null;
  state: FingerprintStatus['state'];
  checked: number;
  problems: string[];
  error: string | null;
  lastRunAt: string | null;
  /** The day an automatic "they match" line was last written to the activity record, so there is one a day. */
  auditedDay: string | null;
}
const blank = (): State => ({ savedAt: null, savedSeq: null, comparedAt: null, matchedAt: null, state: 'waiting', checked: 0, problems: [], error: null, lastRunAt: null, auditedDay: null });

export interface FingerprintOptions {
  store: Store;
  drive: () => { client: DriveClient; folderName: string } | null;
  statePath: string;
  log: Logger;
  now?: () => Date;
  /** Writes a line to the activity record. Used for the automatic runs only; a person who asks for a run gets their own line. */
  audit?: (summary: string, outcome: 'ok' | 'error') => Promise<unknown>;
  saveEveryMs?: number;
  compareEveryMs?: number;
}

export function createFingerprintService(o: FingerprintOptions): FingerprintTerminal {
  const now = o.now ?? (() => new Date());
  const saveEvery = o.saveEveryMs ?? SAVE_EVERY_MS;
  const compareEvery = o.compareEveryMs ?? COMPARE_EVERY_MS;
  let st = load();
  let running: Promise<FingerprintStatus> | null = null;

  function load(): State {
    try {
      return { ...blank(), ...(JSON.parse(fs.readFileSync(o.statePath, 'utf8')) as Partial<State>) };
    } catch {
      return blank();
    }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(o.statePath), { recursive: true });
      fs.writeFileSync(o.statePath, JSON.stringify(st));
    } catch (err) {
      o.log.warn('Could not save the Drive fingerprint state', errorFields(err));
    }
  }

  const head = () => o.store.get<ChainHead>('chainHead', 'head');

  async function view(): Promise<FingerprintStatus> {
    const t = now();
    const h = await head();
    const active = !!o.drive();
    const reference = st.savedAt ?? h?.since ?? null;
    const late = !!(active && h && h.seq > (st.savedSeq ?? 0) && reference && t.getTime() - Date.parse(reference) > LATE_MS);
    return {
      state: active ? (st.state === 'off' ? 'waiting' : st.state) : 'off',
      savedAt: st.savedAt,
      savedSeq: st.savedSeq,
      comparedAt: st.comparedAt,
      matchedAt: st.matchedAt,
      matchedToday: !!st.matchedAt && todayLocal(new Date(st.matchedAt)) === todayLocal(t),
      checked: st.checked,
      problems: st.problems,
      error: st.error,
      late,
    };
  }

  /** Saves the newest fingerprint to Drive when it is due. Returns true when one was written. */
  async function saveNew(force: boolean, d: { client: DriveClient; folderName: string }): Promise<boolean> {
    const h = await head();
    if (!h || h.seq === st.savedSeq) return false;
    if (!force && st.savedAt && now().getTime() - Date.parse(st.savedAt) < saveEvery) return false;
    const link = await o.store.get<ChainLink>('chain', linkId(h.seq));
    if (!link) return false;
    const day = todayLocal(now());
    const name = `chain_${day}_s${String(h.seq).padStart(10, '0')}_${link.hash}.txt`;
    const text = [
      'Cake POS record fingerprint',
      `Saved: ${now().toISOString()}`,
      `Sealed records: ${h.seq}`,
      `Latest seal: ${refOf(link.hash)}`,
      `Fingerprint: ${link.hash}`,
      '',
      'This file only holds a code. It cannot be used to read or change anything in the shop system.',
      'Do not rename or remove it: the shop system compares it with its own records to prove nothing was changed.',
      '',
    ].join('\n');
    const folder = await d.client.ensureFolder([d.folderName, FOLDER]);
    await d.client.upload({ name, parentId: folder, source: { bytes: Buffer.from(text, 'utf8') }, mimeType: 'text/plain' });
    st.savedAt = now().toISOString();
    st.savedSeq = h.seq;
    return true;
  }

  /** Reads the fingerprints on Drive and checks each against the record it names. */
  async function compare(d: { client: DriveClient; folderName: string }): Promise<void> {
    const folder = await d.client.ensureFolder([d.folderName, FOLDER]);
    const files = await d.client.list(folder);
    const cutoff = todayLocal(new Date(now().getTime() - COMPARE_DAYS * 86_400_000));
    const found = new Map<number, { hash: string; day: string }[]>();
    for (const f of files) {
      const m = NAME.exec(f.name);
      if (!m || m[1]! < cutoff) continue;
      const seq = Number(m[2]);
      found.set(seq, [...(found.get(seq) ?? []), { hash: m[3]!, day: m[1]! }]);
    }
    const seqs = [...found.keys()].sort((a, b) => b - a).slice(0, COMPARE_MAX);
    const problems: string[] = [];
    for (const seq of seqs) {
      const link = await o.store.get<ChainLink>('chain', linkId(seq));
      for (const f of found.get(seq)!) {
        if (!link) problems.push(`Drive holds a fingerprint for record ${seq} (saved ${f.day}), but the records no longer have it.`);
        else if (link.hash !== f.hash) problems.push(`Record ${seq} does not match the fingerprint saved on Drive on ${f.day}.`);
        if (problems.length >= MAX_PROBLEMS) break;
      }
      if (problems.length >= MAX_PROBLEMS) break;
    }
    st.checked = seqs.length;
    st.problems = problems;
    st.comparedAt = now().toISOString();
    if (problems.length) st.state = 'mismatch';
    else if (seqs.length === 0) st.state = 'waiting';
    else {
      st.state = 'ok';
      st.matchedAt = st.comparedAt;
    }
  }

  async function runOnce(force: boolean): Promise<FingerprintStatus> {
    const d = o.drive();
    if (!d) {
      st.state = 'off';
      return view();
    }
    const t = now().getTime();
    if (!force && st.lastRunAt) {
      const wait = st.error ? RETRY_MS : compareEvery;
      if (t - Date.parse(st.lastRunAt) < wait) return view();
    }
    const before = st.state;
    st.lastRunAt = now().toISOString();
    try {
      await saveNew(force, d);
      await compare(d);
      st.error = null;
    } catch (err) {
      st.state = 'error';
      st.error = err instanceof DriveError ? err.message : 'The Drive copy could not be read or written.';
      if (!(err instanceof DriveError)) o.log.warn('Drive fingerprint run failed', errorFields(err));
    }
    save();
    // Automatic runs write one line a day when all is well, and one whenever the answer turns bad or good again.
    if (!force && o.audit) {
      try {
        const today = todayLocal(now());
        if (st.state === 'mismatch' && before !== 'mismatch') await o.audit(`Compared the records with Drive (automatic): they do NOT match. ${st.problems[0] ?? ''}`.trim(), 'error');
        else if (st.state === 'ok' && before === 'mismatch') await o.audit('Compared the records with Drive (automatic): they match again', 'ok');
        else if (st.state === 'ok' && st.auditedDay !== today) {
          await o.audit('Compared the records with Drive (daily): they match', 'ok');
          st.auditedDay = today;
          save();
        }
      } catch (err) {
        o.log.warn('Could not write the Drive comparison to the activity record', errorFields(err));
      }
    }
    return view();
  }

  return {
    status: view,
    run(opts) {
      // One run at a time: a person pressing the button while the timer is mid-way gets that run's answer.
      if (running) return running;
      running = runOnce(!!opts?.force).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
