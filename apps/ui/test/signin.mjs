import assert from 'node:assert/strict';
import { startShop, loadPlaywright } from './harness.mjs';
const { chromium } = loadPlaywright();

const shop = await startShop();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(shop.base + '/');
  await page.waitForSelector('#pick button');
  assert.equal(await page.locator('#pick button').count(), 5, 'five staff listed');
  // wrong PIN
  await page.locator('#pick button', { hasText: /cashier/i }).click();
  for (const d of '0000') await page.click(`#pad button[data-k="${d}"]`);
  assert.equal(await page.isDisabled('#ok'), false);
  await page.click('#ok');
  await page.waitForSelector('.msg.err');
  assert.match(await page.textContent('#msg'), /\S/);
  assert.equal(await page.locator('#dots i.on').count(), 0, 'dots cleared after a wrong PIN');
  // too short stays disabled
  for (const d of '222') await page.click(`#pad button[data-k="${d}"]`);
  assert.equal(await page.isDisabled('#ok'), true);
  // right PIN lands on the cashier page (file does not exist yet, so only check the address)
  await page.click('#pad button[data-k="2"]');
  await page.click('#ok');
  await page.waitForURL('**/cashier.html');
  // back at "/" while signed in goes straight on
  await page.goto(shop.base + '/');
  await page.waitForURL('**/cashier.html');
  assert.deepEqual(errs, []);
  console.log('sign-in ok');
} finally {
  await browser.close();
  await shop.stop();
}
