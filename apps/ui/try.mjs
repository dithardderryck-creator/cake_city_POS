// Starts the shop with demo staff and the new screens, for trying them out by hand.
// Run from the project folder:  npm run ui:try      (add  -- --fresh  to start from clean demo data)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverJs = path.join(root, 'packages/server/dist/cake-pos-server.mjs');
const adminJs = path.join(root, 'packages/server/dist/cake-pos-admin.mjs');
const data = path.join(root, '.try-data');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

if (!fs.existsSync(serverJs)) run('npm', ['run', 'build', '-w', '@cake-pos/server']);
run('node', ['apps/ui/build.mjs']);
if (process.argv.includes('--fresh')) fs.rmSync(data, { recursive: true, force: true });
const env = { ...process.env, DATA_DIR: data, PORT: process.env.PORT || '8787', HOST: '0.0.0.0', STATIC_DIR: path.join(root, 'apps/ui/dist') };
if (!fs.existsSync(data)) execFileSync(process.execPath, [adminJs, 'seed-demo', '--yes'], { env, stdio: 'inherit' });

const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
console.log(`\nOpen http://localhost:${env.PORT}/${lan ? `   (on a phone on the same wifi: http://${lan}:${env.PORT}/)` : ''}`);
console.log('Demo PINs: owner 1111, cashier 2222, baker 3333, inventory 4444. Press Ctrl+C to stop.\n');
spawn(process.execPath, [serverJs], { env, stdio: 'inherit' });
