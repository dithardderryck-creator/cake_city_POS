// Starts the BUILT shop server on a free port with demo data, serving apps/ui/dist. For browser checks only.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverJs = path.join(root, 'packages/server/dist/cake-pos-server.mjs');
const adminJs = path.join(root, 'packages/server/dist/cake-pos-admin.mjs');

export const PINS = { owner: '1111', cashier: '2222', baker: '3333', inventory: '4444', it: '9999' };

export async function startShop({ seed = true, requireDevice = false, env: extraEnv = {} } = {}) {
  if (!fs.existsSync(serverJs)) throw new Error('Build the server first: npm run build -w @cake-pos/server');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-ui-'));
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const env = {
    ...process.env,
    DATA_DIR: path.join(work, 'data'),
    PORT: String(port),
    HOST: '127.0.0.1',
    STATIC_DIR: process.env.UI_DIST ? path.resolve(process.env.UI_DIST) : path.join(root, 'apps/ui/dist'),
    LOG_LEVEL: 'warn',
    // Most browser checks are not about devices, so the device check is off unless a test asks for it.
    REQUIRE_DEVICE: requireDevice ? '1' : '0',
    ...extraEnv,
  };
  if (seed) execFileSync(process.execPath, [adminJs, 'seed-demo', '--yes'], { env, encoding: 'utf8' });
  let child;
  const launch = async () => {
    child = spawn(process.execPath, [serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 100; i++) {
      if (out.includes('server is running')) break;
      if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!out.includes('server is running')) throw new Error(`server did not start:\n${out}`);
  };
  await launch();
  return {
    /** The server stops answering but stays alive, like a machine that has hung. Requests wait in line. */
    freeze: () => child.kill('SIGSTOP'),
    thaw: () => child.kill('SIGCONT'),
    /** The server dies at once, mid-anything (a crash or a power cut). */
    crash: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      }),
    /** Starts it again on the same port with the same data, as after a reboot. */
    restart: launch,
    base: `http://127.0.0.1:${port}`,
    port,
    env,
    /** A one-time pairing code, made the way a person at the shop computer would (admin tool). */
    deviceCode: (name) => {
      const out = execFileSync(process.execPath, [adminJs, 'device-code', '--name', name], { env, encoding: 'utf8' });
      return /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)[1];
    },
    stop: () =>
      new Promise((resolve) => {
        const done = () => {
          fs.rmSync(work, { recursive: true, force: true });
          resolve();
        };
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once('exit', done);
        child.kill('SIGCONT'); // a frozen process cannot hear a polite stop
        child.kill('SIGTERM');
      }),
  };
}

/** Signs a person in through the real sign-in page. */
export async function signInAs(page, base, role) {
  await page.goto(base + '/');
  const btn = page.locator('#pick button', { hasText: new RegExp(`^.*${role}$`, 'i') }).first();
  await btn.click();
  for (const d of PINS[role]) await page.click(`#pad button[data-k="${d}"]`);
  await page.click('#ok');
  await page.waitForURL(`**/${role}.html`);
}

/** Playwright is not a project dependency (browsers are installed on the machine), so find it where it lives. */
export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  let pw;
  try {
    pw = req('playwright');
  } catch {
    const g = execSync('npm root -g', { encoding: 'utf8' }).trim();
    pw = createRequire(path.join(g, 'x.js'))('playwright');
  }
  // With I18N_COLLECT=<file>, every page records the English text it showed that has no Kiswahili yet (see src/i18n.ts).
  if (process.env.I18N_COLLECT && !pw.__i18nWrapped) {
    pw.__i18nWrapped = true;
    const file = process.env.I18N_COLLECT;
    const launch = pw.chromium.launch.bind(pw.chromium);
    pw.chromium.launch = async (...args) => {
      const browser = await launch(...args);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...a) => {
        const ctx = await newContext(...a);
        await ctx.addInitScript(() => {
          try {
            localStorage.setItem('cake-pos-collect', '1');
            localStorage.setItem('cake-pos-lang', 'sw');
          } catch {}
        });
        ctx.on('page', (page) =>
          page.on('console', (m) => {
            const t = m.text();
            if (t.startsWith('@@MISSED ')) fs.appendFileSync(file, t.slice(9) + '\n');
          }),
        );
        return ctx;
      };
      return browser;
    };
  }
  return pw;
}

/** Signs in as another role in its own browser context without opening a page of theirs, and returns a way to send and read. */
export async function actor(browser, shop, role, onPage) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  onPage?.(p, role);
  await p.goto(shop.base + '/');
  await p.waitForSelector('#pick button');
  await p.evaluate(
    async ([role, pin]) => {
      const rows = await Cake.staff();
      const row = rows.find((r) => r.role === role);
      const r = await Cake.client.signIn(row.userId ?? row.id, pin);
      if (!r.ok) throw new Error('sign in failed');
    },
    [role, PINS[role]],
  );
  return {
    send: (type, payload) => p.evaluate(([t, pl]) => Cake.client.dispatch(t, pl), [type, payload]),
    read: (name, params = {}) => p.evaluate(([n, pr]) => Cake.read(n, pr), [name, params]),
    /** Uploads a small picture and returns its id. */
    photo: (bytes) => p.evaluate(async (b) => (await Cake.client.uploadPhoto(new Uint8Array(b), 'image/png')).photoId, [...bytes]),
  };
}

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for ' + what);
};
