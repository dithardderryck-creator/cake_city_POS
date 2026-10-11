import path from 'node:path';
import readline from 'node:readline';
import { createPanel, seedDemo, type Role } from '@cake-pos/panel';
import { createArchiveService } from './archive';
import { createBackupService, createDriveUploader, createFolderUploader, type BackupUploader } from './backup';
import { loadCloud } from './cloud';
import { DriveError, loadDriveCredentials, requestDeviceCode, saveDriveCredentials, waitForDeviceApproval } from './google-drive';
import { createStaff, listStaff, makePairingCode, resetPin, restoreBackup } from './admin';
import { loadConfig } from './config';
import { serverRunning } from './lock';
import { createLogger } from './log';
import { createScryptHasher } from './scrypt';
import { openSqliteStore } from './sqlite-store';

const USAGE = `Cake POS admin tool. Run it on the shop server.

  create-owner [--name "Amina"]        Create an owner (asks for a PIN)
  device-code [--name "Counter tablet"] Make a one-time code (10 minutes) that registers a device. Use it for the first one
  list-staff                           Show everyone and whether they are active
  reset-pin --name "Amina"             Set a new PIN for someone who forgot theirs
  backup                               Take a backup now (also uploads to the cloud folder if set)
  restore <backup-file>                Replace the live data with a backup (stop the server first)
  check                                Check the database is healthy
  google-auth                          Connect the shop's Google Drive (you approve it on your phone)
  drive-check                          Check the Google Drive connection and show which account it is
  archive-status                       How full the database is, and what has been archived
  archive [--dry-run] [--now] [--older-than-days N]
                                       Move old finished orders into a spreadsheet (Drive and this computer).
                                       Without --now it only does so if the database is "full". Stop the server first
  seed-demo --yes                      Fill an EMPTY database with demo staff and cakes (for trying it out only)

Settings come from the same environment variables as the server (DATA_DIR, BACKUP_DIR, CLOUD_BACKUP_DIR, ARCHIVE_DIR, ...).`;

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
      case 'device-code': {
        const name = flag(args, 'name') ?? (await ask('What should this device be called (for example "Counter tablet")? '));
        const r = await makePairingCode(store, { name });
        console.log(`Pairing code for "${r.name}":\n\n    ${r.code}\n\nOpen the shop address on that device and type it in. It works once, for 10 minutes.`);
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
        const cloud = loadCloud(config);
        const uploaders: BackupUploader[] = [];
        if (config.cloudBackupDir) uploaders.push(createFolderUploader(config.cloudBackupDir));
        if (cloud) uploaders.push(createDriveUploader(cloud.client, cloud.folderName, config.cloudBackupKeep));
        const svc = createBackupService({
          store,
          exclusive: (fn) => fn(),
          dir: config.backupDir,
          keep: config.backupKeep,
          uploaders,
          hour: config.backupHour,
          minute: config.backupMinute,
          log: createLogger({ level: 'warn' }),
        });
        const file = await svc.runNow();
        console.log(`Backup written: ${file}`);
        const st = await svc.status();
        if (uploaders.length) console.log(st.pendingUploads ? `Waiting to copy to ${uploaders.map((u) => u.name).join(' and ')} (will retry when the server is running).` : `Copied to ${uploaders.map((u) => u.name).join(' and ')}.`);
        break;
      }
      case 'google-auth': {
        const clientId = flag(args, 'client-id') ?? process.env.GOOGLE_CLIENT_ID ?? (await ask('Google client ID: '));
        const clientSecret = flag(args, 'client-secret') ?? process.env.GOOGLE_CLIENT_SECRET ?? (await ask('Google client secret: ', true));
        const folderName = flag(args, 'folder') ?? 'Cake POS';
        const code = await requestDeviceCode(clientId.trim());
        console.log(`\nOn your phone or any computer, open:\n\n    ${code.verificationUrl}\n\nand enter this code:\n\n    ${code.userCode}\n\nSign in with the Google account that should own the shop's files, and press Allow.`);
        console.log(`Waiting for you (the code works for ${Math.round(code.expiresInSeconds / 60)} minutes)...`);
        const refreshToken = await waitForDeviceApproval({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }, code);
        const creds = { clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken, folderName, connectedAt: new Date().toISOString() };
        saveDriveCredentials(config.driveFile, creds);
        const cloud = loadCloud(config)!;
        const { account } = await cloud.client.check();
        await cloud.client.ensureFolder([folderName, 'Backups']);
        await cloud.client.ensureFolder([folderName, 'Archive']);
        saveDriveCredentials(config.driveFile, { ...creds, account });
        console.log(`\nConnected${account ? ` as ${account}` : ''}. Backups and archives will go to the "${folderName}" folder in that Drive. Restart the server to start using it.`);
        break;
      }
      case 'drive-check': {
        const creds = loadDriveCredentials(config.driveFile);
        if (!creds) {
          console.log('Google Drive is not connected. Run: google-auth');
          break;
        }
        const cloud = loadCloud(config)!;
        try {
          const { account } = await cloud.client.check();
          console.log(`Google Drive works${account ? ` (account ${account})` : ''}. Folder: "${creds.folderName}".`);
        } catch (err) {
          console.log(`Google Drive does not work: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = err instanceof DriveError && err.retryable ? 0 : 1;
        }
        break;
      }
      case 'archive-status':
      case 'archive': {
        const cloud = loadCloud(config);
        const svc = createArchiveService({
          store,
          exclusive: (fn) => fn(),
          dir: config.archiveDir,
          statePath: path.join(config.dataDir, 'archive-state.json'),
          drive: cloud ? { client: cloud.client, folderName: cloud.folderName } : null,
          backupNow: async () => {
            const uploaders: BackupUploader[] = [];
            if (config.cloudBackupDir) uploaders.push(createFolderUploader(config.cloudBackupDir));
            if (cloud) uploaders.push(createDriveUploader(cloud.client, cloud.folderName, config.cloudBackupKeep));
            const b = createBackupService({ store, exclusive: (fn) => fn(), dir: config.backupDir, keep: config.backupKeep, uploaders, hour: config.backupHour, minute: config.backupMinute, log: createLogger({ level: 'warn' }) });
            await b.runNow();
          },
          usedBytes: () => store.usedBytes(),
          settings: { whenFullBytes: config.archive.whenFullMb * 1_048_576, minAgeDays: config.archive.minAgeDays, auditKeepDays: config.archive.activityDays },
          log: createLogger({ level: 'warn' }),
        });
        if (command === 'archive') {
          if (serverRunning(config.dataDir)) throw new Error('Stop the server first (or let it archive by itself when the database gets full).');
          const days = flag(args, 'older-than-days');
          const result = await svc.run({ force: args.includes('--now') || args.includes('--dry-run'), dryRun: args.includes('--dry-run'), minAgeDays: days ? Number(days) : undefined });
          console.log(result.reason);
          if (result.wouldArchive) console.log(`Would archive ${result.wouldArchive.orders} finished orders and ${result.wouldArchive.activity} old activity entries.`);
          for (const b of result.batches) console.log(`  ${b.count} ${b.kind === 'orders' ? 'orders' : 'activity entries'} -> ${b.localFile}${b.driveLink ? `\n     and ${b.driveLink}` : ''}`);
        }
        const st = svc.status();
        console.log(`Database: ${st.usedMb} MB of data (counts as full at ${st.whenFullMb} MB). Archived so far: ${st.totalOrdersArchived} orders. Google Drive: ${st.driveConnected ? 'connected' : 'not connected'}. Folder: ${st.folder}`);
        if (st.lastError) console.log(`Last problem: ${st.lastError}`);
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
