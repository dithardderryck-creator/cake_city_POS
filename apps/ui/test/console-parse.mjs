// The Console's reading of what is typed: no browser, no server. Names are matched, destructive commands ask for the name,
// nothing can carry a PIN, and what gets sealed is the Console's own wording, never the raw text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cakecons-')), 'console.mjs');
await build({ entryPoints: [path.join(here, '../src/console.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'error' });
const C = await import(pathToFileURL(out).href);

const d = {
  staff: [
    { id: 's1', name: 'Amina', role: 'owner', active: true },
    { id: 's2', name: 'Baraka', role: 'cashier', active: true },
    { id: 's3', name: 'Neema', role: 'baker', active: true },
    { id: 's4', name: 'Neema Joseph', role: 'baker', active: true },
  ],
  devices: [
    { id: 'd1', name: 'Counter tablet' },
    { id: 'd2', name: 'Kitchen phone' },
  ],
  sessions: [{ userId: 's2', name: 'Baraka' }],
  points: [
    { file: 'cakepos-20261102-020000.sqlite', madeAt: '2026-11-02T02:00:00.000Z' },
    { file: 'cakepos-20261101-020000.sqlite', madeAt: '2026-11-01T02:00:00.000Z' },
  ],
};

// tokens
assert.deepEqual(C.tokens('devices revoke "Counter tablet"'), ['devices', 'revoke', 'Counter tablet']);
assert.deepEqual(C.tokens("  maintenance on 'Back at 2 pm'  "), ['maintenance', 'on', 'Back at 2 pm']);
assert.equal(typeof C.tokens('devices revoke "Counter'), 'string');

// reads run straight away and are written in the Console's own words
let p = C.plan('LOGS errors --since 2h --part Sync', d);
assert.equal(p.kind, 'read');
assert.deepEqual(p.opts, { level: 'error', hours: 2, part: 'sync' });
assert.equal(p.line, 'logs errors --since 2h --part sync');
assert.equal(C.plan('logs --since 99h', d).kind, 'error');
assert.equal(C.plan('records refused', d).line, 'records refused');
assert.equal(C.plan('records nonsense', d).kind, 'error');

// a destructive command needs the name typed, and the name is matched forgivingly
p = C.plan('devices revoke counter', d);
assert.equal(p.kind, 'change');
assert.equal(p.intent, 'devices/revoke');
assert.deepEqual(p.payload, { deviceId: 'd1' });
assert.equal(p.typeName, 'Counter tablet');
assert.equal(p.line, 'devices revoke "Counter tablet"');

// an ambiguous or unknown name is refused with the choices
p = C.plan('staff off Neema', d);
assert.equal(p.kind, 'change', 'an exact name wins over a longer one that starts the same');
p = C.plan('staff off Nee', d);
assert.equal(p.kind, 'error');
assert.match(p.value, /Neema, Neema Joseph/);
assert.equal(C.plan('sessions kill Zed', d).kind, 'error');
assert.equal(C.plan('sessions kill Baraka', d).payload.userId, 's2');

// roles: owner cannot be made by the Console
assert.equal(C.plan('staff role Baraka baker', d).payload.role, 'baker');
assert.equal(C.plan('staff role Baraka owner', d).kind, 'error');

// maintenance, backups
assert.deepEqual(C.plan('maintenance on "Back at 2 pm"', d).payload, { on: true, message: 'Back at 2 pm' });
assert.deepEqual(C.plan('maintenance on', d).payload, { on: true });
assert.deepEqual(C.plan('maintenance off', d).payload, { on: false });
assert.equal(C.plan('maintenance', d).kind, 'read');
assert.deepEqual(C.plan('backup restore 2', d).payload, { file: 'cakepos-20261101-020000.sqlite' });
assert.equal(C.plan('backup restore 9', d).kind, 'error');
assert.equal(C.plan('backup restore', d).kind, 'error');
assert.equal(C.plan('backup now', d).kind, 'run');
assert.equal(C.plan('sync full', d).kind, 'change');
assert.equal(C.plan('records open 12', d).payload.seq, 12);
assert.equal(C.plan('records open x', d).kind, 'error');

// there is no way to type a PIN: such commands do not exist, and unknown text is never sealed
for (const bad of ['staff pin Baraka 1234', 'staff add Zed 1234', 'login 1234', 'rm -rf /', 'sql select * from staff']) {
  const r = C.plan(bad, d);
  assert.equal(r.kind, 'error', bad);
}

// help
assert.equal(C.plan('help', d).kind, 'help');
assert.ok(C.helpLines('devices').every((l) => /devices/.test(l.v)));
assert.ok(C.helpLines(null).length >= 25);

// suggestions
assert.ok(C.suggest('dev', d).includes('devices'));
assert.ok(C.suggest('devices re', d).some((s) => s.startsWith('devices rename') || s.startsWith('devices revoke')));
assert.deepEqual(C.suggest('devices revoke ', d), ['devices revoke "Counter tablet"', 'devices revoke "Kitchen phone"']);
assert.deepEqual(C.suggest('devices revoke kit', d), ['devices revoke "Kitchen phone"']);
assert.deepEqual(C.suggest('staff role Baraka ', d).slice(0, 2), ['staff role Baraka cashier', 'staff role Baraka baker']);
assert.deepEqual(C.suggest('backup restore ', d), ['backup restore 1', 'backup restore 2']);
assert.ok(C.suggest('', d).includes('devices'));

// running: a change shows its preview first and a cancelled one changes nothing and is not sealed
const calls = [];
const io = {
  read: async () => null,
  send: async (t, pl) => (calls.push(['send', t]), { ok: true, data: {} }),
  confirm: async (t) => (calls.push(['confirm', t]), null),
};
let r = await C.run(C.plan('devices revoke Counter', d), io);
assert.deepEqual(calls, [['confirm', 'devices/revoke']]);
assert.equal(r.ran, null);
assert.match(r.lines[0].t, /Cancelled/);
io.confirm = async (t) => (calls.push(['confirm', t]), { ok: true, data: {} });
r = await C.run(C.plan('devices revoke Counter', d), io);
assert.equal(r.ran, 'devices revoke "Counter tablet"');
r = await C.run(C.plan('wibble', d), io);
assert.equal(r.ran, null);
r = await C.run(C.plan('help', d), io);
assert.equal(r.ran, null);
console.log('console parse ok');
