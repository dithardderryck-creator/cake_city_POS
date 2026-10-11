// Acceptance walkthrough against the BUILT server, the way an owner would use it.
// Run:  npm run build && npm run acceptance
// It uses a throwaway data folder and a free port, and touches nothing else.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverJs = path.join(root, 'packages/server/dist/cake-pos-server.mjs');
const adminJs = path.join(root, 'packages/server/dist/cake-pos-admin.mjs');
if (!fs.existsSync(serverJs)) {
  console.error('Build first:  npm run build');
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-accept-'));
const cloud = path.join(work, 'cloud-folder');
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const env = { ...process.env, DATA_DIR: path.join(work, 'data'), PORT: String(port), HOST: '127.0.0.1', CLOUD_BACKUP_DIR: cloud, LOG_LEVEL: 'warn', STATIC_DIR: path.join(root, 'apps/ui/dist') };
const base = `http://127.0.0.1:${port}`;

let step = 0;
const ok = (msg) => console.log(`  \u2713 ${String(++step).padStart(2)}. ${msg}`);
const admin = (...args) => execFileSync(process.execPath, [adminJs, ...args], { env, encoding: 'utf8' });

let server = null;
async function start() {
  server = spawn(process.execPath, [serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    if (out.includes('server is running')) return;
    if (server.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${out}`);
}
const stop = (signal = 'SIGTERM') =>
  new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    server.kill(signal);
  });

// The secret this "browser" got when it was registered. Every request carries it, as the real pages do.
let deviceToken = '';
async function api(p, body, token) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(deviceToken ? { 'x-device-token': deviceToken } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, ...(await res.json()) };
}
const dispatch = async (token, type, payload) => {
  const r = await api('/api/dispatch', { type, payload, requestId: `${type}-${Math.random()}` }, token);
  assert.ok(r.ok, `${type} failed: ${JSON.stringify(r.error)}`);
  return r.data;
};
const feed = async (token, name, params = {}) => {
  const r = await api('/api/feed', { name, params }, token);
  assert.ok(r.ok, `${name} failed: ${JSON.stringify(r.error)}`);
  return r.data;
};
async function signIn(role, pin) {
  const staff = await (await fetch(base + '/api/staff', { headers: deviceToken ? { 'x-device-token': deviceToken } : {} })).json();
  const who = staff.data.find((s) => s.role === role);
  const r = await api('/api/sign-in', { userId: who.id, pin });
  assert.ok(r.ok, `sign-in failed: ${JSON.stringify(r.error)}`);
  return r.token;
}

try {
  console.log('\nAcceptance walkthrough\n');

  // ---- Set up with the admin tool, as on day one ----
  admin('create-owner', '--name', 'Amina', '--pin', '2468');
  assert.match(admin('list-staff'), /active\s+owner\s+Amina/);
  ok('admin tool created the owner');
  await start();
  ok('server started');
  for (const page of ['/', '/cashier.html', '/baker.html', '/inventory.html', '/owner.html', '/cake.js', '/fonts.css']) {
    const res = await fetch(base + page);
    assert.equal(res.status, 200, `${page} is served`);
  }
  ok('the server serves the sign-in page, the four role pages and the shared script');
  assert.equal((await (await fetch(base + '/api/health')).json()).ok, true);

  // ---- Only a registered device gets in ----
  const stranger = await fetch(base + '/api/staff');
  assert.equal(stranger.status, 403, 'an unregistered device is shown no staff');
  const refused = await api('/api/sign-in', { userId: 'x', pin: '2468' });
  assert.equal(refused.status, 403, 'an unregistered device cannot sign in');
  const made = admin('device-code', '--name', 'Shop laptop');
  const code = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(made)[1];
  const paired = await api('/api/pair', { code });
  assert.ok(paired.ok && paired.deviceToken, 'the one-time code registers a device');
  assert.equal((await api('/api/pair', { code })).ok, false, 'the code works only once');
  deviceToken = paired.deviceToken;
  ok('an unregistered device is turned away; a one-time code registers the first one');

  // ---- The owner builds the shop through the API alone ----
  const owner = await signIn('owner', '2468');
  const size = await dispatch(owner, 'catalogue/create_option_group', { name: 'Size', values: [{ label: 'Slice' }, { label: '8-inch' }] });
  const { productId } = await dispatch(owner, 'catalogue/create_product', { name: 'Carrot Cake', allergens: ['egg', 'nuts'] });
  await dispatch(owner, 'catalogue/set_product_options', { productId, valueIds: size.valueIds });
  const gen = await dispatch(owner, 'catalogue/generate_combinations', { productId });
  assert.equal(gen.created, 2);
  await dispatch(owner, 'catalogue/fill_price', { productId, valueId: size.valueIds[0], price: 5 });
  await dispatch(owner, 'catalogue/fill_price', { productId, valueId: size.valueIds[1], price: 40 });
  let grid = await feed(owner, 'catalogue_grid');
  const slice = grid[0].combinations.find((c) => c.label === 'Slice');
  await dispatch(owner, 'stock/set_count', { combinationId: slice.combinationId, count: 10 });
  ok('owner built a product with sizes, prices and stock (no seed data)');

  // ---- Staff ----
  const { userId: cashierId } = await dispatch(owner, 'staff/create', { name: 'Baraka', role: 'cashier', pin: '1357' });
  const cashier = await signIn('cashier', '1357');
  ok('owner added a cashier, who signed in');
  const denied = await api('/api/dispatch', { type: 'catalogue/set_price', payload: { combinationId: slice.combinationId, price: 1 } }, cashier);
  assert.equal(denied.status, 403);
  ok('the cashier cannot change prices (403)');

  // ---- A sale ----
  const { orderId } = await dispatch(cashier, 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup' });
  const { lineId } = await dispatch(cashier, 'orders/add_catalogue_line', { orderId, combinationId: slice.combinationId, qty: 3 });
  await dispatch(cashier, 'payments/record_payment', { orderId, method: 'cash', amount: 15 });
  await dispatch(cashier, 'orders/advance_line', { orderId, lineId, to: 'ready' });
  await dispatch(cashier, 'orders/advance_line', { orderId, lineId, to: 'completed' });
  grid = await feed(owner, 'catalogue_grid');
  assert.equal(grid[0].combinations.find((c) => c.label === 'Slice').onHand, 7);
  ok('sold 3 slices for cash: stock 10 down to 7');

  // ---- Retry safety ----
  const again = { type: 'orders/create_order', payload: { source: 'phone', fulfilment: 'pickup' }, requestId: 'same-request' };
  const a = await api('/api/dispatch', again, cashier);
  const b = await api('/api/dispatch', again, cashier);
  assert.equal(a.data.orderId, b.data.orderId);
  ok('a retried request with the same id did not create a second order');

  // ---- Backup while the server is running ----
  const out = admin('backup');
  assert.match(out, /Backup written/);
  const cloudFiles = fs.readdirSync(cloud);
  assert.equal(cloudFiles.length, 1);
  ok(`backup taken while running, verified, and copied to the cloud folder (${cloudFiles[0]})`);
  const orderCountAtBackup = (await feed(owner, 'order_list')).length;

  // ---- A hard crash, then recovery ----
  await dispatch(cashier, 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }); // after the backup
  await stop('SIGKILL');
  assert.ok(fs.existsSync(path.join(work, 'data', 'server.lock')), 'a crash leaves the lock behind');
  ok('server killed with no warning (like a power cut)');
  await start();
  ok('server restarted by itself on the stale lock');
  const list = await feed(owner, 'order_list');
  assert.equal(list.length, orderCountAtBackup + 1);
  ok('every order is still there, nothing half-saved, and the owner is still signed in');
  const check = admin('check');
  assert.match(check, /Integrity: ok/);
  ok('database integrity check: ok');

  // ---- Restore the backup ----
  await stop('SIGTERM');
  assert.ok(!fs.existsSync(path.join(work, 'data', 'server.lock')), 'a clean stop releases the lock');
  ok('clean stop released the lock');
  const backupFile = path.join(cloud, cloudFiles[0]);
  const restored = admin('restore', backupFile);
  assert.match(restored, /Restored/);
  assert.match(restored, /before-restore/);
  await start();
  const afterRestore = await feed(await signIn('owner', '2468'), 'order_list');
  assert.equal(afterRestore.length, orderCountAtBackup);
  ok(`restored the backup: back to ${orderCountAtBackup} orders (the one made after it is gone, and the replaced data was kept)`);
  assert.ok(fs.readdirSync(path.join(work, 'data')).some((f) => f.includes('before-restore')));

  // ---- A damaged backup is refused ----
  await stop('SIGTERM');
  const junk = path.join(work, 'cakepos-20200101-000000.sqlite');
  fs.writeFileSync(junk, 'not a database '.repeat(1000));
  assert.throws(() => admin('restore', junk), /not a healthy Cake POS backup/);
  ok('a damaged backup is refused and nothing is changed');

  console.log(`\nAll ${step} checks passed.\n`);
} catch (err) {
  console.error('\nFAILED:', err.message ?? err);
  process.exitCode = 1;
} finally {
  await stop('SIGKILL');
  fs.rmSync(work, { recursive: true, force: true });
}
