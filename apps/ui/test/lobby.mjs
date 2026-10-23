// The location check: staff away from the shop are held in a lobby, the owner and IT never are,
// the check can be switched off by the owner or by IT, and everyone has a My account sheet.
import assert from 'node:assert/strict';
import { startShop, loadPlaywright, actor, until, PINS } from './harness.mjs';
const { chromium } = loadPlaywright();
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of (422|403)|Failed to load resource/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const SHOP = { latitude: -6.8, longitude: 39.28, accuracy: 20 };
const FAR = { latitude: -6.75, longitude: 39.28, accuracy: 20 }; // about 5.5 km north
const NEAR = { latitude: -6.8005, longitude: 39.2802, accuracy: 20 }; // about 60 m away

async function page(role, geo, label = role) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...(geo ? { geolocation: geo, permissions: ['geolocation'] } : {}) });
  const p = await ctx.newPage();
  watch(p, label);
  await p.goto(shop.base + '/');
  await p.locator('#pick button', { hasText: new RegExp(`^.*${role}$`, 'i') }).first().click();
  for (const d of PINS[role]) await p.click(`#pad button[data-k="${d}"]`);
  await p.click('#ok');
  await p.waitForURL(`**/${role}.html`);
  return { p, ctx };
}
const lobby = (p) => p.locator('#cx-lobby').isVisible();

try {
  const owner = await actor(browser, shop, 'owner', watch);
  const it = await actor(browser, shop, 'it', watch);

  /* The check is off to begin with, and cannot be switched on before the shop has a spot. */
  assert.equal((await owner.read('location_check')).enabled, false);
  const early = await owner.send('settings/set_location', { enabled: true });
  assert.equal(early.ok, false, 'no spot yet, so it cannot be switched on');

  /* The owner sets the spot from the Settings screen with "Use where I am now", then switches the check on. */
  const { p: op, ctx: octx } = await page('owner', SHOP);
  // The settings button does nothing until the shop settings have loaded, so press it until the list is there.
  await until(async () => {
    if (!(await op.locator('#dpn [data-s="location"]').isVisible())) await op.click('#xset');
    return op.locator('#dpn [data-s="location"]').isVisible();
  }, 'the settings list opens');
  await op.click('#dpn [data-d="sec"][data-s="location"]');
  await op.click('#dpn [data-d="locspot"]');
  await until(async () => (await owner.read('location_check')).spotSet, 'shop spot saved');
  await op.check('#dpn [data-k="le"]');
  await op.click('#dpn [data-d="secsave"]');
  await until(async () => (await owner.read('location_check')).enabled, 'check switched on');
  assert.equal(await lobby(op), false, 'the owner is never held');

  /* A cashier far away is held in the lobby and told how far. */
  const far = await page('cashier', FAR);
  await until(() => lobby(far.p), 'cashier held in the lobby');
  assert.match(await far.p.locator('#cx-lb-why').innerText(), /km from the shop/);
  assert.equal((await owner.read('location_check')).heldNow, 1);
  // The server refuses work from that session even if the screen is bypassed.
  const blocked = await far.p.evaluate(() => Cake.client.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'X', deliveryDate: '2030-01-01' }));
  assert.equal(blocked.ok, false);
  assert.match(JSON.stringify(blocked), /outside the shop/);

  /* Walking into the shop and tapping Check again opens the work screens. */
  await far.ctx.setGeolocation(NEAR);
  await far.p.click('#cx-lb-again');
  await until(async () => !(await lobby(far.p)), 'lobby closes inside the fence');
  const ok = await far.p.evaluate(() => Cake.client.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Walk-in', deliveryDate: '2030-01-01' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));

  /* Walking out again holds them again. */
  await far.ctx.setGeolocation(FAR);
  await far.p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await far.p.evaluate(() => window.dispatchEvent(new Event('focus')));
  // (the page re-checks every two minutes and when it comes to the front; the test asks directly)
  await far.p.evaluate(() => Cake.client.dispatch('session/report_place', { lat: -6.75, lng: 39.28, accuracyM: 20 }));
  const again = await far.p.evaluate(() => Cake.client.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Y', deliveryDate: '2030-01-01' }));
  assert.equal(again.ok, false, 'held again after walking out');
  await far.ctx.close();

  /* A phone that refuses to share its location is held with a clear reason (the shop is never locked out of its PIN). */
  const denied = await page('cashier', null, 'cashier-denied');
  await until(() => lobby(denied.p), 'no location means the lobby');
  assert.match(await denied.p.locator('#cx-lb-why').innerText(), /location is switched off|cannot share|cannot tell/i);
  // Even in the lobby, a person can open My account and change their PIN.
  await denied.p.click('#cx-lb-acct');
  await denied.p.waitForSelector('.cx-d');
  await denied.p.fill('#cx-pc', '2222');
  await denied.p.fill('#cx-pn', '2223');
  await denied.p.fill('#cx-pr', '2223');
  await denied.p.click('.cx-d [data-x="pin"]');
  await until(async () => /PIN changed/.test(await denied.p.locator('body').innerText()), 'PIN changed from the lobby');
  await denied.p.click('.cx-d [data-x="close"]');

  /* IT is never held, and can switch the check off. */
  const itp = await page('it', FAR);
  assert.equal(await lobby(itp.p), false, 'IT is never held');
  await itp.p.waitForSelector('#locb [data-k="le"]');
  await itp.p.uncheck('#locb [data-k="le"]');
  await itp.p.click('#locb [data-v="save"]');
  await until(async () => !(await owner.read('location_check')).enabled, 'IT switched the check off');
  await denied.p.click('#cx-lb-again').catch(() => {});
  await until(async () => !(await lobby(denied.p)), 'lobby closes when the owner or IT switches the check off', 12000);
  await denied.ctx.close();

  /* Every role has My account: the old PIN no longer works, the new one does; contact details, theme and sign out. */
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const cp = await ctx.newPage();
  watch(cp, 'cashier-account');
  await cp.goto(shop.base + '/');
  await cp.locator('#pick button', { hasText: /^.*cashier$/i }).first().click();
  for (const d of '2222') await cp.click(`#pad button[data-k="${d}"]`);
  await cp.click('#ok');
  await until(async () => /wrong|not match|try again/i.test(await cp.locator('body').innerText()), 'old PIN refused');
  await cp.reload();
  await cp.locator('#pick button', { hasText: /^.*cashier$/i }).first().click();
  for (const d of '2223') await cp.click(`#pad button[data-k="${d}"]`);
  await cp.click('#ok');
  await cp.waitForURL('**/cashier.html');
  await cp.locator('.xrole, .xnm, .who').first().click();
  await cp.waitForSelector('.cx-d');
  await cp.fill('#cx-ph', '+255712345678');
  await cp.selectOption('#cx-sm', 'critical');
  await cp.click('.cx-d [data-x="contact"]');
  await until(async () => /Contact details saved/.test(await cp.locator('body').innerText()), 'contact saved');
  await cp.click('.cx-d [data-th="dark"]');
  assert.equal(await cp.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await cp.click('.cx-d [data-x="out"]');
  await cp.waitForURL((u) => !u.pathname.endsWith('cashier.html'));

  assert.deepEqual(errs, [], 'no page errors');
  console.log('lobby ok');
} finally {
  await browser.close();
  await shop.stop();
}
