// Registered devices in a real browser: an unknown browser sees only the pairing page, the owner makes a code,
// a second browser registers with it, signs in, and is shut out the moment the owner revokes it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, until } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-devices';
fs.mkdirSync(shots, { recursive: true });
const shop = await startShop({ requireDevice: true });
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  // Refusals (403 for an unregistered device, 429) are expected here and shown on the page; only real script errors count.
  p.on('console', (m) => m.type() === 'error' && !/status of (401|403|422|429)/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const vis = (p, s) => p.locator(s).first().isVisible();
async function typeCode(page, text) {
  await page.fill('#code', '');
  await page.type('#code', text);
  await page.click('#pairgo');
}
try {
  /* ---- a browser nobody has registered ---- */
  const c1 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const owner = await c1.newPage();
  watch(owner, 'owner');
  await owner.goto(shop.base + '/');
  await owner.waitForSelector('#pair:not([hidden])');
  assert.equal(await vis(owner, '#pick'), false, 'no staff list before registering');
  assert.equal(await vis(owner, '#pin'), false);
  const body = await owner.innerText('body');
  assert.doesNotMatch(body, /Amina|Baraka|Neema|Juma/, 'no names shown to an unregistered device');
  assert.match(body, /not registered/i);
  assert.equal(await owner.isDisabled('#pairgo'), true, 'Register is off until the code is complete');
  await owner.screenshot({ path: `${shots}/pair-phone.png` });

  // The staff list is refused at the server too, not just hidden.
  const raw = await owner.evaluate(async () => (await fetch('/api/staff')).status);
  assert.equal(raw, 403);

  // A wrong code is explained, and the page stays usable.
  await typeCode(owner, 'zzzz9999');
  await owner.waitForSelector('.msg.err');
  assert.match(await owner.innerText('#msg'), /not valid|expired|used/i);
  assert.equal(await owner.inputValue('#code'), 'ZZZZ-9999', 'typed code is tidied into XXXX-XXXX');

  // The right code, typed small and without the dash, registers this browser.
  const first = shop.deviceCode('Office laptop');
  await typeCode(owner, first.replace('-', '').toLowerCase());
  await owner.waitForSelector('#pick button');
  assert.equal(await owner.locator('#pick button').count(), 5);
  assert.match(await owner.innerText('#foot'), /Office laptop/);
  // The same code cannot be used again, even by the same browser.
  const again = await owner.evaluate(async (code) => (await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).status, first);
  assert.equal(again, 403);

  // It survives a reload: still registered, no code asked for.
  await owner.reload();
  await owner.waitForSelector('#pick button');
  assert.equal(await vis(owner, '#pair'), false);

  /* ---- the owner makes a code for a tablet ---- */
  await owner.setViewportSize({ width: 1280, height: 800 });
  await signInAs(owner, shop.base, 'owner');
  await owner.waitForSelector('#hello');
  await owner.click('nav.xtabs [data-v="staff"]');
  await owner.waitForSelector('#dvb .list');
  assert.match(await owner.innerText('#dvb'), /Office laptop/);
  assert.match(await owner.innerText('#dvb'), /This device/);
  assert.equal(await owner.locator('#dvb [data-v="rev"]').count(), 0, 'cannot revoke the device in use');

  await owner.click('#dvb [data-v="mk"]');
  assert.match(await owner.innerText('.toast'), /Name the device/i, 'an empty name is explained');
  await owner.fill('#dvb [data-k="dn"]', 'Counter tablet');
  await owner.click('#dvb [data-v="mk"]');
  await owner.waitForSelector('#dvcode');
  const code = (await owner.innerText('#dvcode')).trim();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await owner.screenshot({ path: `${shots}/owner-code.png`, fullPage: false });

  /* ---- a second browser registers with it and signs in as the cashier ---- */
  const c2 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const tablet = await c2.newPage();
  watch(tablet, 'tablet');
  await tablet.goto(shop.base + '/');
  await tablet.waitForSelector('#pair:not([hidden])');
  await typeCode(tablet, code);
  await tablet.waitForSelector('#pick button');
  await signInAs(tablet, shop.base, 'cashier');
  await tablet.waitForURL('**/cashier.html');

  // The owner's code card goes away by itself once the device is registered, and the device is listed.
  await until(async () => (await owner.locator('#dvcode').count()) === 0, 'code box closes after use');
  await until(async () => /Counter tablet/.test(await owner.innerText('#dvb')), 'tablet listed');
  assert.equal(await owner.locator('#dvb [data-v="rev"]').count(), 1);

  /* ---- revoke ---- */
  owner.once('dialog', (d) => d.accept());
  await owner.click('#dvb [data-v="rev"]');
  // The tablet is signed out by itself and lands on the registration page.
  await tablet.waitForSelector('#pair:not([hidden])', { timeout: 10000 });
  assert.doesNotMatch(await tablet.innerText('body'), /Amina|Baraka/);
  await until(async () => /Revoked devices \(1\)/.test(await owner.innerText('#dvb')), 'revoked list shows it');
  // A revoked browser stays out even if it asks again.
  const status = await tablet.evaluate(async () => (await fetch('/api/staff', { headers: { 'x-device-token': localStorage.getItem('cake-pos-device') || 'x' } })).status);
  assert.equal(status, 403);
  await tablet.reload();
  await tablet.waitForSelector('#pair:not([hidden])');

  // The owner's own browser is unaffected.
  assert.match(await owner.innerText('#dvb'), /Office laptop/);

  /* ---- a browser that lost its registration is re-registered under the same name ---- */
  await owner.fill('#dvb [data-k="dn"]', 'Back phone');
  await owner.click('#dvb [data-v="mk"]');
  await owner.waitForSelector('#dvcode');
  const c3 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const phone = await c3.newPage();
  watch(phone, 'phone');
  await phone.goto(shop.base + '/');
  await phone.waitForSelector('#pair:not([hidden])');
  await typeCode(phone, (await owner.innerText('#dvcode')).trim());
  await phone.waitForSelector('#pick button');
  await until(async () => /Back phone/.test(await owner.innerText('#dvb')), 'phone listed');
  // Its browser data is wiped (or it is a new browser): it is unregistered again, and the same name cannot be reused plainly.
  await phone.evaluate(() => localStorage.clear());
  await phone.reload();
  await phone.waitForSelector('#pair:not([hidden])');
  await owner.fill('#dvb [data-k="dn"]', 'Back phone');
  await owner.click('#dvb [data-v="mk"]');
  await until(async () => /already registered/i.test(await owner.innerText('.toast')), 'a plain code under a used name is refused');
  const phoneRow = owner.locator('#dvb li:has([data-v="rev"])', { hasText: 'Back phone' });
  await phoneRow.locator('[data-v="rep"]').click();
  await owner.waitForSelector('#dvcode');
  assert.match(await owner.innerText('#dvb'), /replaces the old registration/);
  await typeCode(phone, (await owner.innerText('#dvcode')).trim());
  await phone.waitForSelector('#pick button');
  await until(async () => (await owner.locator('#dvb li:has([data-v="rev"])', { hasText: 'Back phone' }).count()) === 1 && (await owner.locator('#dvcode').count()) === 0, 'listed once after re-registering').catch(async (e) => { throw new Error(e.message + ' | ' + (await owner.innerText('#dvb')).slice(0, 700)); });

  /* ---- IT has its own page and can revoke too ---- */
  const c4 = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const itp = await c4.newPage();
  watch(itp, 'it');
  await itp.goto(shop.base + '/');
  await itp.waitForSelector('#pair:not([hidden])');
  await typeCode(itp, shop.deviceCode('IT laptop'));
  await itp.waitForSelector('#pick button');
  await signInAs(itp, shop.base, 'it');
  await itp.waitForURL('**/it.html');
  await itp.waitForSelector('#dvb .list');
  assert.match(await itp.innerText('#dvb'), /Back phone/);
  await itp.screenshot({ path: `${shots}/it-devices.png` });
  assert.equal(await itp.locator('#dvb li', { hasText: 'IT laptop' }).locator('[data-v="rev"]').count(), 0, 'IT cannot revoke the device in use');
  itp.once('dialog', (d) => d.accept());
  await itp.locator('#dvb li:has([data-v="rev"])', { hasText: 'Back phone' }).locator('[data-v="rev"]').click();
  await until(async () => (await itp.locator('#dvb li:has([data-v="rev"])', { hasText: 'Back phone' }).count()) === 0, 'IT list drops the revoked phone');
  await phone.reload();
  await phone.waitForSelector('#pair:not([hidden])');

  assert.deepEqual(errs, []);
  console.log('devices ok');
} finally {
  await browser.close();
  await shop.stop();
}
