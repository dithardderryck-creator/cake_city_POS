// A till keeps selling when the shop server dies, shows a slip that says plainly the sale is not sent yet, and the sales
// arrive once, in order, when the server is back. A sale edited on the device is refused, and the cashier is told.
import assert from 'node:assert/strict';
import { startShop, signInAs, loadPlaywright, until, PINS } from './harness.mjs';
const { chromium } = loadPlaywright();

const shop = await startShop({ requireDevice: true });
const browser = await chromium.launch();
const errs = [];
const txt = (p, sel) => p.locator(sel).first().innerText();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Refusals while the server is down are expected; only real script errors count.
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
};

/** A browser registered with a pairing code, the way a person at the shop would do it. */
async function registered(name, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(shop.base + '/');
  await page.waitForSelector('#pair:not([hidden])');
  const r = await page.evaluate((code) => Cake.pairDevice(code), shop.deviceCode(name));
  assert.ok(r.name, 'registered ' + name);
  return page;
}

try {
  /* The owner's browser: registers, switches offline selling on, and watches. */
  const op = await registered('Owner laptop');
  await op.reload();
  await op.waitForSelector('#pick button');
  const owner = await op.evaluate(async (pin) => {
    const row = (await Cake.staff()).find((r) => r.role === 'owner');
    const r = await Cake.client.signIn(row.userId ?? row.id, pin);
    return r.ok;
  }, PINS.owner);
  assert.equal(owner, true);
  const send = (t, p) => op.evaluate(([t, p]) => Cake.client.dispatch(t, p), [t, p]);
  const read = (n) => op.evaluate((n) => Cake.read(n, {}), n);
  assert.equal((await send('settings/update', { offlineEnabled: true })).ok, true);
  const instant = async () => {
    try {
      return ((await read('order_list')) || []).filter((o) => o.instant).length;
    } catch {
      return -1;
    }
  };

  /* The till. */
  const page = await registered('Counter');
  watch(page, 'till');
  await signInAs(page, shop.base, 'cashier');
  await page.waitForSelector('#tiles .tile:not([disabled])');
  await until(() => page.evaluate(() => Cake.offlineStatus().canSell), 'the till to be given its offline pass', 20000);
  const before = await instant();

  const fillTicket = async () => {
    await page.locator('#tiles .tile:not([disabled])').first().click();
    await page.click('#pay [data-i="cash"]');
    await page.fill('#rcv', '99999999');
  };

  /* 1. The server dies in the middle of the day. The till says so and keeps selling. */
  await fillTicket();
  await shop.crash();
  await until(async () => /selling offline/i.test(await txt(page, '#net')), 'the till to say it is selling offline', 30000);
  assert.match(await txt(page, '#offline'), /Cannot reach the shop server/, 'the bar says so in words');
  assert.match(await txt(page, '#offline'), /keep selling/i, 'and says selling can go on');
  assert.equal(await page.isDisabled('#go'), false, 'Pay still works for a ready-made walk-in sale');

  await page.click('#pt'); // part payment needs the server: it is switched off
  assert.equal(await page.isDisabled('#go'), true, 'a part payment cannot be taken offline');
  await page.click('#pt');
  assert.equal(await page.isDisabled('#go'), false);

  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2', { timeout: 20000 });
  assert.match(await txt(page, '#mod h2'), /Saved on this till · sale 1/);
  assert.match(await txt(page, '#mod .chip'), /Not sent yet/, 'the slip says plainly that it is not sent');
  assert.doesNotMatch(await txt(page, '#mod .dlg'), /Receipt/, 'it is not presented as a receipt');
  await page.click('#mod [data-a="mc"]');
  assert.equal(await page.locator('#lines .ln').count(), 0, 'the ticket is cleared once the sale is saved');
  assert.match(await txt(page, '#offline'), /1 sale is waiting/, 'the bar counts the waiting sale');

  await fillTicket();
  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2');
  assert.match(await txt(page, '#mod h2'), /sale 2/);
  await page.click('#mod [data-a="mc"]');
  assert.match(await txt(page, '#offline'), /2 sales are waiting/);

  /* 2. The server comes back. Both sales arrive, once. */
  await shop.restart();
  await until(async () => (await instant()) === before + 2, 'both saved sales to reach the shop', 90000);
  await until(() => page.evaluate(() => Cake.offlineStatus().waiting === 0), 'the till to clear its queue', 30000);
  await until(async () => (await page.locator('#offline').isHidden()), 'the bar to go away', 30000);
  await wait(1500);
  assert.equal(await instant(), before + 2, 'exactly two sales were made, none doubled');
  assert.equal(await page.evaluate(() => Cake.offlineStatus().notices.length), 0, 'nothing needed a look');

  /* 3. A sale edited on the device is refused, and the cashier is told. Nothing is sold. */
  await until(() => page.evaluate(() => Cake.offlineStatus().canSell), 'the pass to still be good', 30000);
  await fillTicket();
  await shop.crash();
  await until(async () => /unreachable/i.test(await txt(page, '#net')), 'the till to notice', 30000);
  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2');
  assert.match(await txt(page, '#mod h2'), /sale 3/);
  await page.click('#mod [data-a="mc"]');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('cake-pos-offline'));
    const pass = Object.values(s.passes).find((p) => p.queue.length);
    pass.queue[0].payload.items[0].qty = 9; // somebody changes what was sold
    localStorage.setItem('cake-pos-offline', JSON.stringify(s));
  });
  await shop.restart();
  await until(() => page.evaluate(() => Cake.offlineStatus().notices.length === 1), 'the till to be told the sale was refused', 90000);
  assert.equal(await instant(), before + 2, 'the edited sale was not sold');
  await until(async () => /needs a look/i.test(await txt(page, '#offline')), 'the bar to ask for a look', 20000);
  await page.click('#offline-b');
  const dlg = await txt(page, '.cx-d');
  assert.match(dlg, /Sale 3/);
  assert.match(dlg, /The server refused it/);
  assert.match(dlg, /changed after it was made/);
  await page.click('#off-ok');
  assert.equal(await page.evaluate(() => Cake.offlineStatus().notices.length), 0, 'noted, and cleared');
  await until(async () => (await page.locator('#offline').isHidden()), 'the bar to go away', 20000);

  assert.deepEqual(errs, [], 'no page errors: ' + errs.join(' | '));
  console.log('offline selling ok');
} finally {
  await browser.close();
  await shop.stop();
}
