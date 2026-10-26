// The whole shop in Kiswahili: the owner switches the language, every role's screens come out in Kiswahili
// (no English sentences left behind), and switching back to English puts the English text back.
import assert from 'node:assert/strict';
import { startShop, loadPlaywright, until, PINS, openMenu, menuGo } from './harness.mjs';
const { chromium } = loadPlaywright();
const shop = await startShop();
const browser = await chromium.launch();
const errs = [];
const missed = new Set();
const ROLE_SW = { owner: 'Mmiliki', cashier: 'Keshia', baker: 'Mwokaji', inventory: 'Stoo', it: 'IT' };
// Words that only an English sentence contains. A line with two of them was not translated.
const ENGLISH = new Set('the and your you is are was were with this that not can will has have from or if here yet first then when must please nothing there these those been which what who'.split(' '));

async function open(role, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('cake-pos-collect', '1');
    } catch {}
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.text().startsWith('@@MISSED ')) missed.add(JSON.parse(m.text().slice(9)));
  });
  page.on('pageerror', (e) => errs.push(`${role}: ${e}`));
  await page.goto(shop.base + '/');
  await page.waitForSelector('#pick button');
  await page.locator('#pick button', { hasText: new RegExp(`^.*${label}$`, "i") }).first().click();
  for (const d of PINS[role]) await page.click(`#pad button[data-k="${d}"]`);
  await page.click('#ok');
  await page.waitForURL(`**/${role}.html`);
  return page;
}

/** The settings button does nothing until the shop settings have loaded, so press it until the drawer is there. */
async function openSettings(page) {
  await until(async () => {
    const sel = page.locator('select[data-k="sl"]');
    if (!(await sel.isVisible())) {
      if (!(await page.locator('#dpn [data-d="sec"][data-s="language"]').isVisible())) await menuGo(page, 'settings');
      if (await page.locator('#dpn [data-d="sec"][data-s="language"]').isVisible()) await page.click('#dpn [data-d="sec"][data-s="language"]');
    }
    return await sel.isVisible();
  }, 'the settings drawer opens');
}

/** Visible text lines that still read as English. */
async function englishLines(page) {
  const lines = await page.evaluate(() =>
    document.body.innerText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return lines.filter((l) => l.split(/[^A-Za-z']+/).filter((w) => ENGLISH.has(w.toLowerCase())).length >= 2);
}

async function sweep(page, role) {
  const found = new Map();
  const tabs = await page.locator('nav button[data-v], nav [data-v]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-v')))]);
  const visit = async (v) => {
    if (v) await page.locator(`nav [data-v="${v}"]`).first().click();
    await page.waitForTimeout(500);
    for (const l of await englishLines(page)) found.set(l, v ?? 'home');
  };
  await visit(null);
  for (const v of tabs) await visit(v);
  // My account, opened from the name at the top.
  if (await page.locator('#xmenu').count()) {
    await openMenu(page);
    await page.waitForTimeout(300);
    for (const l of await englishLines(page)) found.set(l, 'menu');
    await page.click('#xmn [data-acct]');
  } else await page.locator('.who').first().click();
  await page.waitForSelector('.cx-d');
  await page.waitForTimeout(400);
  for (const l of await englishLines(page)) found.set(l, 'account');
  await page.click('.cx-d [data-x="close"]');
  return [...found].map(([l, v]) => `${role}/${v}: ${l}`);
}

try {
  /* The owner switches the shop to Kiswahili from Settings. */
  const owner = await open('owner', 'Owner');
  await openSettings(owner);
  await owner.selectOption('select[data-k="sl"]', 'sw');
  await owner.click('[data-d="secsave"]');
  await until(async () => /Mipangilio|Hifadhi/.test(await owner.locator('body').innerText()), 'the owner screen turns to Kiswahili');
  assert.equal(await owner.evaluate(() => localStorage.getItem('cake-pos-lang')), 'sw');
  await owner.click('[data-d="close"]');

  /* The sign-in page, which nobody is signed in on, follows the shop. */
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(shop.base + '/');
  await anon.waitForSelector('#pick button');
  await until(async () => /Mmiliki|Keshia/.test(await anon.locator('#pick').innerText()), 'sign-in page shows roles in Kiswahili');

  /* Every role, every tab. */
  const left = [];
  left.push(...(await sweep(owner, 'owner')));
  for (const role of ['cashier', 'baker', 'inventory', 'it']) {
    const page = await open(role, ROLE_SW[role]);
    left.push(...(await sweep(page, role)));
  }
  // Names the shop typed in (products, people, devices) stay as they are. Anything else with no Kiswahili is a gap.
  const DATA = /Cake POS|Chocolate Fudge Cake|Lemon Drizzle Cake|Red Velvet Cake|Chocolate ganache|Vanilla cream|Counter tablet|one tray slightly dark|Gluten-free|Eggless|Standard|Slice|Cakes|Amina|Baraka|Neema|Juma|Ibrahim|\bIT\b|\bOwner\b|TSh|Ctrl K|XXXX-XXXX|linux x64|\/tmp\/\S+/g;
  const gaps = [...missed].filter((m) => /[A-Za-z]{3}/.test(m.replace(DATA, '').replace(/[·,:()\d\s-]/g, ''))).sort();
  if (gaps.length) console.log('No Kiswahili for:\n' + gaps.join('\n'));
  if (left.length) console.log('Still English:\n' + left.join('\n'));
  assert.equal(left.length, 0, 'no English sentences left on any screen');
  assert.equal(gaps.length, 0, 'every screen text has Kiswahili');

  /* Back to English. */
  await openSettings(owner);
  await owner.selectOption('select[data-k="sl"]', 'en');
  await owner.click('[data-d="secsave"]');
  await until(async () => (await owner.evaluate(() => localStorage.getItem('cake-pos-lang'))) === 'en', 'the owner screen is English again');
  assert.equal(await owner.evaluate(() => localStorage.getItem('cake-pos-lang')), 'en');
  await owner.click('[data-d="close"]');
  assert.deepEqual(errs, [], 'no page errors');
  console.log('lang ok');
} finally {
  await browser.close();
  await shop.stop();
}
