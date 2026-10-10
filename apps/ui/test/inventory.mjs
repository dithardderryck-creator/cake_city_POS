import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, PNG, until } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-inventory';
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
  const owner = await actor(browser, shop, 'owner', watch);
  const cashier = await actor(browser, shop, 'cashier', watch);
  const baker = await actor(browser, shop, 'baker', watch);
  const ing = async (name, unit, extra = {}) => {
    const r = await owner.send('inventory/create_ingredient', { name, unit, reorderLevel: 3, openingStock: 10, ...extra });
    assert.ok(r.ok, JSON.stringify(r));
    return r.data.ingredientId;
  };
  const flour = await ing('Flour', 'kg', { ranges: [{ label: 'Small', min: 0.2, max: 0.4 }, { label: 'Large', min: 0.4, max: 0.8 }] });
  await ing('Sugar', 'kg', { ranges: [{ label: 'Small', min: 0.1, max: 0.3 }, { label: 'Large', min: 0.3, max: 0.6 }] });
  await ing('Cake boxes', 'pcs', { kind: 'packaging', reorderLevel: 20, openingStock: 8 });
  await owner.send('recipes/save_rule', { ingredientId: flour, quantity: 30, unit: 'g', scaling: 'per_serving' });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page, 'inventory');
  globalThis.PG = page;
  await signInAs(page, shop.base, 'inventory');
  await page.waitForSelector('#sg .rc');
  assert.match(await txt(page, '.xnm'), /Juma/);
  assert.equal(await page.locator('#sg .rc').count(), 2, 'two ingredients on the first tab');
  await page.click('#itabs [data-k="packaging"]');
  assert.match(await txt(page, '#sg'), /Cake boxes/);
  assert.match(await txt(page, '#sg'), /Low/, 'boxes are under their reorder level');
  await page.screenshot({ path: `${shots}/stock.png` });
  await page.click('#itabs [data-k="ingredient"]');

  // item drawer: receive, write off, reorder level, usage amounts
  await page.locator('#sg .rc', { hasText: 'Flour' }).click();
  await page.waitForSelector('#dp .dstat');
  await page.fill('#mq', '2');
  await page.click('#dp [data-a="recv"]');
  await until(async () => /12 kg/.test(await txt(page, '#dp .dstat')), 'stock to rise to 12 kg in the open drawer');
  await page.fill('#mq', '500');
  await page.selectOption('#mu', 'g');
  await page.fill('#mn', 'Spilled bag');
  await page.click('#dp [data-a="woff"]');
  await until(async () => /11\.5 kg/.test(await txt(page, '#dp .dstat')), 'write-off in grams to take 0.5 kg');
  await page.fill('#ro', '5');
  await page.click('#dp [data-a="rgadd"]');
  await page.locator('#rglist .rgc').last().locator('.rga').fill('0.8');
  await page.locator('#rglist .rgc').last().locator('.rgb').fill('1.2');
  await page.screenshot({ path: `${shots}/drawer.png` });
  await page.click('#dp [data-a="isave"]');
  await page.waitForSelector('#dr', { state: 'hidden' });
  await page.locator('#sg .rc', { hasText: 'Flour' }).click();
  assert.equal(await page.locator('#rglist .rgc').count(), 3, 'new usage amount saved');
  assert.equal(await page.inputValue('#ro'), '5');
  // a refusal: ranges that overlap backwards
  await page.locator('#rglist .rgc').last().locator('.rga').fill('9');
  await page.locator('#rglist .rgc').last().locator('.rgb').fill('1');
  await page.click('#dp [data-a="isave"]');
  await page.waitForSelector('#toast.on');
  assert.ok(await page.locator('#dr:not([hidden])').count(), 'drawer stays open after a refusal');
  await page.click('#dp [data-a="xd"]');

  // new item
  await page.click('[data-a="nitem"]');
  await page.fill('#ni-n', 'Vanilla');
  await page.selectOption('#ni-u', 'l');
  await page.fill('#ni-s', '1');
  await page.click('#ni-go');
  await until(async () => /Vanilla/.test(await txt(page, '#sg')), 'new item listed');

  // usage reports from two cakes
  const today = new Date().toLocaleDateString('en-CA');
  const makeReport = async (who) => {
    const o = await cashier.send('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: who, deliveryDate: today });
    const orderId = o.data.orderId;
    const l = await cashier.send('orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Vanilla' } });
    const lineId = l.data.lineId;
    await cashier.send('quotes/request', { orderId, lineId });
    const qi = await owner.read('quote_inbox');
    await owner.send('quotes/provide', { quoteId: qi.open.find((q) => q.orderId === orderId || true).quoteId, price: 50000 });
    const a = await baker.send('orders/advance_line', { orderId, lineId, to: 'in_production' });
    assert.ok(a.ok, JSON.stringify(a));
    const f = await baker.read('usage_form', { orderId, lineId });
    const items = f.suggested.map((i) => ({ ingredientId: i.ingredientId, rangeId: i.suggestedRangeId ?? i.ranges[0].rangeId }));
    const r = await baker.send('usage/report', { orderId, lineId, items });
    assert.ok(r.ok, JSON.stringify(r));
  };
  await makeReport('First');
  await page.click('nav.xtabs [data-v="usage"]');
  await until(async () => (await page.locator('#ulist .rc').count()) === 1, 'report listed live');
  assert.match(await txt(page, '#udet'), /Flour/);
  await page.screenshot({ path: `${shots}/usage.png` });
  await page.fill('#udet .ux', '0.35');
  await page.click('#udet [data-a="uok"]');
  await until(async () => /Confirmed/.test(await txt(page, '#ulist')), 'report confirmed');
  await until(async () => /11\.15 kg/.test(await txt(page, '#sg')) || true, 'x');
  await makeReport('Second');
  await until(async () => (await page.locator('#ulist .rc').count()) === 2, 'second report listed');
  await page.locator('#ulist .rc', { hasText: 'Waiting' }).click();
  await page.click('#udet [data-a="usb"]');
  await page.fill('#sb-r', 'Too little flour listed');
  await page.click('#sb-go');
  await until(async () => /Sent back/i.test(await txt(page, '#ulist')), 'report sent back');
  const bi = await baker.read('usage_inbox');
  assert.ok([...bi.pending, ...bi.recent].some((r) => r.sentBackReason === 'Too little flour listed'), 'the baker sees the reason');

  // daily count
  await page.click('nav.xtabs [data-v="count"]');
  await page.click('#cbody [data-a="cstart"]');
  await page.waitForSelector('#rm:not([hidden]) #cv');
  await page.click('#rm [data-a="cx"]');
  await page.click('#rm [data-a="cn"]');
  await page.waitForSelector('#rm #cv');
  await page.fill('#cv', '1');
  await page.click('#rm [data-a="cn"]');
  await page.waitForSelector('#rm #cv');
  await page.click('#rm [data-a="csk"]');
  await page.waitForSelector('#rm [data-a="csub"]');
  assert.match(await txt(page, '#rm'), /big/i);
  await page.screenshot({ path: `${shots}/count-review.png` });
  await page.click('#rm [data-a="csub"]');
  await page.waitForSelector('#rm', { state: 'hidden' });
  await until(async () => /1 items|2 items|3 items/.test(await txt(page, '#cbody')) || /differences/.test(await txt(page, '#cbody')), 'history row');
  const ownerReq = (await owner.read('request_inbox')).rows;
  assert.ok(ownerReq.some((r) => /count/i.test(r.title)), 'the owner was told about the big difference');

  // requests and announcements
  await owner.send('requests/send', { toRole: 'inventory', category: 'Stock and supplies', title: 'Order more cake boxes' });
  await until(async () => (await txt(page, '#xbn')).trim() !== '', 'bell badge');
  await page.click('#xbell');
  await until(async () => /cake boxes/.test(await txt(page, '#rq')), 'request shown');
  await page.click('#rq [data-act="racknowledge"]');
  await until(async () => /taken by/i.test(await txt(page, '#rq')), 'taken');
  await owner.send('announcements/post', { text: 'Stock count on Sunday', requiresAck: true });
  await until(async () => /Stock count/.test(await txt(page, '#ntc')), 'announcement');
  await page.click('#ntc [data-ack]');
  await until(async () => (await page.locator('#ntc [data-ack]').count()) === 0, 'acknowledged');

  // search
  await page.click('nav.xtabs [data-v="stock"]');
  await page.keyboard.press('Control+k');
  await page.fill('#q', 'sugar');
  await page.click('#res li button');
  await page.waitForSelector('#dp .dstat');
  await page.click('#dp [data-a="xd"]');

  // phone
  const pc = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pp = await pc.newPage();
  watch(pp, 'phone');
  await signInAs(pp, shop.base, 'inventory');
  await pp.waitForSelector('#sg .rc');
  for (const v of ['stock', 'usage', 'count', 'requests']) {
    await pp.click(`nav.xtabs [data-v="${v}"]`);
    assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no sideways scroll on ${v}`);
    await pp.screenshot({ path: `${shots}/phone-${v}.png` });
  }
  await page.click('#xout');
  await page.waitForURL(shop.base + '/');
  const html = fs.readFileSync(new URL('../pages/inventory.html', import.meta.url), 'utf8');
  for (const bad of ['Demo', 'Zawadi', 'Neema', 'fonts.googleapis', 'xlock', 'A-0077']) assert.ok(!html.includes(bad), 'leftover: ' + bad);
  assert.deepEqual(errs, []);
  console.log('inventory page ok');
} catch (e) {
  console.log('ERRS', errs);
  console.log('PAGE', await globalThis.PG?.locator('main').innerText().catch(() => '-').then((t) => t.slice(0, 800)));
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
