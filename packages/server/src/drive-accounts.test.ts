import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupService, createDriveUploader } from './backup';
import { createDriveAccounts, type DriveAccounts } from './drive-accounts';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { DriveError } from './google-drive';
import { silentLogger } from './log';
import { openSqliteStore } from './sqlite-store';

let g: FakeGoogle;
let dir: string;
let file: string;
let drive: DriveAccounts;
let connected: Array<string | null>;
const MB = 1_048_576;
const CLIENT = { clientId: 'client-id-123456.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-1234' };

function open(over: { client?: typeof CLIENT | null } = {}): DriveAccounts {
  return createDriveAccounts({
    file,
    client: over.client ?? null,
    deps: { endpoints: g.endpoints },
    log: silentLogger,
    sleep: async () => undefined,
    onConnected: (e) => void connected.push(e),
  });
}

beforeEach(async () => {
  g = await startFakeGoogle();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-accts-'));
  file = path.join(dir, 'google-drive.json');
  connected = [];
  drive = open();
});
afterEach(async () => {
  await g.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup = async () => {
  expect((await drive.terminal.saveClient(CLIENT.clientId, CLIENT.clientSecret)).ok).toBe(true);
};
async function connectAs(email?: string) {
  if (email) g.approveAs.push(email);
  const r = await drive.terminal.startConnect();
  if (!r.ok) throw new Error(r.error);
  const v = await drive.waitForConnect();
  if (v?.state !== 'done') throw new Error(v?.message ?? 'did not finish');
  return v;
}
const bytes = (n: number) => ({ bytes: new Uint8Array(n) });
async function put(name: string, size = 1000) {
  const folder = await drive.client.ensureFolder(['Cake POS', 'Backups']);
  return drive.client.upload({ name, parentId: folder, source: bytes(size), mimeType: 'application/octet-stream' });
}
const named = (email: string, name: string) => [...g.accountFiles(email).values()].filter((f) => f.name === name);

describe('connecting Google accounts from the app', () => {
  it('needs the Google client ID and secret first, and refuses things that are not them', async () => {
    const st = await drive.terminal.status();
    expect(st).toMatchObject({ clientReady: false, clientFrom: null, accounts: [], connect: null });
    expect((await drive.terminal.startConnect()).ok).toBe(false);
    expect((await drive.terminal.saveClient('short', 'secret-secret')).ok).toBe(false);
    expect((await drive.terminal.saveClient(CLIENT.clientId, 'x')).ok).toBe(false);
    expect((await drive.terminal.saveClient('has a space in it', 'secret-secret')).ok).toBe(false);
    await setup();
    expect(await drive.terminal.status()).toMatchObject({ clientReady: true, clientFrom: 'saved' });
  });

  it('keeps the client details from the server settings and refuses to change them', async () => {
    drive = open({ client: CLIENT });
    expect(await drive.terminal.status()).toMatchObject({ clientReady: true, clientFrom: 'environment' });
    const r = await drive.terminal.saveClient(CLIENT.clientId, CLIENT.clientSecret);
    expect(r.ok).toBe(false);
  });

  it('shows a code, then connects the account, makes its folders and saves the sign-in privately', async () => {
    await setup();
    const started = await drive.terminal.startConnect();
    expect(started).toMatchObject({ ok: true, userCode: 'ABCD-EFGH', url: 'https://www.google.com/device' });
    const waiting = await drive.terminal.status();
    expect(waiting.connect).toMatchObject({ state: 'waiting', userCode: 'ABCD-EFGH' });
    // Only one sign-in at a time.
    expect((await drive.terminal.startConnect()).ok).toBe(false);
    const done = await drive.waitForConnect();
    expect(done).toMatchObject({ state: 'done', email: 'owner@example.com' });
    expect(done?.userCode).toBeUndefined();

    const st = await drive.terminal.status();
    expect(st.accounts).toMatchObject([{ email: 'owner@example.com', state: 'ok', position: 1 }]);
    expect(drive.active()).toBe(true);
    expect(connected).toEqual(['owner@example.com']);
    const names = [...g.files.values()].map((f) => f.name).sort();
    expect(names).toEqual(['Archive', 'Backups', 'Cake POS']);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    // The file never goes in the database, and the status never carries secrets.
    expect(JSON.stringify(st)).not.toMatch(/refresh|secret|GOCSPX/);
  });

  it('adds a second account, and connecting the same one again renews it instead of adding it twice', async () => {
    await setup();
    await connectAs();
    const second = await connectAs('b@example.com');
    expect(second.message).toMatch(/b@example.com is connected/);
    let st = await drive.terminal.status();
    expect(st.accounts.map((a) => [a.position, a.email])).toEqual([[1, 'owner@example.com'], [2, 'b@example.com']]);
    const again = await connectAs('b@example.com');
    expect(again.message).toMatch(/already connected/);
    st = await drive.terminal.status();
    expect(st.accounts).toHaveLength(2);
  });

  it('can be cancelled, and says so', async () => {
    await setup();
    g.approveAfter = 1000; // nobody ever approves
    expect((await drive.terminal.startConnect()).ok).toBe(true);
    expect((await drive.terminal.cancelConnect()).ok).toBe(true);
    expect((await drive.terminal.status()).connect).toMatchObject({ state: 'failed', message: expect.stringMatching(/cancelled/) });
    expect((await drive.terminal.status()).accounts).toEqual([]);
    g.approveAfter = 1;
    expect((await drive.terminal.startConnect()).ok).toBe(true); // a new one can start
    await drive.waitForConnect();
  });

  it('remembers its accounts after a restart, and reads the first single-account file', async () => {
    await setup();
    await connectAs();
    await connectAs('b@example.com');
    const again = open();
    expect((await again.terminal.status()).accounts.map((a) => a.email)).toEqual(['owner@example.com', 'b@example.com']);
    // The first version of the file held one account and no list.
    fs.writeFileSync(file, JSON.stringify({ clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret, refreshToken: 'refresh-from-device', folderName: 'My Shop', connectedAt: '2026-10-01T00:00:00.000Z', account: 'owner@example.com' }));
    const legacy = open();
    expect(legacy.folderName()).toBe('My Shop');
    expect((await legacy.terminal.status()).accounts).toMatchObject([{ id: 'a1', email: 'owner@example.com' }]);
    await legacy.client.upload({ name: 'x', parentId: await legacy.client.ensureFolder(['My Shop', 'Backups']), source: bytes(10), mimeType: 'text/plain' });
    expect(named('owner@example.com', 'x')).toHaveLength(1);
  });

  it('says plainly when the file is damaged, and does not crash', async () => {
    fs.writeFileSync(file, '{ not json');
    const broken = open();
    expect(broken.active()).toBe(false);
    expect((await broken.terminal.status()).problem).toMatch(/damaged/);
  });

  it('notices a change the admin tool made to the file while the server runs', async () => {
    await setup();
    await connectAs();
    expect((await drive.terminal.status()).accounts).toHaveLength(1);
    const other = open(); // another process
    g.approveAs.push('c@example.com');
    await other.terminal.startConnect();
    await other.waitForConnect();
    await new Promise((r) => setTimeout(r, 20));
    expect((await drive.terminal.status()).accounts.map((a) => a.email)).toEqual(['owner@example.com', 'c@example.com']);
  });
});

describe('using several accounts', () => {
  beforeEach(async () => {
    await setup();
    await connectAs();
    await connectAs('b@example.com');
  });

  it('uses the first account until it has no room, then the next, and goes back when room appears', async () => {
    const a = await put('one');
    expect(a.id).toMatch(/^a1~/);
    expect(named('owner@example.com', 'one')).toHaveLength(1);

    g.setLimit('owner@example.com', 10 * MB); // less than the 20 MB kept free
    const b = await put('two');
    expect(b.id).toMatch(/^a2~/);
    expect(named('b@example.com', 'two')).toHaveLength(1);
    let st = await drive.terminal.status();
    expect(st.accounts[0]).toMatchObject({ state: 'full', limitBytes: 10 * MB });
    expect(st.accounts[0]!.problem).toMatch(/Free some space/);
    expect(st.accounts[1]).toMatchObject({ state: 'ok' });

    g.setLimit('owner@example.com', undefined); // the owner freed space or bought more
    await put('three');
    expect(named('owner@example.com', 'three')).toHaveLength(1);
    st = await drive.terminal.status();
    expect(st.accounts[0]).toMatchObject({ state: 'ok' });
  });

  it('moves on when Google itself says the account is full in the middle of an upload', async () => {
    g.setLimit('owner@example.com', 1, true); // Google refuses at the upload although it never said the account was nearly full
    const f = await put('mid');
    expect(f.id).toMatch(/^a2~/);
    expect((await drive.terminal.status()).accounts[0]!.state).toBe('full');
  });

  it('says so, and is not retried as if it were a hiccup, when every account is full', async () => {
    g.setLimit('owner@example.com', 5 * MB);
    g.setLimit('b@example.com', 5 * MB);
    const err = await put('nope').catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.kind).toBe('full');
    expect(err.message).toMatch(/All 2 connected Google accounts are full/);
  });

  it('skips an account that no longer accepts its sign-in, and marks it for signing in again', async () => {
    g.revokeAccount('owner@example.com');
    const f = await put('after-revoke');
    expect(f.id).toMatch(/^a2~/);
    const st = await drive.terminal.status();
    expect(st.accounts[0]).toMatchObject({ state: 'needs_signin' });
    expect(st.accounts[0]!.problem).toMatch(/sign this account in again/i);
    // Signing it in again (same address) renews it.
    await connectAs('owner@example.com');
    expect((await drive.terminal.status()).accounts[0]).toMatchObject({ state: 'ok' });
  });

  it('does not hammer the other accounts when the internet itself is down', async () => {
    const offline = open();
    const other = createDriveAccounts({ file, client: null, deps: { endpoints: { ...g.endpoints, token: 'http://127.0.0.1:1/token' } }, log: silentLogger });
    void offline;
    const err = await other.client.upload({ name: 'x', parentId: await other.client.ensureFolder(['Cake POS', 'Backups']), source: bytes(5), mimeType: 'text/plain' }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.retryable).toBe(true);
    expect(err.kind).toBe('network');
  });

  it('never makes a second copy of a file that already got through, even in the other account', async () => {
    await put('same');
    g.setLimit('owner@example.com', 5 * MB);
    const again = await put('same');
    expect(again.id).toMatch(/^a1~/);
    expect(named('b@example.com', 'same')).toHaveLength(0);
  });

  it('lists and removes across accounts, so the newest few are kept wherever they are', async () => {
    await put('b-1');
    g.setLimit('owner@example.com', 5 * MB);
    await put('b-2');
    const folder = await drive.client.ensureFolder(['Cake POS', 'Backups']);
    const all = await drive.client.list(folder);
    expect(all.map((f) => f.name).sort()).toEqual(['b-1', 'b-2']);
    await drive.client.remove(all.find((f) => f.name === 'b-1')!.id);
    await drive.client.remove(all.find((f) => f.name === 'b-2')!.id);
    expect(await drive.client.list(folder)).toEqual([]);
    expect(named('owner@example.com', 'b-1')).toHaveLength(0);
    expect(named('b@example.com', 'b-2')).toHaveLength(0);
  });

  it('can be reordered, paused, resumed and disconnected', async () => {
    await drive.terminal.move('a2', 'up');
    let st = await drive.terminal.status();
    expect(st.accounts.map((a) => a.email)).toEqual(['b@example.com', 'owner@example.com']);
    expect((await put('first-now')).id).toMatch(/^a2~/);
    expect((await drive.terminal.move('a2', 'up')).ok).toBe(true); // already first: nothing happens

    await drive.terminal.pause('a2', true);
    expect((await drive.terminal.status()).accounts[0]).toMatchObject({ email: 'b@example.com', state: 'paused' });
    expect((await put('while-paused')).id).toMatch(/^a1~/);
    await drive.terminal.pause('a2', false);
    expect((await put('resumed')).id).toMatch(/^a2~/);

    expect(await drive.terminal.remove('a2')).toMatchObject({ ok: true, email: 'b@example.com' });
    st = await drive.terminal.status();
    expect(st.accounts.map((a) => a.email)).toEqual(['owner@example.com']);
    expect((await drive.terminal.remove('a2')).ok).toBe(false);
    // The saved file no longer has it.
    expect(fs.readFileSync(file, 'utf8')).not.toContain('b@example.com');
    // Pausing everything switches the online copy off without forgetting the accounts.
    await drive.terminal.pause('a1', true);
    expect(drive.active()).toBe(false);
    expect(drive.hasAccounts()).toBe(true);
    const err = await put('nowhere').catch((e) => e);
    expect(err.message).toMatch(/No Google account is connected, or all of them are paused/);
  });

  it('checks the accounts and reports usage and problems', async () => {
    g.setLimit('b@example.com', 100 * MB);
    g.revokeAccount('owner@example.com');
    await drive.refresh();
    const st = await drive.terminal.status();
    expect(st.accounts[0]).toMatchObject({ state: 'needs_signin' });
    expect(st.accounts[1]).toMatchObject({ state: 'ok', limitBytes: 100 * MB, usedBytes: 0 });
    expect(st.accounts[1]!.checkedAt).not.toBeNull();
    expect((await drive.terminal.test('a1')).ok).toBe(true);
    expect((await drive.terminal.test('nobody')).ok).toBe(false);
  });
});

describe('backups use the accounts', () => {
  it('upload to Drive only while an account is switched on, and a disconnected Drive is not "pending"', async () => {
    await setup();
    const store = openSqliteStore(path.join(dir, 'db.sqlite'));
    const svc = createBackupService({
      store,
      exclusive: (fn) => fn(),
      dir: path.join(dir, 'b'),
      keep: 30,
      uploaders: [createDriveUploader(drive.client, drive.folderName, 5, () => drive.active())],
      hour: 2,
      minute: 0,
      log: silentLogger,
    });
    await svc.runNow();
    expect(await svc.status()).toMatchObject({ pendingUploads: 0 });
    expect([...g.files.values()].filter((f) => /^cakepos-.*\.sqlite$/.test(f.name))).toHaveLength(0);

    await connectAs();
    await connectAs('b@example.com');
    g.setLimit('owner@example.com', 5 * MB);
    await new Promise((r) => setTimeout(r, 1100)); // the next backup file gets a new name
    await svc.runNow();
    // The first account is full, so the copy went to the second.
    expect([...g.accountFiles('b@example.com').values()].filter((f) => /^cakepos-.*\.sqlite$/.test(f.name)).length).toBeGreaterThanOrEqual(1);
    expect(await svc.status()).toMatchObject({ pendingUploads: 0, lastError: null });
    store.close();
  });
});
