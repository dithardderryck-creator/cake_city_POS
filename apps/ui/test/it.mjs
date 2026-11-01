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
  for (const v of ['health', 'devices', 'records', 'backups', 'sessions', 'logs']) {
    await menuGo(it, v);
    await it.waitForTimeout(150);
    const wide = await it.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(wide, false, `no sideways scroll on ${v}`);
  }

  // The menu has the shared groups, My account and Sign out, like every other role.
  await openMenu(it);
  const menu = await it.locator('#xmn').innerText();
  for (const w of ['WATCH', 'FIX AND CONTROL', 'CONNECT', 'Logs', 'Sessions', 'My account', 'Sign out']) assert.match(menu.replace(/\n/g, ' '), new RegExp(w, 'i'), w);
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
