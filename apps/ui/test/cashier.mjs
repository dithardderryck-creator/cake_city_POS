import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, PINS } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-cashier';
fs.mkdirSync(shots, { recursive: true });
// A tiny valid PNG for the photo upload.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for ' + what);
};
const txt = (p, sel) => p.locator(sel).first().innerText();

/** Signs in as another role in its own browser context, without leaving the sign-in page, and returns a way to send intents. */
async function actor(role) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  watch(p, role);
  await p.goto(shop.base + '/');
  await p.waitForSelector('#pick button');
  await p.evaluate(async ([role, pin]) => {
    const rows = await Cake.staff();
    const row = rows.find((r) => r.role === role);
    const r = await Cake.client.signIn(row.userId ?? row.id, pin);
    if (!r.ok) throw new Error('sign in failed');
  }, [role, PINS[role]]);
  return {
    send: (type, payload) => p.evaluate(([t, pl]) => Cake.client.dispatch(t, pl), [type, payload]),
    read: (name, params = {}) => p.evaluate(([n, pr]) => Cake.read(n, pr), [name, params]),
  };
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  watch(page, 'cashier');
  await signInAs(page, shop.base, 'cashier');
  await page.waitForTimeout(500);
  // The "offline" bar must take no room while the shop is reachable (it once showed as a red strip).
  assert.equal(await page.evaluate(() => { const e = document.getElementById('offline'); return !e || e.getBoundingClientRect().height; }), 0, 'offline bar should be hidden when online');
  await page.waitForSelector('#tiles .tile');
  assert.match(await txt(page, '#who'), /Baraka/, 'shows who is signed in');
  assert.ok((await page.locator('#tiles .tile').count()) > 0, 'items for sale are listed');
  await page.screenshot({ path: `${shots}/sell.png` });

  // second cashier screen to prove live updates
  const watcher = await ctx.newPage();
  watch(watcher, 'watcher');
  await watcher.goto(shop.base + '/cashier.html');
  await watcher.waitForSelector('#tiles .tile');
  await watcher.click('#tabs [data-v="orders"]');
  const countOn = (p) => p.locator('#ol .ztt').count();
  const before = await countOn(watcher);

  // ---- walk-in cash sale ----
  const tile = page.locator('#tiles .tile:not([disabled])').first();
  await tile.click();
  await tile.click();
  assert.match(await txt(page, '#lines'), /2/, 'two on the ticket');
  const total = await txt(page, '#tot');
  assert.notEqual(total.trim(), '0');
  await page.click('#pay [data-i="cash"]');
  await page.fill('#rcv', '1000000');
  assert.match(await txt(page, '#cg'), /\d/, 'change shown');
  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2');
  assert.match(await txt(page, '#mod h2'), /Receipt/);
  assert.match(await txt(page, '#mod'), /Paid in full/);
  await page.screenshot({ path: `${shots}/receipt.png` });
  assert.equal((await page.locator('#lines .ln').count()), 0, 'ticket cleared after the sale');
  await page.click('#mod [data-a="mc"]');
  // a finished instant sale is not a ticket: it stays off the board (its receipt and the ledger still have it)
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await countOn(watcher), before, 'a finished instant sale stays off the Orders board');
  await watcher.click('#of [data-k="done"]');
  assert.equal(await watcher.locator('#ol .ztt').count(), 0, 'and out of the Closed column');
  await watcher.click('#of [data-k="all"]');

  // ---- phone order, delivery, part payment ----
  await page.locator('#tiles .tile:not([disabled])').nth(1).click();
  await page.click('#sg1 [data-v="phone"]');
  await page.click('#sg2 [data-v="delivery"]');
  await page.fill('#dn', 'Grace Mushi');
  await page.fill('#dp', '+255712345678');
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA');
  await page.fill('#dd', tomorrow);
  await page.fill('#da', 'Mikocheni B, house 12');
  await page.click('#pt');
  await page.fill('#rcv', '1');
  await page.click('#pay [data-i="mobile_money"]');
  await page.fill('#rcv', '1');
  await page.click('#go');
  await page.waitForSelector('#mod .dlg h2');
  assert.match(await txt(page, '#mod'), /Balance due|Grace Mushi/);
  await page.click('#mod [data-a="mc"]');
  await until(async () => (await countOn(watcher)) === before + 1, 'the other screen to show the new phone order without reloading');

  // ---- orders board and the ticket ----
  await page.click('#tabs [data-v="orders"]');
  await page.waitForSelector('#ol .ztt');
  await page.fill('#oq', 'Grace');
  assert.equal(await page.locator('#ol .ztt').count(), 1, 'search finds the ticket');
  await page.screenshot({ path: `${shots}/orders.png` });
  await page.click('#ol [data-a="open"]');
  await page.waitForSelector('#oc-main .num');
  assert.match(await txt(page, '#oc-main'), /Mikocheni B/);
  // refusal path: pay far more than owed
  await page.click('#oc-main [data-a="pay1"]');
  await page.fill('#bamt', '900000000');
  await page.click('#oc-form [data-a="bok"]');
  await page.waitForSelector('#toast.on');
  assert.match(await txt(page, '#toast'), /balance|more than/i, 'overpayment is refused in plain words');
  assert.ok(await page.locator('#oc-form #bamt').count(), 'form stays open after a refusal');
  await page.fill('#bamt', '');
  await page.click('#oc-form [data-a="bok"]');
  await until(async () => /Balance\s*(?:TSh\s*)?0\b/.test(await txt(page, '#oc-main')), 'balance cleared in the open ticket');
  await page.screenshot({ path: `${shots}/ticket.png` });
  // advance a line using whatever the server offers
  const adv = page.locator('#oc-main [data-a="adv"]').first();
  if (await adv.count()) {
    const label = (await adv.innerText()).trim();
    await adv.click();
    await until(async () => (await page.locator('#oc-main [data-a="adv"]').first().innerText().catch(() => '')).trim() !== label, 'the step to move on');
  }
  await page.click('#oc-main [data-a="mc"]');

  // ---- custom cake with a photo ----
  await page.click('#tabs [data-v="custom"]');
  await page.fill('#cn', 'Peter Kimaro');
  await page.fill('#cp', '+255755210009');
  await page.fill('#cd', tomorrow);
  await page.click('#csb');
  assert.match(await txt(page, '#toast'), /serve/i, 'needs servings');
  await page.fill('#csv', '20');
  await page.fill('#cfl', 'Chocolate');
  await page.fill('#cin', 'Happy Birthday Neema');
  await page.fill('#cal', 'Peanuts');
  await page.setInputFiles('#cph', { name: 'idea.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#th img');
  await page.screenshot({ path: `${shots}/custom.png` });
  await page.click('#csb');
  await until(async () => (await page.inputValue('#cn')) === '', 'form to clear after sending');
  await page.click('#tabs [data-v="orders"]');
  await page.fill('#oq', 'Peter');
  await until(async () => (await page.locator('#ol .ztt').count()) === 1, 'custom ticket on the board');
  assert.match(await txt(page, '#ol .ztt'), /Awaiting quote/);

  // ---- owner prices it: the cashier sees it live ----
  const owner = await actor('owner');
  const qi = await owner.read('quote_inbox');
  const quoteId = qi.open[0].quoteId;
  const pr = await owner.send('quotes/provide', { quoteId, price: 120000, note: 'Two layers' });
  assert.ok(pr.ok, JSON.stringify(pr));
  await until(async () => /120,000/.test(await txt(page, '#ol .ztt')), 'the price to appear on the ticket');

  // ---- requests and alerts ----
  await owner.send('requests/send', { toRole: 'cashier', category: 'Money', title: 'Count the till float', urgent: false });
  await until(async () => (await page.locator('#bn').innerText()).trim() !== '', 'bell badge');
  await page.click('#bell');
  await page.waitForSelector('#rq .cx-c');
  await until(async () => /Count the till float/.test(await txt(page, '#rq')), 'the request to show');
  await page.click('#rq [data-act="racknowledge"]');
  await until(async () => /taken by/i.test(await txt(page, '#rq')), 'taking it to show who has it');
  await page.screenshot({ path: `${shots}/requests.png` });
  // send one to the owner
  await page.click('#rq [data-act="new"]');
  await page.click('.cx-d [data-c="Order issue"]');
  await page.fill('#cx-ti', 'Customer wants to change the cake');
  await page.click('#cx-go');
  await until(async () => /Customer wants to change the cake/.test(await txt(page, '#rq')), 'my own request in the list');
  const ownerRows = (await owner.read('request_inbox')).rows;
  assert.ok(ownerRows.some((r) => r.title === 'Customer wants to change the cake'), 'the owner received it');

  // ---- announcements ----
  await owner.send('announcements/post', { text: 'Shop closes early on Friday', requiresAck: true });
  await until(async () => /Shop closes early/.test(await txt(page, '#ntc')), 'announcement notice');
  await page.click('#ntc [data-ack]');
  await until(async () => (await page.locator('#ntc [data-ack]').count()) === 0, 'acknowledge button to go');

  // ---- today's sales ----
  await page.click('#tabs [data-v="sales"]');
  await until(async () => (await page.locator('#sl .card').count()) >= 2, 'payments listed');
  assert.ok((await page.locator('#kp .card').count()) >= 2);
  await page.screenshot({ path: `${shots}/sales.png` });
  await page.click('#sl .card');
  await page.waitForSelector('#mod .dlg h2');
  await page.click('#mod [data-a="mc"]');

  // ---- phone size ----
  const ph = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pp = await ph.newPage();
  watch(pp, 'phone');
  await signInAs(pp, shop.base, 'cashier');
  await pp.waitForSelector('#tiles .tile');
  for (const v of ['sell', 'orders', 'custom', 'sales']) {
    await pp.click(`#tabs [data-v="${v}"]`);
    const over = await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(over, false, `no sideways scroll on ${v}`);
    await pp.screenshot({ path: `${shots}/phone-${v}.png` });
  }
  await pp.click('#bell');
  assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no sideways scroll on requests');

  // ---- sign out ----
  await page.click('[data-a="out"]');
  await page.waitForURL(shop.base + '/');

  // leftovers from the design
  const html = fs.readFileSync(new URL('../pages/cashier.html', import.meta.url), 'utf8');
  for (const bad of ['Demo', '1234', 'fonts.googleapis', 'Moses', 'TSh', 'setTimeout(()=>{const p=']) assert.ok(!html.includes(bad), `leftover: ${bad}`);
  assert.deepEqual(errs, []);
  console.log('cashier page ok');
} finally {
  await browser.close();
  await shop.stop();
}
