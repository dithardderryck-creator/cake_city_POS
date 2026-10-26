// Google accounts from the Owner and IT screens: sign in by code, several accounts, order, pause, check, disconnect.
// Google itself is replaced by the stand-in the server tests use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { startShop, loadPlaywright, until, PINS, menuGo } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegoogle-'));
buildSync({ entryPoints: [path.join(here, '../../../packages/server/src/fake-google.ts')], outfile: path.join(tmp, 'fake-google.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { startFakeGoogle } = await import(path.join(tmp, 'fake-google.mjs'));
const g = await startFakeGoogle();

const { chromium } = loadPlaywright();
const shop = await startShop({ env: { GOOGLE_ENDPOINTS_JSON: JSON.stringify(g.endpoints) } });
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of (422|403)|Failed to load resource/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const MB = 1_048_576;

async function open(role) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  watch(p, role);
  p.on('dialog', (d) => void d.accept());
  await p.goto(shop.base + '/');
  await p.locator('#pick button', { hasText: new RegExp(`^.*${role}$`, 'i') }).first().click();
  for (const d of PINS[role]) await p.click(`#pad button[data-k="${d}"]`);
  await p.click('#ok');
  await p.waitForURL(`**/${role}.html`);
  return p;
}
const rows = (p) => p.locator('#drv .cx-ac[data-id]');
const emails = async (p) => (await rows(p).locator('.cx-ach b').allInnerTexts()).map((t) => t.replace(/^\d+ · /, ''));

try {
  const owner = await open('owner');
  await until(async () => {
    if (!(await owner.locator('#dpn [data-s="online"]').isVisible())) await menuGo(owner, 'settings');
    return owner.locator('#dpn [data-s="online"]').isVisible();
  }, 'the settings list opens');
  assert.match(await owner.locator('#dpn [data-s="online"]').innerText(), /Google accounts/);
  await owner.click('#dpn [data-s="online"]');
  await owner.waitForSelector('#drv');
  await until(async () => /No Google account is connected yet/.test(await owner.locator('#drv').innerText()), 'empty state');
  // Without the Google client details nothing can be connected, and the screen says what to do.
  assert.match(await owner.locator('#drv').innerText(), /Set up Google first/);
  await owner.fill('#cx-gid', 'short');
  await owner.fill('#cx-gsec', 'also-short');
  await owner.click('#drv [data-x="client"]');
  await until(async () => /does not look like a Google client ID/.test(await owner.locator('body').innerText()), 'a bad client ID is refused in plain words');
  await owner.fill('#cx-gid', 'client-id-123456.apps.googleusercontent.com');
  await owner.fill('#cx-gsec', 'GOCSPX-secret-1234');
  await owner.click('#drv [data-x="client"]');
  await owner.waitForSelector('#drv [data-x="add"]');

  /* First account: a code to type on google.com/device, then the account appears by itself. */
  await owner.click('#drv [data-x="add"]');
  await owner.waitForSelector('#drv .cx-code strong');
  assert.equal(await owner.locator('#drv .cx-code strong').innerText(), 'ABCD-EFGH');
  assert.match(await owner.locator('#drv .cx-code').innerText(), /google\.com\/device/);
  await until(async () => (await emails(owner)).length === 1, 'the first account appears', 20000);
  assert.deepEqual(await emails(owner), ['owner@example.com']);
  assert.match(await rows(owner).first().innerText(), /Working/);
  await until(async () => /is connected/.test(await owner.locator('#drv').innerText()), 'a message says it is connected');
  await owner.click('#drv [data-x="dismiss"]');

  /* Second account. */
  g.approveAs.push('b@example.com');
  await owner.click('#drv [data-x="add"]');
  await until(async () => (await emails(owner)).length === 2, 'the second account appears', 20000);
  assert.deepEqual(await emails(owner), ['owner@example.com', 'b@example.com']);

  /* Order: the second goes first. Pause and resume. */
  await rows(owner).nth(0).locator('[data-x="down"]').click();
  await until(async () => (await emails(owner))[0] === 'b@example.com', 'the order changes');
  await rows(owner).nth(1).locator('[data-x="pause"]').click();
  await until(async () => /Paused/.test(await rows(owner).nth(1).innerText()), 'paused');
  await rows(owner).nth(1).locator('[data-x="pause"]').click();
  await until(async () => !/Paused/.test(await rows(owner).nth(1).innerText()), 'resumed');

  /* The Settings list shows how many accounts there are. */
  await owner.click('#dpn [data-d="secback"]');
  await until(async () => /2 accounts/.test(await owner.locator('#dpn [data-s="online"]').innerText()), 'the list says 2 accounts');
  await owner.click('#dpn [data-d="close"]');

  /* IT sees and manages the same accounts, and sees when one is full. */
  const it = await open('it');
  await it.waitForSelector('#drv .cx-ac[data-id]');
  assert.deepEqual(await emails(it), ['b@example.com', 'owner@example.com']);
  g.setLimit('b@example.com', 5 * MB);
  await rows(it).nth(0).locator('[data-x="test"]').click();
  await until(async () => /Full/.test(await rows(it).nth(0).innerText()), 'the full account is marked');
  assert.match(await rows(it).nth(0).innerText(), /Free some space/);
  g.revokeAccount('owner@example.com');
  await rows(it).nth(1).locator('[data-x="test"]').click();
  await until(async () => /Sign in again/.test(await rows(it).nth(1).innerText()), 'the signed-out account asks for a new sign-in');
  assert.ok(await rows(it).nth(1).locator('button[data-x="signin"]').isVisible());
  // Signing it in again (the same Google account) renews it instead of adding a third.
  g.approveAs.push('owner@example.com');
  await rows(it).nth(1).locator('button[data-x="signin"]').click();
  await until(async () => /Working/.test(await rows(it).nth(1).innerText()), 'the account works again', 20000);
  assert.equal((await emails(it)).length, 2);

  /* Disconnecting asks first (the test accepts), and the account is gone. */
  await rows(it).nth(0).locator('[data-x="remove"]').click();
  await until(async () => (await emails(it)).length === 1, 'the account is disconnected');
  assert.deepEqual(await emails(it), ['owner@example.com']);

  assert.deepEqual(errs, [], 'no page errors');
  console.log('google accounts ok');
} finally {
  await browser.close();
  await shop.stop();
  await g.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
