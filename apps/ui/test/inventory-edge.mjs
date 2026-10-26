import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, actor, until, openMenu } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-inventory-edge';
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
  const owner = await actor(browser, shop, 'owner', watch);
  const cashier = await actor(browser, shop, 'cashier', watch);
  const baker = await actor(browser, shop, 'baker', watch);
  const mk = await owner.send('inventory/create_ingredient', {
    name: 'Flour', unit: 'kg', reorderLevel: 3, openingStock: 10,
    ranges: [{ label: 'Small', min: 0.2, max: 0.4 }, { label: 'Large', min: 0.4, max: 0.8 }],
  });
  assert.ok(mk.ok, JSON.stringify(mk));
  const flour = mk.data.ingredientId;
  await owner.send('inventory/create_ingredient', { name: 'Sugar', unit: 'kg', reorderLevel: 3, openingStock: 10 });
  await owner.send('recipes/save_rule', { ingredientId: flour, quantity: 30, unit: 'g', scaling: 'per_serving' });
  const onHand = async (name = 'Flour') => (await owner.read('ingredient_list')).find((r) => r.name === name).onHand;

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watch(page, 'inventory');
  globalThis.PG = page;
  await signInAs(page, shop.base, 'inventory');
  await page.waitForSelector('#sg .rc');

  const today = new Date().toLocaleDateString('en-CA');
  let n = 0;
  const makeReport = async () => {
    const o = await cashier.send('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'C' + ++n, deliveryDate: today });
    const orderId = o.data.orderId;
    const l = await cashier.send('orders/add_custom_line', { orderId, spec: { servings: 10, flavor: 'Vanilla' } });
    const lineId = l.data.lineId;
    await cashier.send('quotes/request', { orderId, lineId });
    const qi = await owner.read('quote_inbox');
    await owner.send('quotes/provide', { quoteId: qi.open.find((q) => q.orderId === orderId).quoteId, price: 50000 });
    assert.ok((await baker.send('orders/advance_line', { orderId, lineId, to: 'in_production' })).ok);
    const f = await baker.read('usage_form', { orderId, lineId });
    const items = f.suggested.map((i) => ({ ingredientId: i.ingredientId, rangeId: i.suggestedRangeId ?? i.ranges[0].rangeId }));
    assert.ok((await baker.send('usage/report', { orderId, lineId, items })).ok);
  };

  // 1. confirming with typed amounts really lowers stock by exactly that amount
  const start = await onHand();
  assert.equal(start, 10);
  await makeReport();
  await page.click('nav.xtabs [data-v="usage"]');
  await until(async () => (await page.locator('#ulist .rc').count()) === 1, 'report listed');
  await page.fill('#udet .ux', '0.35');
  await page.click('#udet [data-a="uok"]');
  await until(async () => /Confirmed/.test(await txt(page, '#ulist')), 'confirmed');
  assert.ok(Math.abs((await onHand()) - 9.65) < 1e-9, 'typed amount taken off stock: ' + (await onHand()));
  await page.click('nav.xtabs [data-v="stock"]');
  await until(async () => /9\.65 kg/.test(await txt(page, '#sg')), 'stock card shows 9.65 kg');

  // 2. accept ranges as reported: stock drops by something inside the reported range
  await makeReport();
  await page.click('nav.xtabs [data-v="usage"]');
  await until(async () => (await page.locator('#ulist .rc', { hasText: 'Waiting' }).count()) === 1, 'second report waiting');
  await page.locator('#ulist .rc', { hasText: 'Waiting' }).click();
  const before2 = await onHand();
  await page.click('#udet [data-a="uacc"]');
  await until(async () => (await page.locator('#ulist .rc', { hasText: 'Waiting' }).count()) === 0, 'accepted');
  const drop2 = before2 - (await onHand());
  assert.ok(drop2 >= 0.2 - 1e-9 && drop2 <= 0.8 + 1e-9, 'accept-as-reported drop inside the reported range: ' + drop2);

  // 3. a fast double click on Confirm takes stock off only once
  await makeReport();
  await until(async () => (await page.locator('#ulist .rc', { hasText: 'Waiting' }).count()) === 1, 'third report waiting');
  await page.locator('#ulist .rc', { hasText: 'Waiting' }).click();
  const before3 = await onHand();
  await page.fill('#udet .ux', '0.3');
  await page.dblclick('#udet [data-a="uok"]');
  await until(async () => (await page.locator('#ulist .rc', { hasText: 'Waiting' }).count()) === 0, 'confirmed once');
  await page.waitForTimeout(500);
  assert.ok(Math.abs(before3 - (await onHand()) - 0.3) < 1e-9, 'double click deducted once: ' + (before3 - (await onHand())));

  // 4. bad receive / write-off input is refused and the drawer stays open
  await page.click('nav.xtabs [data-v="stock"]');
  await page.locator('#sg .rc', { hasText: 'Sugar' }).click();
  await page.waitForSelector('#dp .dstat');
  const sugar0 = await onHand('Sugar');
  assert.equal(sugar0, 10);
  for (const bad of ['', '0', '-3']) {
    await page.fill('#mq', bad);
    await page.click('#dp [data-a="recv"]');
    await page.waitForTimeout(300);
    assert.ok(await page.locator('#dr:not([hidden])').count(), `drawer open after receiving "${bad}"`);
  }
  await page.fill('#mq', '9999');
  await page.fill('#mn', 'too much');
  await page.click('#dp [data-a="woff"]');
  await page.waitForTimeout(400);
  assert.ok(await page.locator('#dr:not([hidden])').count(), 'drawer open after writing off more than on hand');
  const sugar1 = await onHand('Sugar');
  assert.equal(sugar1, sugar0, 'refused entries changed nothing');
  await page.click('#dp [data-a="xd"]');

  // 5. new packaging item lands on the Packaging tab
  await page.click('[data-a="nitem"]');
  await page.fill('#ni-n', 'Ribbon');
  await page.click('#ni-k [data-k="packaging"]');
  await page.selectOption('#ni-u', 'pcs');
  await page.fill('#ni-s', '50');
  await page.fill('#ni-r', '20');
  await page.click('#ni-go');
  await until(async () => /Ribbon/.test(await txt(page, '#sg')), 'packaging item listed');
  assert.equal(await page.locator('#itabs [data-k="packaging"][aria-pressed="true"]').count(), 1, 'switched to Packaging tab');
  await page.click('#itabs [data-k="ingredient"]');
  assert.ok(!/Ribbon/.test(await txt(page, '#sg')), 'packaging not in ingredients');

  // 6. daily count: exit mid-count and resume, edit from review, discard
  await page.click('nav.xtabs [data-v="count"]');
  await page.click('#cbody [data-a="cstart"]');
  await page.waitForSelector('#rm:not([hidden]) #cv');
  await page.click('#rm [data-a="cx"]');
  await page.click('#rm [data-a="cn"]');
  await page.waitForSelector('#rm #cv');
  await page.click('#rm [data-a="xr"]');
  await page.waitForSelector('#rm', { state: 'hidden' });
  await until(async () => /1 of \d+ counted/.test(await txt(page, '#cbody')), 'count in progress shown');
  assert.match(await txt(page, '#cbody'), /Resume count/);
  await page.click('#cbody [data-a="cstart"]');
  await page.waitForSelector('#rm:not([hidden]) #cv');
  await page.screenshot({ path: `${shots}/resumed.png` });
  while (!(await page.locator('#rm [data-a="csub"]').count())) {
    await page.click('#rm [data-a="cx"]');
    await page.click('#rm [data-a="cn"]');
    await page.waitForTimeout(150);
  }
  assert.match(await txt(page, '#rm'), /0 differences/, 'everything matches the system');
  await page.locator('#rm [data-a="cedit"]').first().click();
  await page.waitForSelector('#rm #cv');
  const exp = parseFloat(await page.getAttribute('#cv', 'placeholder'));
  await page.fill('#cv', String(exp + 0.1));
  await page.click('#rm [data-a="cn"]');
  await page.waitForSelector('#rm [data-a="csub"]');
  assert.match(await txt(page, '#rm'), /1 difference/, 'the edit shows as a difference');
  await page.click('#rm [data-a="csub"]');
  await page.waitForSelector('#rm', { state: 'hidden' });
  await until(async () => /differences/.test(await txt(page, '#cbody')) && !/No counts yet/.test(await txt(page, '#cbody')), 'history row');
  await page.click('#cbody [data-a="cstart"]');
  await page.waitForSelector('#rm:not([hidden]) #cv');
  await page.click('#rm [data-a="xr"]');
  await page.waitForSelector('#cbody [data-a="cdisc"]');
  page.once('dialog', (d) => d.accept());
  await page.click('#cbody [data-a="cdisc"]');
  await until(async () => /Start daily count/.test(await txt(page, '#cbody')), 'count thrown away');

  // 7. theme toggle sticks across a reload
  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  await openMenu(page);
  await page.click('#xmn [data-acct]');
  await page.waitForSelector('.cx-d');
  await page.click(`.cx-d [data-th="${theme0 === 'dark' ? 'light' : 'dark'}"]`);
  await page.click('.cx-d [data-x="close"]');
  const theme1 = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.notEqual(theme1, theme0);
  await page.reload();
  await page.waitForSelector('#sg .rc');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme1, 'theme kept after reload');

  // 8. another role's page redirects to this one
  await page.goto(shop.base + '/baker.html');
  await page.waitForURL('**/inventory.html');

  assert.deepEqual(errs, []);
  console.log('inventory edge ok');
} catch (e) {
  console.log('ERRS', errs);
  console.log('PAGE', await globalThis.PG?.locator('main').innerText().catch(() => '-').then((t) => t.slice(0, 800)));
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
