import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, until } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-dayclose';
fs.mkdirSync(shots, { recursive: true });
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const txt = (p, s) => p.locator(s).first().innerText();
try {
  const cashier = await actor(browser, shop, 'cashier', watch);
  const owner = await actor(browser, shop, 'owner', watch);
  const grid = await cashier.read('catalogue_grid');
  const combo = grid.flatMap((p) => p.combinations).find((c) => c.sellable && c.price);
  assert.ok(combo, 'demo has a sellable item');
  assert.ok((await cashier.send('orders/quick_sale', { items: [{ combinationId: combo.combinationId, qty: 1 }], method: 'cash' })).ok);
  assert.ok((await cashier.send('orders/quick_sale', { items: [{ combinationId: combo.combinationId, qty: 1 }], method: 'card' })).ok);
  const rep = await owner.read('day_report', {});
  assert.equal(rep.cash.cashIn, combo.price);

  // The cashier cannot see a closing box while the owner closes alone.
  const cctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const cp = await cctx.newPage();
  watch(cp, 'cashier');
  await signInAs(cp, shop.base, 'cashier');
  await cp.click('#tabs [data-v="sales"]');
  await until(async () => /Payments today/.test(await txt(cp, '#v-sales')), 'the sales view');
  assert.equal(await cp.locator('#cdc button').count(), 0, 'no closing button for the cashier by default');

  // Owner: open the end-of-day screen.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page, 'owner');
  await signInAs(page, shop.base, 'owner');
  await page.waitForSelector('#hello');
  await page.click('nav.xtabs [data-v="transactions"]');
  await page.click('#eod');
  await until(async () => /Should be in the drawer/.test(await txt(page, '#dpn')), 'the report');
  assert.ok((await txt(page, '#dpn')).includes(rep.cash.expectedLabel), 'shows the expected cash');
  await page.screenshot({ path: `${shots}/report.png` });

  // A wrong count with no note is refused in plain words, and nothing is saved.
  await page.fill('#dpn [data-k="cc"]', String(combo.price - 100));
  await page.click('#dpn [data-d="dayclose"]');
  await page.waitForSelector('#toast.on');
  assert.match(await txt(page, '#toast'), /note/i);
  assert.equal((await owner.read('day_report', {})).closed, null);
  assert.equal(await page.inputValue('#dpn [data-k="cc"]'), String(combo.price - 100), 'what was typed is kept');

  // With a note it is saved and shown.
  await page.fill('#dpn [data-k="cn"]', 'Change given from my pocket');
  await page.click('#dpn [data-d="dayclose"]');
  await until(async () => /Counted/.test(await txt(page, '#dpn')) && /short/.test(await txt(page, '#dpn')), 'the saved count');
  assert.match(await txt(page, '#dpn'), /Change given from my pocket/);
  await page.screenshot({ path: `${shots}/closed.png` });

  // A sale after closing shows up as a change, and counting again clears it.
  assert.ok((await cashier.send('orders/quick_sale', { items: [{ combinationId: combo.combinationId, qty: 1 }], method: 'cash' })).ok);
  await until(async () => /Money moved after this count/.test(await txt(page, '#dpn')), 'the change warning, without reloading');
  await page.fill('#dpn [data-k="cc"]', String(combo.price * 2));
  await page.click('#dpn [data-d="dayclose"]');
  await until(async () => !/Money moved after this count/.test(await txt(page, '#dpn')) && /matches/.test(await txt(page, '#dpn')), 'the new count');

  // Phone width: no sideways scroll with the screen open.
  const pc = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pp = await pc.newPage();
  watch(pp, 'phone');
  await signInAs(pp, shop.base, 'owner');
  await pp.waitForSelector('#hello');
  await pp.click('nav.xtabs [data-v="transactions"]');
  await pp.click('#eod');
  await until(async () => /Should be in the drawer/.test(await txt(pp, '#dpn')), 'the report on a phone');
  assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no sideways scroll');
  await pp.screenshot({ path: `${shots}/phone.png` });

  // The owner lets the cashier close; the cashier's page shows the button without reloading.
  await page.click('#dpn [data-d="close"]');
  await page.click('#xset');
  await page.click('#dpn [data-d="sec"][data-s="selling"]');
  await page.selectOption('#dpn [data-k="dc"]', 'cashier_and_owner');
  await page.click('#dpn [data-d="secsave"]');
  await until(async () => (await owner.read('shop_settings', {})).dayCloseBy === 'cashier_and_owner', 'the setting to save');
  await until(async () => (await cp.locator('#cdc button').count()) === 1, 'the cashier button to appear');
  await cp.click('#cdc button');
  await until(async () => /Should be in the drawer/.test(await txt(cp, '#mod')), 'the cashier form');
  await cp.fill('#dcc', String(combo.price * 2));
  await cp.click('[data-a="dcsv"]');
  await until(async () => (await owner.read('day_report', {})).closed?.byName.startsWith('Baraka'), 'the cashier to be named as the closer');
  await cp.screenshot({ path: `${shots}/cashier.png` });

  assert.deepEqual(errs, []);
  console.log('day close ok');
} catch (e) {
  console.log('ERRS', errs);
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
