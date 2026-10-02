import path from 'node:path';
import readline from 'node:readline';
import { createPanel, seedDemo, type Role } from '@cake-pos/panel';
import { createBackupService, createFolderUploader } from './backup';
import { createStaff, listStaff, resetPin, restoreBackup } from './admin';
import { loadConfig } from './config';
import { serverRunning } from './lock';
import { createLogger } from './log';
import { createScryptHasher } from './scrypt';
import { openSqliteStore } from './sqlite-store';

const USAGE = `Cake POS admin tool. Run it on the shop server.

  create-owner [--name "Amina"]        Create an owner (asks for a PIN)
  list-staff                           Show everyone and whether they are active
  reset-pin --name "Amina"             Set a new PIN for someone who forgot theirs
  backup                               Take a backup now (also uploads to the cloud folder if set)
  restore <backup-file>                Replace the live data with a backup (stop the server first)
  check                                Check the database is healthy
  seed-demo --yes                      Fill an EMPTY database with demo staff and cakes (for trying it out only)

Settings come from the same environment variables as the server (DATA_DIR, BACKUP_DIR, CLOUD_BACKUP_DIR).`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      // Show the question but not what is typed.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
        if (s.startsWith(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askPin(): Promise<string> {
  const a = await ask('New PIN (4 to 6 digits): ', true);
  const b = await ask('Type it again: ', true);
  if (a !== b) throw new Error('The two PINs were different. Nothing was changed.');
  return a;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return console.log(USAGE);
  const config = loadConfig();
  const hasher = createScryptHasher();

  if (command === 'restore') {
    const file = args[0];
    if (!file) throw new Error('Say which backup to restore: restore <backup-file>');
    const r = restoreBackup({ file: path.resolve(file), dbFile: config.dbFile, dataDir: config.dataDir });
    console.log(`Restored. ${r.staff} staff accounts in the backup.`);
    if (r.previous) console.log(`The data that was here before is kept at:\n  ${r.previous}`);
    return;
  }

  const store = openSqliteStore(config.dbFile);
  try {
    switch (command) {
      case 'create-owner': {
        const name = flag(args, 'name') ?? (await ask('Owner name: '));
        const pin = flag(args, 'pin') ?? (await askPin());
        const s = await createStaff(store, hasher, { name, pin, role: 'owner' as Role });
        console.log(`Created owner "${s.name}". They can sign in with that PIN.`);
        break;
      }
      case 'list-staff': {
        const all = await listStaff(store);
        if (all.length === 0) console.log('Nobody yet. Run: create-owner');
        for (const s of all) console.log(`${s.active ? 'active  ' : 'inactive'}  ${s.role.padEnd(9)} ${s.name}`);
        break;
      }
      case 'reset-pin': {
        const name = flag(args, 'name') ?? (await ask('Whose PIN? '));
        const pin = flag(args, 'pin') ?? (await askPin());
        const s = await resetPin(store, hasher, { name, pin });
        console.log(`PIN reset for "${s.name}". They are unlocked and signed out everywhere.`);
        break;
      }
      case 'backup': {
        const svc = createBackupService({
          store,
          exclusive: (fn) => fn(),
          dir: config.backupDir,
          keep: config.backupKeep,
          uploaders: config.cloudBackupDir ? [createFolderUploader(config.cloudBackupDir)] : [],
          hour: config.backupHour,
          minute: config.backupMinute,
          log: createLogger({ level: 'warn' }),
        });
        const file = await svc.runNow();
        console.log(`Backup written: ${file}`);
        const st = await svc.status();
        if (config.cloudBackupDir) console.log(st.pendingUploads ? `Waiting to copy to ${config.cloudBackupDir}.` : `Copied to ${config.cloudBackupDir}.`);
        break;
      }
      case 'check': {
        const result = store.integrityCheck();
        console.log(`Integrity: ${result}`);
        console.log(`Staff: ${(await store.list('staff')).length}, orders: ${(await store.list('orders')).length}, payments: ${(await store.list('payments')).length}`);
        const pid = serverRunning(config.dataDir);
        console.log(pid ? `Server is running (process ${pid}).` : 'Server is not running.');
        if (result !== 'ok') process.exitCode = 1;
        break;
      }
      case 'seed-demo': {
        if (!args.includes('--yes')) throw new Error('This adds demo staff with well-known PINs. Add --yes if you really want that.');
        if ((await store.list('staff')).length > 0) throw new Error('The database already has staff, so nothing was added.');
        const panel = createPanel({ store, hasher });
        await seedDemo(store, panel, hasher);
        console.log('Demo staff and cakes added. Owner PIN is 1111. Do not use this on a real shop.');
        break;
      }
      default:
        throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
