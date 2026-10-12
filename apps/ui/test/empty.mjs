// A shop with nothing in it yet: every screen has to say so plainly, never pretend something is happening.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShop, loadPlaywright, until } from './harness.mjs';
const { chromium } = loadPlaywright();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shop = await startShop({ seed: false });
execFileSync(process.execPath, [path.join(root, 'packages/server/dist/cake-pos-admin.mjs'), 'create-owner', '--name', 'Amina', '--pin', '1111'], { env: shop.env });
const api = async (p, body, token) =>
  (await fetch(shop.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
const staff = (await (await fetch(shop.base + '/api/staff')).json()).data;
const owner = (await api('/api/sign-in', { userId: staff[0].id, pin: '1111' })).token;
for (const [name, role, pin] of [['Baraka', 'cashier', '2222'], ['Juma', 'inventory', '4444']]) await api('/api/dispatch', { type: 'staff/create', payload: { name, role, pin } }, owner);

const browser = await chromium.launch();
const errs = [];
async function open(role, pin) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => errs.push(`${role}: ${e}`));
  await page.goto(shop.base + '/');
  await page.waitForSelector('#pick button');
  await page.locator('#pick button', { hasText: new RegExp(role, 'i') }).first().click();
  for (const d of pin) await page.click(`#pad button[data-k="${d}"]`);
  await page.click('#ok');
  await page.waitForURL(`**/${role}.html`);
  return page;
}
const text = (p, s) => p.locator(s).first().innerText();
try {
  /* Inventory: nothing to count means no count can be started. */
  const inv = await open('inventory', '4444');
  await inv.click('nav button[data-v="count"]');
  await until(async () => /nothing to count yet/i.test(await text(inv, '#cbody')), 'count says there is nothing to count');
  assert.equal(await inv.locator('#cbody [data-a="cstart"]').count(), 0, 'no Start button');
  assert.doesNotMatch(await text(inv, '#cbody'), /in progress/i);
  // Even if the request is sent anyway, the server refuses it in plain words.
  const refused = await inv.evaluate(async () => (await Cake.send('count/start', {})).message);
  assert.match(refused, /nothing to count/i);

  /* Cashier: nothing to sell, and no "TSh -0". */
  const cash = await open('cashier', '2222');
  await until(async () => /nothing to sell yet/i.test(await text(cash, '#tiles')), 'sell screen says there is nothing to sell');
  assert.equal(await cash.isDisabled('#go'), true, 'cannot take payment for an empty ticket');
  await cash.click('nav button[data-v="sales"]');
  await until(async () => /Refunded/.test(await text(cash, '#kp')), 'sales totals show');
  assert.doesNotMatch(await text(cash, '#kp'), /-0\b/);
  // A screen that cannot load says so on the screen, with a way to try again.
  await cash.evaluate(() => Cake.feed('staff_list', {}, () => {}));
  await cash.waitForSelector('#loaderr:not([hidden])');
  assert.match(await text(cash, '#loaderr'), /could not be loaded/i);
  assert.match(await text(cash, '#loaderr'), /\S{4,}/);

  /* Owner: empty catalogue, stock and ledger say "none yet", not "no match". */
  const own = await open('owner', '1111');
  await own.click('nav.xtabs [data-v="catalogue"]');
  await until(async () => /catalogue is empty/i.test(await text(own, '#ctab')), 'empty catalogue');
  await own.click('nav.xtabs [data-v="stock"]');
  await until(async () => /No ingredients yet/i.test(await text(own, '#stab')), 'empty stock');
  await own.click('nav.xtabs [data-v="transactions"]');
  await until(async () => /No payments or refunds have been recorded yet/i.test(await text(own, '#trl')), 'empty ledger');
  for (const p of [inv, cash, own]) assert.doesNotMatch(await p.innerText('body'), /undefined|NaN|\[object Object\]/);

  assert.deepEqual(errs, []);
  console.log('empty shop ok');
} finally {
  await browser.close();
  await shop.stop();
}
