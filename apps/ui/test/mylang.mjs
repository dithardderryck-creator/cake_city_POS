// Everyone picks their own language: My account has the choice, the shop's language is only the default,
// and the sign-in page has a switch of its own.
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
const LABEL = { owner: /owner|mmiliki/i, cashier: /cashier|keshia/i, baker: /baker|mwokaji/i };

async function open(role) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  watch(p, role);
  await p.goto(shop.base + '/');
  await p.locator('#pick button', { hasText: LABEL[role] }).first().click();
  for (const d of PINS[role]) await p.click(`#pad button[data-k="${d}"]`);
  await p.click('#ok');
  await p.waitForURL(`**/${role}.html`);
  return p;
}
const body = (p) => p.locator('body').innerText();
const lang = (p) => p.evaluate(() => localStorage.getItem('cake-pos-lang'));

try {
  const owner = await actor(browser, shop, 'owner', watch);
  const cashier = await open('cashier');
  const baker = await open('baker');
  await cashier.waitForSelector('nav [data-v]');
  assert.notEqual(await lang(cashier), 'sw', 'English to begin with');

  /* The cashier picks Kiswahili in My account. Only their screens change. */
  await cashier.locator('.xrole, .xnm, .who').first().click();
  await cashier.waitForSelector('.cx-d #cx-lg');
  await cashier.selectOption('#cx-lg', 'sw');
  await until(async () => (await lang(cashier)) === 'sw' && /Akaunti yangu/.test(await body(cashier)), 'cashier screens in Kiswahili');
  await cashier.click('.cx-d [data-x="close"]');
  assert.notEqual(await lang(baker), 'sw', 'the baker is not affected');
  assert.doesNotMatch(await body(baker), /Akaunti|Mipangilio/);

  /* The choice is the person's, not this browser's: forget the browser's memory and reload. */
  await cashier.evaluate(() => localStorage.removeItem('cake-pos-lang'));
  await cashier.reload();
  await until(async () => (await lang(cashier)) === 'sw', 'the saved choice comes back from the server');

  /* The shop's language is only the default: the baker (no choice) follows it, the cashier (own choice) does not. */
  assert.ok((await owner.send('settings/update', { language: 'en' })).ok);
  assert.ok((await owner.send('settings/update', { language: 'sw' })).ok);
  await until(async () => (await lang(baker)) === 'sw', 'the baker follows the shop default');
  await cashier.locator('.xrole, .xnm, .who').first().click();
  await cashier.waitForSelector('.cx-d #cx-lg');
  await cashier.selectOption('#cx-lg', 'en');
  await until(async () => (await lang(cashier)) === 'en', 'cashier back to English');
  await cashier.click('.cx-d [data-x="close"]');
  assert.ok((await owner.send('settings/update', { language: 'en' })).ok);
  await until(async () => (await lang(baker)) === 'en', 'the baker follows the shop back to English');
  assert.equal(await lang(cashier), 'en');

  /* "Same as the shop" again. */
  assert.ok((await owner.send('settings/update', { language: 'sw' })).ok);
  await cashier.locator('.xrole, .xnm, .who').first().click();
  await cashier.waitForSelector('.cx-d #cx-lg');
  assert.equal(await cashier.inputValue('#cx-lg'), 'en');
  await cashier.selectOption('#cx-lg', 'shop');
  await until(async () => (await lang(cashier)) === 'sw', 'with no choice of their own the cashier follows the shop');
  assert.ok((await owner.send('settings/update', { language: 'en' })).ok);

  /* The sign-in page has its own switch, for the person about to sign in. */
  const anon = await (await browser.newContext()).newPage();
  watch(anon, 'anon');
  await anon.goto(shop.base + '/');
  await anon.waitForSelector('#pick button');
  assert.equal(await anon.locator('#lg').innerText(), 'Kiswahili');
  await anon.click('#lg');
  await until(async () => /Mmiliki/.test(await anon.locator('#pick').innerText()), 'sign-in page in Kiswahili');
  assert.equal(await anon.locator('#lg').innerText(), 'English');
  await anon.click('#lg');
  await until(async () => /Owner/.test(await anon.locator('#pick').innerText()), 'sign-in page back in English');

  assert.deepEqual(errs, [], 'no page errors');
  console.log('my language ok');
} finally {
  await browser.close();
  await shop.stop();
}
