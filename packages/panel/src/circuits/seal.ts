import type { AuditEntry, ChainCheck, ChainHead, ChainLink } from '../domain';
import type { Clock, Ids, Store } from '../ports';
import { sha256Hex } from '../ports';

/**
 * The sealed chain. Every audit entry gets a link: the fingerprint of the entry, joined to the link before it.
 * Change an entry, remove a link or slip one in, and the check no longer adds up.
 *
 * What it can and cannot do: it shows that records were changed or removed after the fact, by mistake, by a bug, by staff or by an outsider.
 * It cannot stop someone who runs the server and holds every key from rewriting the whole chain and sealing it again.
 * That is why the owner's Google Drive keeps a copy of the closing fingerprint of each day, which that person cannot reach.
 */

export const GENESIS_SEED = 'cake-pos chain v1';
export const linkId = (seq: number) => `c${String(seq).padStart(12, '0')}`;
export const MAX_PROBLEMS = 10;

export interface SealEnv {
  store: Store;
  ids: Ids;
  clock: Clock;
}

/** The entry written as the same text every time, so the same entry always has the same fingerprint. */
export function canonicalEntry(a: AuditEntry): string {
  return JSON.stringify([a.id, a.at, a.actorId ?? null, a.actorName ?? null, a.role ?? null, a.intent, a.target ?? null, a.summary, a.outcome]);
}
export const entryFingerprint = (a: AuditEntry) => sha256Hex(`e1|${canonicalEntry(a)}`);
const linkFingerprint = (l: Omit<ChainLink, 'hash' | 'id'>) => sha256Hex(['l1', l.seq, l.at, l.auditId, l.kind, l.actorId ?? '', l.outcome, l.entryHash, l.prev].join('|'));

/** The short reference people read and quote: the first eight characters of the link's hash, in two halves. */
export const refOf = (hash: string) => `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase();

let genesisHash: Promise<string> | undefined;
export const genesis = () => (genesisHash ??= sha256Hex(GENESIS_SEED));

/**
 * Writes one audit entry and its link together. Every place that records what happened calls this and nothing else,
 * so an action and its seal are saved in one step or not at all (inside the action's own transaction when there is one).
 */
export async function appendAudit(env: SealEnv, entry: Omit<AuditEntry, 'id' | 'at'>, at?: string): Promise<AuditEntry> {
  const { store, ids, clock } = env;
  return store.transaction(async () => {
    const audit: AuditEntry = { id: ids.next('aud'), at: at ?? clock.now().toISOString(), ...entry };
    const head = (await store.get<ChainHead>('chainHead', 'head')) ?? { id: 'head' as const, seq: 0, hash: await genesis(), since: audit.at, unsealed: (await store.list<AuditEntry>('audit')).length };
    const seq = head.seq + 1;
    const base = { seq, at: audit.at, auditId: audit.id, kind: audit.intent, ...(audit.actorId ? { actorId: audit.actorId } : {}), outcome: audit.outcome, entryHash: await entryFingerprint(audit), prev: head.hash };
    const link: ChainLink = { id: linkId(seq), ...base, hash: await linkFingerprint(base) };
    await store.put('audit', audit);
    await store.put('chain', link);
    await store.put<ChainHead>('chainHead', { ...head, seq, hash: link.hash });
    return audit;
  });
}

export interface VerifyOptions {
  /** Check from the very first link and look for entries that were slipped in. Otherwise only what is new since the last good check. */
  full?: boolean;
}

/** Checks the chain and records the result. Safe to run at any time; it only reads the chain and writes the result of the check. */
export async function verifyChain(env: SealEnv, o: VerifyOptions = {}): Promise<ChainCheck> {
  const { store, clock } = env;
  const at = clock.now().toISOString();
  const head = await store.get<ChainHead>('chainHead', 'head');
  const problems: string[] = [];
  const bad = (m: string) => problems.length < MAX_PROBLEMS && problems.push(m);
  if (!head) {
    const empty: ChainCheck = { id: 'last', at, ok: true, mode: o.full ? 'full' : 'new', upTo: 0, hashAtUpTo: await genesis(), checked: 0, detailsGone: 0, problems };
    await store.put('chainChecks', empty);
    return empty;
  }

  let start = 0;
  let prev = await genesis();
  const good = o.full ? undefined : await store.get<ChainCheck>('chainChecks', 'good');
  if (good && good.ok && good.upTo > 0 && good.upTo <= head.seq) {
    const anchor = await store.get<ChainLink>('chain', linkId(good.upTo));
    if (anchor && anchor.hash === good.hashAtUpTo && (await linkFingerprint(anchor)) === anchor.hash) {
      start = good.upTo;
      prev = anchor.hash;
    } else bad(`Record ${good.upTo}, which was proven intact before, has changed or is gone. Checking everything from the start.`);
  }
  if (problems.length) {
    start = 0;
    prev = await genesis();
  }

  let checked = 0;
  let detailsGone = 0;
  let lastGoodSeq = start;
  let lastGoodHash = prev;
  let broken = problems.length > 0;
  const seen = new Set<string>();
  for (let seq = start + 1; seq <= head.seq; seq++) {
    const link = await store.get<ChainLink>('chain', linkId(seq));
    checked++;
    if (!link) {
      bad(`Record ${seq} is missing from the chain.`);
      broken = true;
      break;
    }
    seen.add(link.auditId);
    const again = await linkFingerprint(link);
    if (link.seq !== seq || link.prev !== prev || link.hash !== again) {
      bad(`Record ${seq} does not match the one before it, or was changed.`);
      broken = true;
      break;
    }
    const audit = await store.get<AuditEntry>('audit', link.auditId);
    if (!audit) detailsGone++;
    else if ((await entryFingerprint(audit)) !== link.entryHash) {
      bad(`The activity entry for record ${seq} was changed after it was sealed.`);
      broken = true;
    }
    prev = link.hash;
    if (!broken) {
      lastGoodSeq = seq;
      lastGoodHash = link.hash;
    }
  }
  if (!broken && prev !== head.hash) {
    bad('The end of the chain does not match its last record.');
    broken = true;
  }
  if (!broken && (await store.get<ChainLink>('chain', linkId(head.seq + 1)))) {
    bad('There are records after the end of the chain.');
    broken = true;
  }

  // Entries that were slipped in: in the activity record, after sealing began, with no link.
  if (!broken || problems.length < MAX_PROBLEMS) {
    const sealed = new Set<string>(seen);
    let rows: AuditEntry[];
    if (o.full) {
      // Everything: collect the ids of every link, not only the ones read above.
      for (let seq = 1; seq <= start; seq++) {
        const l = await store.get<ChainLink>('chain', linkId(seq));
        if (l) sealed.add(l.auditId);
      }
      rows = await store.list<AuditEntry>('audit');
    } else {
      // A quick check: the newest entries must be among the newest links.
      for (let seq = Math.max(1, head.seq - 600); seq <= head.seq; seq++) {
        const l = await store.get<ChainLink>('chain', linkId(seq));
        if (l) sealed.add(l.auditId);
      }
      rows = await store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'desc' }, limit: 300 });
    }
    // The full check counts every entry with no seal against the number there were when sealing began (entries only ever leave, when archived).
    // The quick check looks at the newest entries only.
    const unsealed = o.full ? rows.filter((r) => !sealed.has(r.id)) : rows.filter((r) => r.at >= head.since && !sealed.has(r.id));
    const allowed = o.full ? (head.unsealed ?? 0) : 0;
    if (unsealed.length > allowed) {
      const extra = unsealed.length - allowed;
      bad(`${extra} ${extra === 1 ? 'entry was' : 'entries were'} found in the activity record with no seal.`);
      broken = true;
    }
  }

  const result: ChainCheck = { id: 'last', at, ok: !broken && problems.length === 0, mode: o.full ? 'full' : 'new', upTo: lastGoodSeq, hashAtUpTo: lastGoodHash, checked, detailsGone, problems };
  await store.put('chainChecks', result);
  if (result.ok) await store.put('chainChecks', { ...result, id: 'good' as const });
  return result;
}
