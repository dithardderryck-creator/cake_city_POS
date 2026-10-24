import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { createDriveClient, DriveError, loadDriveCredentials, requestDeviceCode, saveDriveCredentials, waitForDeviceApproval, XLSX_MIME, GOOGLE_SHEET_MIME } from './google-drive';

let g: FakeGoogle;
beforeAll(async () => (g = await startFakeGoogle()));
afterAll(() => g.close());
beforeEach(() => g.files.clear());

const creds = { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', folderName: 'Cake POS' };
const client = (o: { now?: () => number } = {}) => createDriveClient(creds, { endpoints: g.endpoints, ...o });
const bytes = (s: string) => new TextEncoder().encode(s);

describe('google drive', () => {
  // (the sign-out test is last because the stand-in stays signed out afterwards)
  it('makes a folder path once and finds it again', async () => {
    const d = client();
    const a = await d.ensureFolder(['Cake POS', 'Archive']);
    const b = await client().ensureFolder(['Cake POS', 'Archive']);
    expect(b).toBe(a);
    expect([...g.files.values()].map((f) => f.name)).toEqual(['Cake POS', 'Archive']);
  });

  it('uploads bytes and a file from disk, and converts a spreadsheet when asked', async () => {
    const d = client();
    const folder = await d.ensureFolder(['Cake POS']);
    const sheet = await d.upload({ name: 'orders', parentId: folder, source: { bytes: bytes('xlsx-bytes') }, mimeType: XLSX_MIME, convertTo: GOOGLE_SHEET_MIME });
    expect(g.files.get(sheet.id)).toMatchObject({ name: 'orders', mimeType: GOOGLE_SHEET_MIME, parents: [folder] });
    expect(sheet.webViewLink).toContain(sheet.id);

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drive-')), 'b.sqlite');
    const payload = Buffer.alloc(300_000, 7);
    fs.writeFileSync(tmp, payload);
    const up = await d.upload({ name: 'b.sqlite', parentId: folder, source: { path: tmp }, mimeType: 'application/octet-stream' });
    expect(g.files.get(up.id)!.body.equals(payload)).toBe(true);
  });

  it('does not make a second copy when the same name is uploaded again', async () => {
    const d = client();
    const folder = await d.ensureFolder(['Cake POS']);
    const one = await d.upload({ name: 'x.xlsx', parentId: folder, source: { bytes: bytes('1') }, mimeType: XLSX_MIME });
    const two = await d.upload({ name: 'x.xlsx', parentId: folder, source: { bytes: bytes('1') }, mimeType: XLSX_MIME });
    expect(two.id).toBe(one.id);
    expect([...g.files.values()].filter((f) => f.name === 'x.xlsx')).toHaveLength(1);
  });

  it('handles quotes in names', async () => {
    const d = client();
    const folder = await d.ensureFolder(['Cake POS']);
    await d.upload({ name: "Amina's cakes.xlsx", parentId: folder, source: { bytes: bytes('1') }, mimeType: XLSX_MIME });
    expect((await d.find(folder, "Amina's cakes.xlsx"))?.name).toBe("Amina's cakes.xlsx");
  });

  it('lists and removes files, and removing a missing one is fine', async () => {
    const d = client();
    const folder = await d.ensureFolder(['Cake POS']);
    const f = await d.upload({ name: 'a', parentId: folder, source: { bytes: bytes('1') }, mimeType: XLSX_MIME });
    expect((await d.list(folder)).map((x) => x.id)).toEqual([f.id]);
    await d.remove(f.id);
    await d.remove(f.id);
    expect(await d.list(folder)).toEqual([]);
  });

  it('refreshes an expired token by itself and re-uses a good one', async () => {
    let t = 1_000_000;
    const d = client({ now: () => t });
    await d.check();
    const first = g.tokenRequests;
    await d.check();
    expect(g.tokenRequests).toBe(first); // token still good
    t += 3_600_000;
    await d.check();
    expect(g.tokenRequests).toBe(first + 1);
  });

  it('recovers when Google rejects a token that looked fine', async () => {
    const d = client();
    await d.check();
    const before = g.tokenRequests;
    // A new token is issued behind our back (for example by another process), so the cached one stops working.
    await client().check();
    await d.check();
    expect(g.tokenRequests).toBe(before + 2);
  });

  it('marks busy, full and unreachable as different problems', async () => {
    const d = client();
    const folder = await d.ensureFolder(['Cake POS']);
    g.failNext(503);
    const busy = await d.list(folder).catch((e) => e);
    expect(busy).toMatchObject({ status: 503, retryable: true });
    g.failNext(403, 1, 'storageQuotaExceeded');
    const full = await d.list(folder).catch((e) => e);
    expect(full).toMatchObject({ status: 403, retryable: false });
    expect(full.message).toMatch(/full/);
    g.failNext(403, 1, 'rateLimitExceeded');
    expect(await d.list(folder).catch((e) => e)).toMatchObject({ retryable: true });
    const offline = createDriveClient(creds, { endpoints: { ...g.endpoints, token: 'http://127.0.0.1:1/token' } });
    expect(await offline.check().catch((e) => e)).toMatchObject({ status: 0, retryable: true });
  });

  it('forgets a folder that was deleted in Drive, so the next try makes it again', async () => {
    const d = client();
    const folder = await d.ensureFolder(['Cake POS']);
    g.files.delete(folder);
    // Drive answers 404 for an unknown parent; here the stand-in does not check parents, so force it.
    g.failNext(404);
    await d.upload({ name: 'a', parentId: folder, source: { bytes: bytes('1') }, mimeType: XLSX_MIME }).catch(() => undefined);
    const again = await d.ensureFolder(['Cake POS']);
    expect(again).not.toBe(folder);
  });
});

describe('google drive sign-in', () => {
  it('says plainly when the shop has been signed out of Google', async () => {
    const own = await startFakeGoogle();
    own.revoke();
    const err = await createDriveClient(creds, { endpoints: own.endpoints }).check().catch((e) => e);
    await own.close();
    expect(err).toBeInstanceOf(DriveError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/sign this account in again/i);
  });

  it('runs the enter-a-code-on-your-phone flow and waits for approval', async () => {
    g.approveAfter = 3;
    const code = await requestDeviceCode('id', { endpoints: g.endpoints });
    expect(code).toMatchObject({ userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device' });
    let slept = 0;
    const token = await waitForDeviceApproval(creds, code, { endpoints: g.endpoints, sleep: async () => void slept++ });
    expect(token).toBe('refresh-from-device');
    expect(slept).toBeGreaterThanOrEqual(1);
  });

  it('gives up when the code expires', async () => {
    g.approveAfter = 1_000_000;
    const code = { deviceCode: 'dev', userCode: 'X', verificationUrl: 'u', expiresInSeconds: 3, intervalSeconds: 1 };
    let t = 0;
    await expect(waitForDeviceApproval(creds, code, { endpoints: g.endpoints, now: () => t, sleep: async () => void (t += 1500) })).rejects.toThrow(/expired/);
  });

  it('keeps the saved sign-in private and refuses a damaged one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
    const file = path.join(dir, 'sub', 'google-drive.json');
    expect(loadDriveCredentials(file)).toBeNull();
    saveDriveCredentials(file, { ...creds, account: 'owner@example.com' });
    expect(loadDriveCredentials(file)).toMatchObject({ clientId: 'id', refreshToken: 'refresh', folderName: 'Cake POS', account: 'owner@example.com' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    fs.writeFileSync(file, '{not json');
    expect(() => loadDriveCredentials(file)).toThrow(/damaged/);
    fs.writeFileSync(file, '{"clientId":"x"}');
    expect(() => loadDriveCredentials(file)).toThrow(/incomplete/);
  });
});
