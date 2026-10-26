// The shop server freezes or dies in the middle of a sale. The cashier must be told the truth, lose nothing,
// and never sell twice when they tap again.
import assert from 'node:assert/strict';
import { startShop, signInAs, loadPlaywright, actor, until, addToTicket } from './harness.mjs';
const { chromium } = loadPlaywright();

const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const txt = (p, sel) => p.locator(sel).first().innerText();

try {
  const owner = await actor(browser, shop, 'owner');
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => errs.push(String(e)));
  await signInAs(page, shop.base, 'cashier');
  await page.waitForSelector('#tiles .tile:not([disabled])');
  const orders = async () => (await owner.read('order_list')).filter((o) => o.instant).length;
  const before = await orders();

  const fillTicket = async () => {
    await addToTicket(page);
    await page.click('#pay [data-i="cash"]');
    await page.fill('#rcv', '99999999');
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ready = (what) => until(async () => /connected/i.test(await txt(page, '#net')) && !(await page.isDisabled('#go')), what, 60000);

  /* 1. The server hangs while the sale is being sent. */
  await fillTicket();
  shop.freeze();
  await page.click('#go');
  assert.equal(await page.isDisabled('#go'), true, 'the Pay button is switched off while the sale is being sent, so it cannot be tapped twice');
  await page.waitForSelector('#toast.on', { timeout: 45000 });
  const said = await txt(page, '#toast');
  assert.match(said, /Cannot reach the shop server/, 'told plainly that the server could not be reached');
  assert.match(said, /may or may not have gone through/i, 'and not told that nothing happened, because it might have');
  assert.ok((await page.locator('#lines .ln').count()) > 0, 'the ticket is kept, nothing the cashier typed is lost');
  assert.equal(await page.locator('#mod .dlg h2').count(), 0, 'no receipt is shown for a sale that is not confirmed');

  /* 2. The server comes back; one tap finishes the sale, once, even though the frozen server also had the first request queued. */
  shop.thaw();
  await ready('the page to reconnect and Pay to work again');
  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2', { timeout: 20000 });
  assert.match(await txt(page, '#mod h2'), /Receipt/);
  await page.click('#mod [data-a="mc"]');
  await wait(500);
  assert.equal((await orders()) - before, 1, 'exactly one sale was made, not two');
  assert.equal(await page.locator('#lines .ln').count(), 0, 'and the ticket is cleared once it is confirmed');

  /* 3. The server crashes (power cut), then starts again with the same data. */
  await fillTicket();
  await shop.crash();
  await until(async () => /unreachable/i.test(await txt(page, '#net')), 'the page to say the server is unreachable', 30000);
  assert.equal(await page.isDisabled('#go'), true, 'Pay is off while the server is down, so nothing can be sent into the void');
  assert.match(await txt(page, '#offline'), /Cannot reach the shop server/, 'a bar says so in words');
  assert.ok((await page.locator('#lines .ln').count()) > 0, 'the ticket survives a crash');
  await shop.restart();
  await ready('the page to reconnect after the restart');
  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2', { timeout: 30000 });
  await page.click('#mod [data-a="mc"]');
  await wait(500);
  assert.equal((await orders()) - before, 2, 'after the restart, one more sale: two in total, none lost, none doubled');

  assert.deepEqual(errs, [], 'no page errors: ' + errs.join(' | '));
  console.log('server stop ok');
} finally {
  await browser.close();
  await shop.stop();
}
