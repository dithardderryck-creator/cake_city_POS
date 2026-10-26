// Awkward but realistic input: very long names with no spaces, HTML in names, junk typed into amount boxes.
// Nothing may overflow the screen, run as code, show "NaN" or silently change an amount.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, until, menuGo, addToTicket } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-badinput';
fs.mkdirSync(shots, { recursive: true });

const LONG = 'W'.repeat(120);
const HTML = '<img src=x onerror="window.__pwned=1">';
const SCRIPT = '"><script>window.__pwned=1</script>';
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('dialog', (d) => (errs.push(`${tag}: a dialog opened: ${d.message()}`), d.dismiss()));
};
const txt = (p, sel) => p.locator(sel).first().innerText();
const problems = [];
const JUNK_WORDS = /NaN|Infinity|undefined|\[object|\be\+\d/;

try {
  const owner = await actor(browser, shop, 'owner', watch);
  const cashier = await actor(browser, shop, 'cashier', watch);
  const today = new Date().toLocaleDateString('en-CA');
  const ok = (r, what) => assert.ok(r.ok, `${what}: ${JSON.stringify(r)}`);

  // ---- awkward data, entered the way a real person (or a mistake) could ----
  ok(await owner.send('staff/create', { name: HTML, role: 'it', pin: '5551' }), 'staff html');
  ok(await owner.send('staff/create', { name: LONG, role: 'it', pin: '5552' }), 'staff long');
  ok(await owner.send('catalogue/create_product', { name: LONG }), 'product long');
  ok(await owner.send('catalogue/create_product', { name: SCRIPT }), 'product script');
  ok(await owner.send('inventory/create_ingredient', { name: HTML, unit: 'kg' }), 'ingredient html');
  ok(await owner.send('inventory/create_ingredient', { name: LONG, unit: 'kg' }), 'ingredient long');
  ok(await owner.send('announcements/post', { text: `${HTML} ${'N'.repeat(440)}` }), 'announcement');
  const grid = await cashier.read('catalogue_grid');
  const combo = grid.flatMap((p) => p.combinations).find((c) => c.sellable && c.price);
  ok(await cashier.send('orders/quick_sale', { items: [{ combinationId: combo.combinationId, qty: 1 }], method: 'cash', customerName: LONG }), 'sale long name');
  const o = await cashier.send('orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: HTML, deliveryDate: today });
  ok(o, 'order html');
  ok(await cashier.send('orders/add_catalogue_line', { orderId: o.data.orderId, combinationId: combo.combinationId, qty: 1 }), 'line');
  ok(await cashier.send('requests/send', { toRole: 'owner', category: 'Other', title: `${HTML}${'R'.repeat(40)}` }), 'request');

  // ---- every screen, at phone width and desktop width ----
  const TABS = {
    cashier: '#tabs [data-v]',
    baker: 'nav button[data-v]',
    inventory: 'nav button[data-v]',
    owner: 'nav.xtabs [data-v]',
  };
  async function sweep(role, width) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await ctx.newPage();
    watch(page, `${role}@${width}`);
    await signInAs(page, shop.base, role);
    await page.waitForTimeout(500);
    const tabs = await page.locator('#xmn [data-id]').evaluateAll((els) => els.map((e) => e.dataset.id).filter((id) => !['settings', 'tickets'].includes(id)));
    assert.ok(tabs.length >= 3, `${role} has tabs`);
    for (const v of tabs) {
      await menuGo(page, v);
      await page.waitForTimeout(350);
      const r = await page.evaluate(() => {
        const wide = [...document.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && /W{30}|N{30}|R{30}/.test(e.textContent || '') && e.getClientRects().length)
          .map((e) => e.getBoundingClientRect().right)
          .filter((x) => x > innerWidth + 1);
        const culprits = [...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.getClientRects().length)
          .slice(0, 3)
          .map((e) => `${e.tagName}#${e.id}.${String(e.className).slice(0, 30)} "${(e.textContent || '').slice(0, 24)}"`);
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, wide, culprits, pwned: window.__pwned, img: document.querySelectorAll('img[src="x"]').length };
      });
      const where = `${role} ${v} @${width}`;
      if (r.sw > r.iw + 1) problems.push(`${where}: the page scrolls sideways (${r.sw} > ${r.iw}) because of ${r.culprits.join(' ; ')}`);
      else if (r.wide.length) problems.push(`${where}: long text runs off the screen`);
      if (r.pwned !== undefined) problems.push(`${where}: text from a name ran as code`);
      if (r.img) problems.push(`${where}: HTML in a name became a real element`);
      if (JUNK_WORDS.test(await page.locator('body').innerText())) problems.push(`${where}: shows NaN, undefined or an exponent`);
    }
    await page.screenshot({ path: `${shots}/${role}-${width}.png` });
    return page;
  }
  for (const role of ['cashier', 'baker', 'inventory', 'owner']) await sweep(role, 390);
  const cash = await sweep('cashier', 1280);
  const own = await sweep('owner', 1280);

  // the sign-in list shows every staff name, so it must cope too
  const login = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  watch(login, 'sign-in');
  await login.goto(shop.base + '/');
  await login.waitForSelector('#pick button');
  assert.deepEqual(problems, [], 'screens with awkward data:\n' + problems.join('\n'));
  const l = await login.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, pwned: window.__pwned, img: document.querySelectorAll('img[src="x"]').length }));
  assert.ok(l.sw <= l.iw + 1, 'sign-in page does not scroll sideways');
  assert.equal(l.pwned, undefined);
  assert.equal(l.img, 0);
  assert.match(await login.locator('#pick').innerText(), /<img src=x/, 'the name is shown as plain text');

  // an order whose customer name is HTML shows as plain text in the open ticket
  await menuGo(own, 'orders');
  await until(async () => /<img/.test(await txt(own, '#zboard')), 'the HTML name shown as plain text on the board');
  await own.click('#zboard [data-det]');
  await own.waitForSelector('#odp h2');
  assert.equal(await own.locator('img[src="x"]').count(), 0);
  assert.equal(await own.evaluate(() => window.__pwned), undefined);
  await own.click('#odp [data-x="close"]');

  // ---- junk typed into the cashier's amount box ----
  await cash.locator('#tabs [data-v="sell"]').click();
  await cash.waitForSelector('#tiles .tile:not([disabled])');
  await addToTicket(cash);
  await cash.click('#pay [data-i="cash"]');
  const type = async (s) => {
    await cash.fill('#rcv', s);
    return { raw: await cash.inputValue('#rcv'), paid: (await txt(cash, '#pd')).trim() };
  };
  const blur = async () => (await cash.locator('#rcv').evaluate((e) => e.blur()), cash.inputValue('#rcv'));
  let r;
  r = await type('1,000');
  assert.equal(r.raw, '1,000');
  assert.match(r.paid, /^(TSh\s*)?1,000$/);
  r = await type('1000.50');
  assert.match(r.paid, /^(TSh\s*)?1,000$/, '"1000.50" is 1,000 shillings, never 100,050');
  assert.equal(await blur(), '1,000', 'tidied when the person leaves the box');
  r = await type('0.5');
  assert.doesNotMatch(r.paid, /[1-9]/, '"0.5" is not read as 5');
  await cash.fill('#rcv', '');
  r = await type('abc');
  assert.equal(r.raw, '', 'letters are ignored');
  r = await type('-5');
  assert.doesNotMatch(r.paid, /-/, 'no minus sign');
  await type('1,000');
  await cash.fill('#rcv', '99999999999999999999');
  await cash.waitForSelector('#toast.on');
  assert.match(await txt(cash, '#toast'), /too large/i, 'an amount that is too big is refused in words');
  assert.equal(await cash.inputValue('#rcv'), '1,000', 'and the box keeps the last good amount, not a cut-off one');
  assert.doesNotMatch(await cash.locator('body').innerText(), JUNK_WORDS);

  assert.deepEqual(errs, [], 'no page errors or dialogs: ' + errs.join(' | '));
  console.log('bad input ok');
} finally {
  await browser.close();
  await shop.stop();
}
