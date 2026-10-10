import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, until } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-owner';
fs.mkdirSync(shots, { recursive: true });
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const txt = (p, s) => p.locator(s).first().innerText();
try {
  const cashier = await actor(browser, shop, 'cashier', watch);
  const baker = await actor(browser, shop, 'baker', watch);
  const today = new Date().toLocaleDateString('en-CA');
  let n = 0;
  const ask = async (spec = {}) => {
    const o = await cashier.send('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Cust' + ++n, deliveryDate: today });
    const orderId = o.data.orderId;
    const l = await cashier.send('orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Vanilla', ...spec } });
    const r = await cashier.send('quotes/request', { orderId, lineId: l.data.lineId, note: 'Wants gold leaf' });
    assert.ok(r.ok, JSON.stringify(r));
    return { orderId, lineId: l.data.lineId };
  };

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watch(page, 'owner');
  globalThis.PG = page;
  await signInAs(page, shop.base, 'owner');
  await page.waitForSelector('#v-requests:not([hidden])');
  assert.ok((await txt(page, '.xnm')).trim().length > 0, 'the signed-in name is shown');
  assert.equal(await page.locator('nav.xtabs button:visible').count(), 1, 'only the finished tab is shown');
  assert.match(await txt(page, '#qopen'), /No cakes waiting/);
  await page.click('#v-requests details summary');

  // a price request arrives live and is priced from the page
  const a = await ask({ decorationNotes: 'Gold drip', allergyNotes: 'No nuts' });
  await until(async () => (await page.locator('#qopen .rq').count()) === 1, 'price request listed live');
  assert.match(await txt(page, '#qopen'), /Gold drip/);
  assert.match(await txt(page, '#qopen'), /No nuts/);
  assert.match(await txt(page, '#qopen'), /Wants gold leaf/);
  await until(async () => /1 waiting/.test(await txt(page, '#qn')), 'count of waiting');
  await until(async () => (await txt(page, '#xbn')).trim() !== '', 'bell badge');
  await page.screenshot({ path: `${shots}/requests.png` });
  await page.click('#qopen [data-a="qprice"]');
  await page.fill('#qp', '0');
  await page.click('#qgo');
  await page.waitForSelector('#toast.on');
  assert.ok(await page.locator('.cx-d').count(), 'dialog stays open on a bad price');
  await page.fill('#qp', '50000');
  await page.fill('#qn2', 'Includes gold leaf');
  await page.click('#qgo');
  await until(async () => (await page.locator('#qopen .rq').count()) === 0 && (await page.locator('.cx-d').count()) === 0, 'priced and closed');
  await until(async () => /50,000/.test(await txt(page, '#qrec')), 'answered price shown');

  // change the price (needs a reason)
  await page.click('#qrec [data-a="qrev"]');
  await page.fill('#qp', '60000');
  await page.click('#qgo');
  await page.waitForSelector('#toast.on');
  assert.ok(await page.locator('.cx-d').count(), 'dialog stays open without a reason');
  await page.fill('#qr', 'Extra layer');
  await page.click('#qgo');
  await until(async () => /60,000/.test(await txt(page, '#qrec')), 'revised price shown');
  const adv = await baker.send('orders/advance_line', { orderId: a.orderId, lineId: a.lineId, to: 'in_production' });
  assert.ok(adv.ok, 'the baker can start a cake the owner priced: ' + JSON.stringify(adv));
  // once baking has started the server refuses a price change, and the page says so in plain words
  await page.click('#qrec [data-a="qrev"]');
  await page.fill('#qp', '70000');
  await page.fill('#qr', 'Too late');
  await page.click('#qgo');
  await until(async () => /Baking has started/.test(await txt(page, '#toast')), 'server refusal shown');
  assert.ok(await page.locator('.cx-d').count(), 'dialog stays open on a server refusal');
  await page.click('#qx');

  // decline needs a reason
  await ask();
  await until(async () => (await page.locator('#qopen .rq').count()) === 1, 'second request listed');
  await page.click('#qopen [data-a="qdecl"]');
  await page.click('#qgo');
  await page.waitForSelector('#toast.on');
  assert.ok(await page.locator('.cx-d').count(), 'dialog stays open without a reason');
  await page.fill('#qr', 'Too short notice');
  await page.click('#qgo');
  await until(async () => (await page.locator('#qopen .rq').count()) === 0, 'declined and gone from the open list');
  assert.match(await txt(page, '#qrec'), /Too short notice|Declined|declined/i);

  // announcements: post, see who has read, take down
  await page.click('[data-a="apost"]');
  await page.waitForSelector('#toast.on');
  await page.fill('#at', 'Stock count on Sunday');
  await page.click('[data-a="apost"]');
  await until(async () => /Stock count on Sunday/.test(await txt(page, '#alist')), 'announcement listed');
  assert.equal(await page.inputValue('#at'), '', 'box cleared after posting');
  const ann = (await cashier.read('announcements')).rows[0];
  await cashier.send('announcements/acknowledge', { announcementId: ann.announcementId });
  await until(async () => /Moses|Cashier|acknowledged/i.test(await txt(page, '#alist')) && /acknowledged/.test(await txt(page, '#alist')), 'an acknowledgement shows');
  await page.click('#alist [data-a="aretire"]');
  await until(async () => /Nothing posted/.test(await txt(page, '#alist')), 'taken down');

  // staff requests come through the shared part
  const sent = await cashier.send('requests/send', { toRole: 'owner', category: 'Stock and supplies', title: 'Need more gold leaf' });
  assert.ok(sent.ok, JSON.stringify(sent));
  await until(async () => /gold leaf/.test(await txt(page, '#rq')), 'staff request shown');

  // phone
  const pp = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  watch(pp, 'phone');
  await signInAs(pp, shop.base, 'owner');
  await pp.waitForSelector('#v-requests:not([hidden])');
  assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no sideways scroll on a phone');
  await pp.screenshot({ path: `${shots}/phone-requests.png` });

  // theme, other roles, sign out
  await page.click('#xtheme');
  assert.ok(await page.evaluate(() => document.documentElement.dataset.theme));
  const cp = await (await browser.newContext()).newPage();
  watch(cp, 'cashier');
  await signInAs(cp, shop.base, 'cashier');
  await cp.goto(shop.base + '/owner.html');
  await cp.waitForURL('**/cashier.html');
  await page.click('#xout');
  await page.waitForURL(shop.base + '/');
  const html = fs.readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
  for (const bad of ['fonts.googleapis', 'xlock', 'Demo:', 'zdemo']) assert.ok(!html.includes(bad), 'leftover: ' + bad);
  assert.deepEqual(errs, []);
  console.log('owner page ok');
} catch (e) {
  console.log('ERRS', errs);
  console.log('PAGE', await globalThis.PG?.locator('main').innerText().catch(() => '-').then((t) => t.slice(0, 900)));
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
