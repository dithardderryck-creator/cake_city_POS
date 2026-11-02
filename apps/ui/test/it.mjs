// The IT page: the shared top bar and menu, Health first, a locked-out person let back in, the sync buttons and the plain record list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startShop, signInAs, loadPlaywright, until, menuGo, openMenu } from './harness.mjs';
const { chromium } = loadPlaywright();
const shots = '/tmp/ui-shots-it';
fs.mkdirSync(shots, { recursive: true });
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`));
  p.on('console', (m) => m.type() === 'error' && !/status of (401|403|422|429)/.test(m.text()) && errs.push(`${tag}: console ${m.text()}`));
};
const txt = (p, s) => p.locator(s).first().innerText();
try {
  /* ---- a baker is shut out by wrong PINs ---- */
  const bctx = await browser.newContext();
  const bp = await bctx.newPage();
  watch(bp, 'baker');
  await bp.goto(shop.base + '/');
  await bp.waitForSelector('#pick button');
  const bakerId = await bp.evaluate(async () => (await Cake.staff()).find((r) => r.role === 'baker').userId ?? (await Cake.staff()).find((r) => r.role === 'baker').id);
  for (let i = 0; i < 5; i++) await bp.evaluate((id) => Cake.client.signIn(id, '0000'), bakerId);
  const locked = await bp.evaluate((id) => Cake.client.signIn(id, '3333'), bakerId);
  assert.equal(locked.ok, false, 'the right PIN is refused while locked');

  /* ---- IT on a phone ---- */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const it = await ctx.newPage();
  watch(it, 'it');
  await signInAs(it, shop.base, 'it');
  await it.waitForSelector('#ndb .nd');
  assert.match(await it.locator('.xnm').first().textContent(), /Ibrahim/);
  assert.match(await txt(it, '#hi'), /Good (morning|afternoon|evening), Ibrahim/);
  assert.equal(await it.locator('nav.xtabs button').count(), 4, 'Health, Devices, Records, Backups');
  assert.match(await txt(it, '#sells'), /Normal/);
  assert.match(await txt(it, '#ndb'), /Neema.* is locked out/);
  assert.equal(await it.locator('#xbn').textContent(), '1', 'the bell counts what needs him');
  await it.screenshot({ path: `${shots}/health-phone.png`, fullPage: true });

  // Let in: the row goes, the bell clears, and the baker can sign in with the right PIN at once.
  await it.click('#ndb [data-unlock]');
  await until(async () => /Nothing needs you/.test(await txt(it, '#ndb')), 'the locked-out row goes after Let in');
  assert.equal((await it.locator('#xbn').textContent()).trim(), '', 'the bell clears');
  const back = await bp.evaluate((id) => Cake.client.signIn(id, '3333'), bakerId);
  assert.equal(back.ok, true, 'the baker is let back in');

  // The four cards open their tabs.
  assert.equal(await it.locator('#ck .card').count(), 4);
  await it.click('#ck [data-go="devices"]');
  await it.waitForSelector('#v-devices:not([hidden])');
  await it.waitForSelector('#dvb');
  await it.screenshot({ path: `${shots}/devices-phone.png`, fullPage: true });

  // Records: a plain list, with the unlock written down, no name said twice, and Show more.
  await menuGo(it, 'records');
  await it.waitForSelector('#v-records:not([hidden]) #aul li');
  assert.match(await txt(it, '#aul'), /back in/i);
  const row = (await it.locator('#aul li', { hasText: /back in/i }).first().innerText()).replace(/\s+/g, ' ');
  assert.match(row, /Ibrahim \(IT\) · Let Neema.* back in/, 'who, then what');
  assert.equal(row.split('Ibrahim').length - 1, 1, 'the name is said once');
  await it.screenshot({ path: `${shots}/records-phone.png`, fullPage: true });

  // The seal: a status card, a check on demand, money kept behind a lock until opened (and opening is written down).
  await it.waitForSelector('#rcv dt');
  assert.match(await txt(it, '#rcv'), /Sealed records/);
  await it.click('#rcn');
  await until(async () => /Matches/.test(await txt(it, '#rct')), 'the check says it matches');
  assert.match(await txt(it, '#rcv'), /what is new/, 'the last check is shown');
  await it.click('#rca');
  await until(async () => /everything/.test(await txt(it, '#rcv')), 'a full check is shown');
  const locks = it.locator('#aul [data-seq]');
  assert.ok((await locks.count()) > 0, 'money rows are sealed behind a lock');
  assert.doesNotMatch(await txt(it, '#aul'), /TSh \d/, 'no money amounts shown before opening');
  await locks.first().click();
  await it.waitForSelector('.cx-d .tag');
  assert.match(await it.locator('.cx-d').innerText(), /Matches its seal/);
  await it.screenshot({ path: `${shots}/records-open-phone.png` });
  await it.click('.cx-d [data-close]');
  await it.selectOption('#auf', 'opened');
  await until(async () => /Opened record/.test(await txt(it, '#aul')), 'opening was written down');
  assert.equal(await it.locator('#aul [data-seq]').count(), 0, 'the opened filter shows no locked rows');
  await it.selectOption('#auf', 'all');
  await it.waitForSelector('#aul [data-seq]');

  // Sessions: who is signed in, with no token or PIN anywhere on the page.
  await menuGo(it, 'sessions');
  await it.waitForSelector('#v-sessions:not([hidden]) #sel li');
  assert.match(await txt(it, '#sel'), /Ibrahim/);
  assert.match(await txt(it, '#sen'), /\d+ (person|people)/);
  assert.doesNotMatch(await it.locator('#v-sessions').innerText(), /token|pin hash/i);
  await it.screenshot({ path: `${shots}/sessions-phone.png`, fullPage: true });

  // Logs: a note or lines, the filters change the question asked, and the search narrows what is shown.
  await menuGo(it, 'logs');
  await it.waitForSelector('#v-logs:not([hidden])');
  await until(async () => !/Loading/.test(await txt(it, '#lgn')), 'the log answers');
  await it.selectOption('#lgl', 'error');
  await until(async () => !/Loading/.test(await txt(it, '#lgn')), 'the log answers for errors only');
  await it.fill('#lgq', 'zzzz-nothing-matches');
  assert.equal(await it.locator('#lgb li').count(), 0);
  await it.fill('#lgq', '');
  await it.screenshot({ path: `${shots}/logs-phone.png`, fullPage: true });

  // Backups: both sync buttons answer.
  await it.click('nav.xtabs [data-v="backups"]');
  await it.waitForSelector('#bkv');
  await it.click('#bk [data-v="flush"]');
  await it.waitForTimeout(300);
  it.once('dialog', (d) => d.accept());
  await it.click('#bk [data-v="full"]');
  await it.waitForTimeout(400);
  await it.screenshot({ path: `${shots}/backups-phone.png`, fullPage: true });

  // No sideways scroll on any tab.
  for (const v of ['health', 'devices', 'records', 'backups', 'sessions', 'staff', 'logs']) {
    await menuGo(it, v);
    await it.waitForTimeout(150);
    const wide = await it.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(wide, false, `no sideways scroll on ${v}`);
  }

  // Operations that change things all show what they will do first. Pausing selling reaches every screen.
  const sp = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  watch(sp, 'seller');
  await signInAs(sp, shop.base, 'cashier');
  await menuGo(it, 'health');
  it.once('dialog', (d) => d.accept('Back at 2 pm'));
  await it.click('#sellb');
  await it.waitForSelector('.cx-d [data-ok]');
  assert.match(await it.locator('.cx-d').innerText(), /Stops new sales/);
  await it.click('.cx-d [data-ok]');
  await until(async () => /Paused/.test(await txt(it, '#sells')), 'selling shows as paused');
  assert.match(await txt(it, '#sellt'), /Back at 2 pm/);
  await until(async () => (await sp.locator('.cx-n[data-paused]').count()) > 0, 'the cashier screen says selling is paused');
  const refusedSale = await sp.evaluate(async () => (await Cake.client.dispatch('orders/quick_sale', { items: [{ combinationId: 'x', qty: 1 }], method: 'cash' })).error?.messages.join(' '));
  assert.match(refusedSale, /Selling is paused: Back at 2 pm/);
  await it.screenshot({ path: `${shots}/paused-phone.png`, fullPage: true });
  await it.click('#sellb');
  await it.waitForSelector('.cx-d [data-ok]');
  await it.click('.cx-d [data-ok]');
  await until(async () => /Normal/.test(await txt(it, '#sells')), 'selling is back to normal');
  await until(async () => (await sp.locator('.cx-n[data-paused]').count()) === 0, 'the notice goes away');

  // Sessions: sign the cashier out, after the preview. IT's own row has no button.
  await menuGo(it, 'sessions');
  await it.waitForSelector('#sel [data-end]');
  assert.equal(await it.locator('#sel li', { hasText: /Ibrahim/ }).locator('[data-end]').count(), 0, 'no sign-out button on your own row');
  await it.locator('#sel li', { hasText: /Baraka/ }).locator('[data-end]').click();
  await it.waitForSelector('.cx-d [data-ok]');
  assert.match(await it.locator('.cx-d').innerText(), /Signs Baraka.* out of 1 sign-in/);
  await it.click('.cx-d [data-no]');
  assert.equal(await sp.evaluate(async () => (await Cake.client.feed('me', {})).ok), true, 'cancelling changes nothing');
  await it.locator('#sel li', { hasText: /Baraka/ }).locator('[data-end]').click();
  await it.waitForSelector('.cx-d [data-ok]');
  await it.click('.cx-d [data-ok]');
  await until(async () => !(await sp.evaluate(async () => (await Cake.client.feed('me', {})).ok)), 'the cashier is signed out');

  // Staff access: add, change a PIN, remove (the name is typed first), and the owner's PIN asks for her name and tells her.
  await menuGo(it, 'staff');
  await it.waitForSelector('#sfl li');
  await it.fill('#sfa', 'Salma');
  await it.fill('#sfp', '5555');
  await it.click('#sfadd');
  await until(async () => /Salma/.test(await txt(it, '#sfl')), 'the new person is listed');
  it.once('dialog', (d) => d.accept('6666'));
  await it.locator('#sfl li', { hasText: /Salma/ }).locator('[data-sf="pin"]').click();
  await it.waitForSelector('.cx-d [data-ok]');
  assert.match(await it.locator('.cx-d').innerText(), /signed out everywhere/);
  assert.equal(await it.locator('.cx-d [data-cc]').count(), 0, 'no name needed for a cashier');
  await it.click('.cx-d [data-ok]');
  await it.locator('#sfl li', { hasText: /Salma/ }).locator('[data-sf="del"]').click();
  await it.waitForSelector('.cx-d [data-cc]');
  assert.equal(await it.locator('.cx-d [data-ok]').isDisabled(), true, 'removing waits for the name');
  await it.fill('.cx-d [data-cc]', 'Salma');
  await it.click('.cx-d [data-ok]');
  await until(async () => !/Salma/.test(await txt(it, '#sfl')), 'the person is removed');
  it.once('dialog', (d) => d.accept('2468'));
  await it.locator('#sfl li', { hasText: /Amina/ }).locator('[data-sf="pin"]').click();
  await it.waitForSelector('.cx-d [data-cc]');
  assert.match(await it.locator('.cx-d').innerText(), /sees a note on the Overview/);
  assert.equal(await it.locator('.cx-d [data-ok]').isDisabled(), true);
  await it.fill('.cx-d [data-cc]', 'Amina (Owner)');
  await it.click('.cx-d [data-ok]');
  await until(async () => (await it.locator('.cx-d').count()) === 0, 'the dialog closes');
  await it.screenshot({ path: `${shots}/staff-phone.png`, fullPage: true });
  const op = await (await browser.newContext()).newPage();
  watch(op, 'owner');
  await op.goto(shop.base + '/');
  await op.locator('#pick button', { hasText: /owner$/i }).first().click();
  for (const d of '2468') await op.click(`#pad button[data-k="${d}"]`);
  await op.click('#ok');
  await op.waitForURL('**/owner.html');
  await until(async () => !(await op.locator('#pcn').isHidden()), 'the owner is told her PIN was changed');
  assert.match(await op.locator('#pcb').innerText(), /Ibrahim/);
  await op.click('#pck');
  await until(async () => op.locator('#pcn').isHidden(), 'the note goes away once seen');

  // The menu has the shared groups, My account and Sign out, like every other role.
  await openMenu(it);
  const menu = await it.locator('#xmn').innerText();
  for (const w of ['WATCH', 'FIX AND CONTROL', 'CONNECT', 'Logs', 'Sessions', 'Staff access', 'My account', 'Sign out']) assert.match(menu.replace(/\n/g, ' '), new RegExp(w, 'i'), w);
  await it.click('#xout');
  await it.waitForURL(shop.base + '/');

  // A cashier cannot let anyone in or read the system map.
  const cp = await (await browser.newContext()).newPage();
  watch(cp, 'cashier');
  await signInAs(cp, shop.base, 'cashier');
  const refused = await cp.evaluate(async (id) => (await Cake.client.dispatch('staff/unlock', { userId: id })).ok, bakerId);
  assert.equal(refused, false);

  const html = fs.readFileSync(new URL('../pages/it.html', import.meta.url), 'utf8');
  for (const bad of ['Demo', 'Moses', 'Zawadi', 'Neema', 'Amina', 'fonts.googleapis']) assert.ok(!html.includes(bad), 'leftover: ' + bad);
  assert.deepEqual(errs, []);
  console.log('it page ok');
} catch (e) {
  console.log('ERRS', errs);
  throw e;
} finally {
  await browser.close();
  await shop.stop();
}
