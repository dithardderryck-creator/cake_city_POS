import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, PNG, until } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-owner';
fs.mkdirSync(shots, { recursive: true });
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const txt = (p, s) => p.locator(s).first().innerText();
const tab = (p, v) => p.click(`nav.xtabs [data-v="${v}"]`);
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page, 'owner');
  globalThis.PG = page;
  await signInAs(page, shop.base, 'owner');
  await page.waitForSelector('#hello');
  await until(async () => /Amina/.test(await txt(page, '#hello')), 'greeting with the owner name');
  assert.match(await txt(page, '.xnm'), /Amina/);
  // The "offline" bar must take no room while the shop is reachable (it once showed as a red strip).
  assert.equal(await page.evaluate(() => { const e = document.getElementById('offline'); return !e || e.getBoundingClientRect().height; }), 0, 'offline bar should be hidden when online');
  assert.match(await txt(page, '#reqs'), /All caught up/);
  await page.screenshot({ path: `${shots}/overview-empty.png` });

  const cashier = await actor(browser, shop, 'cashier', watch);
  const owner = await actor(browser, shop, 'owner', watch);
  const today = new Date().toLocaleDateString('en-CA');

  // a catalogue sale with a payment, then a refund decided in the page
  const grid = await cashier.read('catalogue_grid');
  const combo = grid.flatMap((p) => p.combinations).find((c) => c.sellable && c.price);
  assert.ok(combo, 'demo has a sellable item');
  const o1 = await cashier.send('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Walk-in Joe', deliveryDate: today });
  assert.ok(o1.ok, JSON.stringify(o1));
  assert.ok((await cashier.send('orders/add_catalogue_line', { orderId: o1.data.orderId, combinationId: combo.combinationId, qty: 2 })).ok);
  const card = await cashier.read('order_card', { orderId: o1.data.orderId });
  assert.ok((await cashier.send('payments/record_payment', { orderId: o1.data.orderId, method: 'cash', amount: card.total })).ok);

  await tab(page, 'orders');
  await until(async () => /Walk-in Joe/.test(await txt(page, '#zboard')), 'the ticket to appear without reloading');
  await page.screenshot({ path: `${shots}/orders.png` });
  await page.click('#zboard [data-det]');
  await page.waitForSelector('#odp h2');
  assert.match(await txt(page, '#odp'), /Walk-in Joe/);
  await page.click('#odp [data-x="refund"]');
  await page.fill('#odp [data-k="ra"]', '1');
  await page.click('#odp [data-x="refundok"]'); // no reason yet: refused in the page
  assert.ok(await page.locator('#odp [data-k="rr"]').count(), 'form still open');
  await page.fill('#odp [data-k="rr"]', 'Customer changed their mind');
  await page.click('#odp [data-x="refundok"]');
  // just paid: the refund cooldown refuses it in plain words and the form stays open
  await until(async () => /too recent to refund/i.test(await txt(page, '#toast')), 'the refund cooldown message');
  assert.ok(await page.locator('#odp [data-k="rr"]').count(), 'form stays open after the cooldown refusal');
  assert.ok((await owner.send('settings/update', { refundCooldownMinutes: 0 })).ok);
  await page.click('#odp [data-x="refundok"]');
  await until(async () => /Refunded/.test(await txt(page, '#odp')), 'refund shown in the order card');
  await page.screenshot({ path: `${shots}/order-drawer.png` });
  await page.click('#odp [data-x="close"]');

  await tab(page, 'transactions');
  await until(async () => /Customer changed their mind/.test(await txt(page, '#trl')), 'refund in the ledger');
  assert.match(await txt(page, '#trl'), /Walk-in Joe/);
  await page.click('#trf [data-f="ref"]');
  assert.equal(await page.locator('#trl .lr').count(), 1);
  await page.screenshot({ path: `${shots}/transactions.png` });

  // a custom cake price asked for by the cashier, answered in the page
  const o2 = await cashier.send('orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: 'Grace M.', customerPhone: '+255712000222', deliveryDate: today });
  const l2 = await cashier.send('orders/add_custom_line', { orderId: o2.data.orderId, spec: { servings: 40, flavor: 'Vanilla', filling: 'Raspberry', inscription: 'Congratulations Asha' } });
  assert.ok(l2.ok, JSON.stringify(l2));
  const ph = await cashier.photo(PNG);
  assert.ok((await cashier.send('orders/attach_reference_photo', { orderId: o2.data.orderId, lineId: l2.data.lineId, photoId: ph })).ok);
  assert.ok((await cashier.send('quotes/request', { orderId: o2.data.orderId, lineId: l2.data.lineId, note: 'Customer needs a price today' })).ok);
  await tab(page, 'requests');
  await until(async () => /Grace M\./.test(await txt(page, '#qbox')), 'the price request to show up');
  assert.match(await txt(page, '#qbox'), /Congratulations Asha/);
  await until(async () => page.evaluate(() => document.querySelector('#qbox img[data-ph]')?.naturalWidth > 0), 'photo loaded');
  assert.match(await txt(page, '#xbn'), /\d/, 'bell shows something needs you');
  await page.fill('#qbox [data-k^="p-"]', '120000');
  // a live update arrives while the owner is typing: what is typed must survive
  await cashier.send('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Noise', deliveryDate: today });
  const o3 = await cashier.send('orders/create_order', { source: 'phone', fulfilment: 'pickup', customerName: 'Hassan K.', customerPhone: '+255712000333', deliveryDate: today });
  const l3 = await cashier.send('orders/add_custom_line', { orderId: o3.data.orderId, spec: { servings: 20, flavor: 'Chocolate' } });
  await cashier.send('quotes/request', { orderId: o3.data.orderId, lineId: l3.data.lineId });
  await until(async () => (await page.locator('#qbox [data-q]').count()) === 2, 'second request');
  assert.equal(await page.inputValue('#qbox [data-q] [data-k^="p-"]'), '120000', 'typed price kept across a live update');
  await page.screenshot({ path: `${shots}/requests.png` });
  await page.click('#qbox [data-q]:first-child [data-qa="send"]');
  await until(async () => (await page.locator('#qbox [data-q]').count()) === 1, 'answered request leaves the list');
  const qi = await cashier.read('quote_inbox');
  assert.ok(qi.recent.some((q) => q.customerName === 'Grace M.' && /120/.test(q.priceLabel ?? '')), 'price reached the order');
  // changing a price that was already given: from the order, with a reason
  await tab(page, 'orders');
  await until(async () => /Grace M\./.test(await txt(page, '#zboard')), 'Grace on the board');
  await page.click('#zboard .ztw:has-text("Grace M.") [data-det]');
  await page.waitForSelector('#odp [data-x="price"]');
  await page.click('#odp [data-x="price"]');
  await page.fill('#odp [data-k="np"]', '110000');
  await page.click('#odp [data-x="priceok"]');
  assert.ok(await page.locator('#odp [data-k="nr"]').count(), 'refused without a reason, form stays open');
  await page.fill('#odp [data-k="nr"]', 'Fewer flowers');
  await page.click('#odp [data-x="priceok"]');
  await until(async () => /110/.test(await txt(page, '#odp')), 'new price on the order');
  await page.click('#odp [data-x="close"]');
  await tab(page, 'requests');
  // declining needs a reason
  await page.click('#qbox [data-qa="no"]');
  assert.equal(await page.locator('#qbox [data-q]').count(), 1, 'refused without a reason');
  await page.fill('#qbox [data-k^="d-"]', 'Too short notice');
  await page.click('#qbox [data-qa="no"]');
  await until(async () => /No custom cake is waiting/.test(await txt(page, '#qbox')), 'decline');

  // announcements: post, a baker sees it, owner sees who has read it, take down
  await page.fill('#at', 'Closing early on Friday');
  await page.click('#post');
  await until(async () => /Closing early/.test(await txt(page, '#alist')), 'posted');
  assert.equal(await page.inputValue('#at'), '');
  const baker = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const bp = await baker.newPage();
  watch(bp, 'baker');
  await signInAs(bp, shop.base, 'baker');
  await until(async () => /Closing early/.test(await txt(bp, '#ntc')), 'baker sees it');
  await bp.click('#ntc [data-ack]');
  await until(async () => /Acknowledged/.test(await txt(page, '#alist')), 'owner sees the acknowledgement');
  await page.screenshot({ path: `${shots}/announcements.png` });
  await page.click('#alist [data-ret]');
  await until(async () => /Nothing is up/.test(await txt(page, '#alist')), 'taken down');

  // a request from a baker needing the owner shows in the shared list and in "needs your decision"
  const bk = await actor(browser, shop, 'baker', watch);
  assert.ok((await bk.send('requests/send', { toRole: 'owner', category: 'Approval', title: 'New oven mitts', urgent: false })).ok);
  await until(async () => /New oven mitts/.test(await txt(page, '#rq')), 'request in the list');

  // catalogue: add an item through the page, hide it, change a price
  await tab(page, 'catalogue');
  // Each cake can be opened to show every size / filling option the counter sells as its own tile.
  const optsBtn = page.locator('#ctab [data-opts]').first();
  const nOpts = parseInt(await optsBtn.innerText(), 10);
  assert.ok(nOpts > 1, 'a cake shows how many options it has');
  await optsBtn.click();
  assert.equal(await page.locator('#ctab .co').count(), nOpts, 'opening it lists every option');
  await page.locator('#ctab [data-opts]').first().click();
  assert.equal(await page.locator('#ctab .co').count(), 0, 'and closes again');
  await page.click('#cnew');
  await page.fill('#dn', 'Lemon loaf');
  await page.fill('#dcat', 'Loaves');
  await page.fill('#dsz .vr:first-child .vn', 'Small');
  await page.fill('#dsz .vr:first-child .vp', '10');
  await page.click('#dpn [data-d="add"]');
  await page.fill('#dsz .vr:last-child .vn', 'Large');
  await page.click('#dpn [data-d="create"]');
  await until(async () => /Lemon loaf/.test(await txt(page, '#ctab')), 'new item in the list');
  assert.match(await txt(page, '#ctab .ci:has-text("Lemon loaf")'), /Draft|No price|10/);
  assert.match(await txt(page, '#ctab .ci:has-text("Lemon loaf")'), /Draft/, 'one size has no price, so it is a draft');
  await until(async () => /\b10\b/.test(await txt(page, '#ctab .ci:has-text("Lemon loaf")')), 'the small size price to arrive');
  await page.click('#ctab .ci:has-text("Lemon loaf") [data-edit]');
  await page.fill('#dpn .vr[data-was=""] .vp', '25');
  await page.screenshot({ path: `${shots}/catalogue-editor.png` });
  await page.click('#dpn [data-d="save"]');
  await until(async () => /Published/.test(await txt(page, '#ctab .ci:has-text("Lemon loaf")')), 'priced everywhere, so published');
  assert.ok((await cashier.read('catalogue_grid')).some((p) => p.name === 'Lemon loaf'), 'the cashier can see it');
  await page.selectOption('#ctab .ci:has-text("Lemon loaf") select', 'hidden');
  await until(async () => !(await cashier.read('catalogue_grid')).some((p) => p.name === 'Lemon loaf'), 'hidden from the counter');
  await page.click('#cflt [data-f="hidden"]');
  assert.equal(await page.locator('#ctab .ci').count(), 1);
  await page.click('#cflt [data-f="all"]');
  await until(async () => /Lemon loaf/.test(await page.locator('#clog').textContent()), 'change history lists it');
  await page.screenshot({ path: `${shots}/catalogue.png` });

  // stock: ingredients with history
  const ing = await owner.send('inventory/create_ingredient', { name: 'Butter', unit: 'kg', ranges: [{ label: 'Light', min: 1, max: 2 }], openingStock: 20, reorderLevel: 5 });
  assert.ok(ing.ok, JSON.stringify(ing));
  await tab(page, 'stock');
  await until(async () => /Butter/.test(await txt(page, '#stab')), 'ingredient in the stock list');
  await page.click('#stab .si');
  assert.match(await txt(page, '#sdet'), /Butter/);
  await page.fill('#sq', 'zzz');
  assert.match(await txt(page, '#stab'), /No ingredients match/);
  await page.fill('#sq', '');
  await page.screenshot({ path: `${shots}/stock.png` });

  // staff
  await tab(page, 'staff');
  await page.click('#sfnew');
  await page.fill('#sfdet [data-k="an"]', 'Rehema');
  await page.fill('#sfdet [data-k="ap"]', '12');
  await page.click('#sfdet [data-s="create"]');
  assert.ok(await page.locator('#sfdet [data-k="an"]').count(), 'short PIN refused in the page');
  await page.fill('#sfdet [data-k="ap"]', '5566');
  await page.click('#sfdet [data-s="create"]');
  await until(async () => /Rehema/.test(await txt(page, '#sflist')), 'new person listed');
  await page.click('#sflist .rc:has-text("Rehema")');
  await page.selectOption('#sfdet [data-k="rl"]', 'baker');
  await page.click('#sfdet [data-s="role"]');
  await until(async () => /Baker/.test(await txt(page, '#sflist .rc:has-text("Rehema")')), 'role changed');
  await page.click('#sfdet [data-s="tog"]');
  await until(async () => /Deactivated/.test(await txt(page, '#sflist .rc:has-text("Rehema")')), 'deactivated');
  assert.match(await txt(page, '#aul'), /Rehema/, 'audit log lists it');
  await page.screenshot({ path: `${shots}/staff.png` });

  // settings
  await page.click('#xset');
  await page.fill('#dpn [data-k="sn"]', 'Cake City Test');
  await page.click('#dpn [data-d="shop"]');
  await until(async () => (await owner.read('shop_settings')).shopName === 'Cake City Test', 'shop name saved');
  assert.equal(await page.inputValue('#dpn [data-k="rc"]'), '0', 'the refund wait field shows the saved value');
  await page.fill('#dpn [data-k="rc"]', '7');
  await page.click('#dpn [data-d="counter"]');
  await until(async () => (await owner.read('shop_settings')).refundCooldownMinutes === 7, 'refund wait saved');
  await page.fill('#dpn [data-k="rc"]', '500');
  await page.click('#dpn [data-d="counter"]');
  await page.waitForSelector('#toast.on');
  assert.match(await txt(page, '#toast'), /0 to 120/, 'out of range refused in the page');
  assert.equal((await owner.read('shop_settings')).refundCooldownMinutes, 7);
  await page.fill('#dpn [data-k="a-quoteWaitHours"]', '5');
  await page.click('#dpn [data-d="alerts"]');
  await until(async () => (await owner.read('alert_settings')).quoteWaitHours === 5, 'alert rule saved');
  await page.keyboard.press('Escape');
  await tab(page, 'orders');
  await until(async () => /Cake City Test/.test(await txt(page, '#zboard')), 'tickets use the shop name');

  // reports and overview
  await tab(page, 'reports');
  await until(async () => (await txt(page, '#rst')).trim() !== '0', 'sales total');
  await page.click('#rpr [data-r="30"]');
  await until(async () => /30 days/.test(await txt(page, '#rsd')), '30 day range');
  await page.screenshot({ path: `${shots}/reports.png` });
  await tab(page, 'overview');
  assert.match(await txt(page, '#duel'), /Grace M\.|Walk-in Joe|Hassan/);
  await page.screenshot({ path: `${shots}/overview.png` });

  // search
  await page.keyboard.press('Control+k');
  await page.fill('#q', 'grace');
  assert.equal(await page.locator('#res li button').count(), 1);
  await page.click('#res li button');
  await page.waitForSelector('#odp h2');
  await page.keyboard.press('Escape');

  // phone: no sideways scrolling on any view
  const pc = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pp = await pc.newPage();
  watch(pp, 'phone');
  await signInAs(pp, shop.base, 'owner');
  await pp.waitForSelector('#hello');
  for (const v of ['overview', 'requests', 'catalogue', 'orders', 'stock', 'transactions', 'staff', 'reports']) {
    await tab(pp, v);
    await pp.waitForTimeout(150);
    assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no sideways scroll on ${v}`);
    await pp.screenshot({ path: `${shots}/phone-${v}.png` });
  }

  await page.click('#xout');
  await page.waitForURL(shop.base + '/');
  const html = fs.readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
  for (const bad of ['Demo', 'Moses', 'Zawadi', 'Neema', 'Amina', 'fonts.googleapis', 'xlock', 'TSh']) assert.ok(!html.includes(bad), 'leftover: ' + bad);
  assert.deepEqual(errs, []);
  console.log('owner page ok');
} catch (e) {
  console.log('ERRS', errs);
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
