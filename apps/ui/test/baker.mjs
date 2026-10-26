import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, PNG, until, openMenu } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-baker';
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page, 'baker');
  globalThis.PG = page;
  await signInAs(page, shop.base, 'baker');
  await page.waitForSelector('#qsub');
  assert.match(await page.locator('.xnm').first().textContent(), /Neema/);
  assert.match(await txt(page, '#rl0'), /No custom cakes/, 'empty queue says so');

  // a custom cake arrives while the baker is looking
  const cashier = await actor(browser, shop, 'cashier', watch);
  const owner = await actor(browser, shop, 'owner', watch);
  // the shop's stock list and recipe rules, which the demo data does not include
  const ing = async (name, unit, ranges) => {
    const r = await owner.send('inventory/create_ingredient', { name, unit, ranges, openingStock: 5000, reorderLevel: 500 });
    assert.ok(r.ok, JSON.stringify(r));
    return r.data.ingredientId;
  };
  const flour = await ing('Flour', 'g', [{ label: 'Light', min: 100, max: 200 }, { label: 'Medium', min: 200, max: 400 }, { label: 'Heavy', min: 400, max: 600 }]);
  await ing('Sugar', 'g', [{ label: 'Light', min: 50, max: 150 }, { label: 'Heavy', min: 150, max: 300 }]);
  assert.ok((await owner.send('recipes/save_rule', { ingredientId: flour, quantity: 30, unit: 'g', scaling: 'per_serving' })).ok);
  const today = new Date().toLocaleDateString('en-CA');
  const o = await cashier.send('orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: 'Amani Family', customerPhone: '+255712000111', deliveryDate: today });
  assert.ok(o.ok, JSON.stringify(o));
  const orderId = o.data.orderId;
  const l = await cashier.send('orders/add_custom_line', { orderId, spec: { servings: 12, sizeNote: '8-inch', flavor: 'Chocolate', filling: 'Vanilla cream', inscription: 'Happy 7th Amani', allergyNotes: 'Peanut allergy', decorationNotes: 'Dinosaur topper' } });
  assert.ok(l.ok, JSON.stringify(l));
  const lineId = l.data.lineId;
  const ph = await cashier.photo(PNG);
  assert.ok((await cashier.send('orders/attach_reference_photo', { orderId, lineId, photoId: ph })).ok);
  assert.ok((await cashier.send('quotes/request', { orderId, lineId })).ok);
  const qi = await owner.read('quote_inbox');
  assert.ok((await owner.send('quotes/provide', { quoteId: qi.open[0].quoteId, price: 90000 })).ok);
  assert.ok((await cashier.send('payments/record_payment', { orderId, method: 'cash', amount: 90000 })).ok);

  await until(async () => /Amani Family/.test(await txt(page, '#rl0')), 'the cake to show up in the queue without reloading');
  assert.match(await txt(page, '#rl0'), /Allergy/);
  await page.click('#rl0 .rc');
  await page.waitForSelector('#dt h2');
  const dt = await txt(page, '#dt');
  for (const w of ['Peanut allergy', 'Happy 7th Amani', 'Dinosaur topper', 'Vanilla cream', '8-inch']) assert.ok(dt.includes(w), 'detail shows ' + w);
  await until(async () => (await page.locator('#dt [data-ph] img').count()) === 1, 'reference photo');
  assert.ok(await page.evaluate(() => document.querySelector('#dt [data-ph] img').naturalWidth > 0), 'photo really loaded');
  await page.screenshot({ path: `${shots}/queue.png` });

  // start baking, recipe mode opens
  const start = page.locator('#dt [data-a="adv"]').first();
  assert.match(await start.innerText(), /\S/);
  await start.click();
  await page.waitForSelector('#rm:not([hidden]) .ri, #rm:not([hidden]) .mute');
  await page.screenshot({ path: `${shots}/recipe.png` });
  const items = await page.locator('#rm .ri').count();
  if (items) {
    await page.click('#rm .ri');
    assert.match(await txt(page, '#rmc'), /^1 of/);
  }
  await page.click('#rm [data-a="xr"]');
  await until(async () => /In production|Decorating/.test(await txt(page, '#dt')), 'status to change');

  // report usage
  await page.click('#dt [data-a="use"]');
  await page.waitForSelector('#dp .ur, #dp select');
  if (!(await page.locator('#dp .ur').count())) {
    await page.click('#dp [data-a="ux"]');
  }
  await page.screenshot({ path: `${shots}/usage-form.png` });
  const firstRange = page.locator('#dp .pre button[aria-pressed="false"]').first();
  if (await firstRange.count()) await firstRange.click();
  await page.click('#usb');
  await page.waitForSelector('#v-usage:not([hidden])');
  await until(async () => /Reported|Waiting/i.test(await txt(page, '#ul')), 'report listed');
  // inventory confirms; the baker sees it change
  const inv = await actor(browser, shop, 'inventory', watch);
  const ui = await inv.read('usage_inbox');
  const rep = ui.pending[0];
  assert.ok(rep, 'inventory has the report');
  const conf = await inv.send('usage/confirm', { reportId: rep.reportId, items: rep.items.map((i) => ({ ingredientId: i.ingredientId, qty: i.min })) });
  assert.ok(conf.ok, JSON.stringify(conf));
  await until(async () => /Confirmed/.test(await txt(page, '#ul')), 'report to show confirmed live');
  await page.screenshot({ path: `${shots}/usage.png` });

  // mark ready
  await page.click('nav.xtabs [data-v="queue"]');
  await page.click('#rl0 .rc');
  const ready = page.locator('#dt [data-a="adv"]').first();
  await ready.click();
  await until(async () => /ready for handover/i.test(await txt(page, '#rl0')), 'cake under Ready for handover');

  // tickets
  await page.click('nav.xtabs [data-v="tickets"]');
  await page.waitForSelector('#zboard .ztt');
  await page.selectOption('#zf', 'ready');
  assert.equal(await page.locator('#zboard .ztt').count(), 1);
  await page.selectOption('#zf', 'new');
  assert.equal(await page.locator('#zboard .ztt').count(), 0);
  await page.screenshot({ path: `${shots}/tickets.png` });

  // batches
  await page.click('nav.xtabs [data-v="batches"]');
  await page.waitForSelector('#bp');
  await page.click('#bf [data-a="bpl"]');
  await page.fill('#bnt', 'One tray slightly dark');
  await page.click('#bf [data-a="blog"]');
  await until(async () => /One tray slightly dark/.test(await txt(page, '#bl')), 'batch listed');
  assert.equal(await page.inputValue('#bnt'), '', 'note cleared after logging');
  await page.screenshot({ path: `${shots}/batches.png` });
  await page.click('#bl [data-a="bundo"]');
  await until(async () => /Nothing logged yet/.test(await txt(page, '#bl')), 'batch taken back');

  // requests and announcements
  await owner.send('requests/send', { toRole: 'baker', category: 'Approval', title: 'Trial the pistachio cake on Friday' });
  await until(async () => (await txt(page, '#xbn')).trim() !== '', 'bell badge');
  await page.click('#xbell');
  await until(async () => /pistachio/.test(await txt(page, '#rq')), 'request shown');
  await page.click('#rq [data-act="racknowledge"]');
  await until(async () => /taken by/i.test(await txt(page, '#rq')), 'taken');
  await owner.send('announcements/post', { text: 'Oven 2 is being serviced at noon', requiresAck: true });
  await until(async () => /Oven 2/.test(await txt(page, '#ntc')), 'announcement');
  await page.click('#ntc [data-ack]');
  await until(async () => (await page.locator('#ntc [data-ack]').count()) === 0, 'acknowledged');

  // search
  await page.click('nav.xtabs [data-v="queue"]');
  await page.keyboard.press('Control+k');
  await page.fill('#q', 'amani');
  assert.equal(await page.locator('#res li button').count(), 1);
  await page.click('#res li button');
  await page.waitForSelector('#dt h2');

  // phone
  const pc = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pp = await pc.newPage();
  watch(pp, 'phone');
  await signInAs(pp, shop.base, 'baker');
  await pp.waitForSelector('#qsub');
  for (const v of ['queue', 'tickets', 'batches', 'usage', 'requests']) {
    await pp.click(`nav.xtabs [data-v="${v}"]`);
    assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no sideways scroll on ${v}`);
    await pp.screenshot({ path: `${shots}/phone-${v}.png` });
  }

  await openMenu(page);
  await page.click('#xout');
  await page.waitForURL(shop.base + '/');
  const html = fs.readFileSync(new URL('../pages/baker.html', import.meta.url), 'utf8');
  for (const bad of ['Demo', 'Zawadi', 'fonts.googleapis', 'xlock', 'A-0079']) assert.ok(!html.includes(bad), 'leftover: ' + bad);
  assert.deepEqual(errs, []);
  console.log('baker page ok');
} catch (e) {
  console.log('ERRS', errs);
  console.log('DT', await PG.locator('#dt').innerText().catch(()=>'-'), '|||', await PG.locator('#rl0').innerText().catch(()=>'-'));
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
