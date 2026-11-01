import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, linkId, seedDemo, todayLocal, type AuditEntry, type ChainHead, type ChainLink, type Store } from '@cake-pos/panel';
import { createFingerprintService } from './fingerprint';
import { DriveError, type DriveClient, type DriveFile } from './google-drive';
import type { Logger } from './log';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, close() {} };
let t = Date.UTC(2026, 10, 1, 8, 0, 0);
const clock = { now: () => new Date(t) };
const hours = (h: number) => (t += h * 3_600_000);

/** A Drive that lives in memory: folders by path, files by name. */
function fakeDrive() {
  const files = new Map<string, DriveFile[]>();
  const state = { down: null as DriveError | null, uploads: 0 };
  const client: DriveClient = {
    async ensureFolder(segments) {
      return segments.join('/');
    },
    async upload(a) {
      if (state.down) throw state.down;
      const list = files.get(a.parentId) ?? [];
      const have = list.find((f) => f.name === a.name);
      if (have) return have;
      const f = { id: `f${++state.uploads}`, name: a.name };
      files.set(a.parentId, [...list, f]);
      return f;
    },
    async find(p, n) {
      return (files.get(p) ?? []).find((f) => f.name === n);
    },
    async list(p) {
      if (state.down) throw state.down;
      return files.get(p) ?? [];
    },
    async remove(id) {
      for (const [k, v] of files) files.set(k, v.filter((f) => f.id !== id));
    },
    async check() {
      return {} as never;
    },
  };
  return { client, files, state, names: () => [...files.values()].flat().map((f) => f.name) };
}

let store: Store;
let drive: ReturnType<typeof fakeDrive>;
let on = true;
let dir: string;
const audits: { summary: string; outcome: string }[] = [];

function service(extra: Partial<Parameters<typeof createFingerprintService>[0]> = {}) {
  return createFingerprintService({
    store,
    drive: () => (on ? { client: drive.client, folderName: 'Cake POS' } : null),
    statePath: path.join(dir, 'fp.json'),
    log,
    now: clock.now,
    audit: async (summary, outcome) => void audits.push({ summary, outcome }),
    ...extra,
  });
}

beforeEach(async () => {
  t = Date.UTC(2026, 10, 1, 8, 0, 0);
  store = createMemoryStore();
  const panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  drive = fakeDrive();
  on = true;
  audits.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
});

/** Another action in the shop, so the chain moves on. */
const moveOn = async () => {
  const panel = createPanel({ store, clock });
  await panel.dispatch('auth/sign_in', { userId: 'nobody', pin: '0000' }).catch(() => undefined);
};

describe('the Drive copy of the chain fingerprint', () => {
  it('saves the newest fingerprint with everything in its name, and finds it matching', async () => {
    const fp = service();
    const s = await fp.run({ force: true });
    expect(drive.names()).toHaveLength(1);
    expect(drive.names()[0]).toMatch(/^chain_2026-11-01_s\d{10}_[0-9a-f]{64}$|^chain_2026-11-01_s\d{10}_[0-9a-f]{64}\.txt$/);
    expect(s).toMatchObject({ state: 'ok', matchedToday: true, problems: [], late: false });
    expect(s.checked).toBe(1);
  });

  it('writes nothing new while the records have not moved, and again once they have and time has passed', async () => {
    const fp = service();
    await fp.run({ force: true });
    hours(7);
    await fp.run({ force: true });
    expect(drive.names()).toHaveLength(1);
    await moveOn();
    hours(1);
    await fp.run();
    expect(drive.names()).toHaveLength(1); // saved less than 6 hours ago, and not due to compare yet
    hours(7);
    await fp.run();
    expect(drive.names()).toHaveLength(2);
  });

  it('says so plainly when a record was rewritten after its fingerprint was saved', async () => {
    const fp = service();
    await fp.run({ force: true });
    const head = (await store.get<ChainHead>('chainHead', 'head'))!.seq;
    const l = (await store.get<ChainLink>('chain', linkId(head)))!;
    await store.put('chain', { ...l, hash: 'f'.repeat(64) });
    const s = await fp.run({ force: true });
    expect(s.state).toBe('mismatch');
    expect(s.problems[0]).toMatch(new RegExp(`Record ${head} does not match`));
    expect(s.matchedToday).toBe(true); // the earlier match is not erased, but the state is what counts
  });

  it('notices a record that Drive remembers and the database no longer has', async () => {
    const fp = service();
    await fp.run({ force: true });
    const head = (await store.get<ChainHead>('chainHead', 'head'))!.seq;
    await store.delete('chain', linkId(head));
    const s = await fp.run({ force: true });
    expect(s.state).toBe('mismatch');
    expect(s.problems[0]).toMatch(/no longer have it/);
  });

  it('ignores stray files in the folder', async () => {
    const fp = service();
    await fp.run({ force: true });
    drive.files.get('Cake POS/Fingerprints')!.push({ id: 'x', name: 'notes.txt' }, { id: 'y', name: 'chain_2026-11-01_s0000000001_zz.txt' });
    expect((await fp.run({ force: true })).state).toBe('ok');
  });

  it('is off without a Google account and never throws', async () => {
    on = false;
    const s = await service().run({ force: true });
    expect(s.state).toBe('off');
    expect(drive.names()).toHaveLength(0);
  });

  it('keeps going when Drive cannot be reached, retries soon, and recovers', async () => {
    const fp = service();
    await fp.run({ force: true });
    drive.state.down = new DriveError('Could not reach Google (offline).', 0, true, 'network');
    hours(4);
    const bad = await fp.run();
    expect(bad).toMatchObject({ state: 'error', error: expect.stringContaining('Could not reach Google') });
    drive.state.down = null;
    t += 5 * 60_000;
    expect((await fp.run()).state).toBe('error'); // too soon to try again
    t += 6 * 60_000;
    expect((await fp.run()).state).toBe('ok');
  });

  it('flags a copy that has not reached Drive for more than a day while the records moved on', async () => {
    const fp = service();
    await fp.run({ force: true });
    drive.state.down = new DriveError('Google needs a new sign-in.', 401, false, 'auth');
    await moveOn();
    hours(25);
    const s = await fp.run({ force: true });
    expect(s.late).toBe(true);
    drive.state.down = null;
    expect((await fp.run({ force: true })).late).toBe(false);
  });

  it('writes one "they match" line a day for automatic runs, a line when it turns bad and when it recovers, and none for a person\'s own run', async () => {
    const fp = service();
    await fp.run({ force: true });
    expect(audits).toHaveLength(0);
    hours(4);
    await fp.run();
    hours(4);
    await fp.run();
    expect(audits.map((a) => a.summary)).toEqual(['Compared the records with Drive (daily): they match']);
    const head = (await store.get<ChainHead>('chainHead', 'head'))!.seq;
    const l = (await store.get<ChainLink>('chain', linkId(head)))!;
    await store.put('chain', { ...l, hash: 'a'.repeat(64) });
    hours(4);
    await fp.run();
    expect(audits.at(-1)).toMatchObject({ outcome: 'error', summary: expect.stringContaining('do NOT match') });
    hours(4);
    await fp.run();
    expect(audits).toHaveLength(2); // still bad: no repeat
    await store.put('chain', l);
    hours(4);
    await fp.run();
    expect(audits.at(-1)?.summary).toMatch(/match again/);
  });

  it('remembers across a restart', async () => {
    await service().run({ force: true });
    const s = await service().status();
    expect(s).toMatchObject({ state: 'ok', matchedToday: true });
    expect(todayLocal(new Date(s.matchedAt!))).toBe(todayLocal(clock.now()));
  });

  it('holds only a code: nothing about people, amounts or names reaches Drive', async () => {
    await service().run({ force: true });
    const audit = await store.list<AuditEntry>('audit');
    const name = drive.names()[0]!;
    for (const a of audit) expect(name).not.toContain(a.actorName ?? '\u0000');
  });
});
