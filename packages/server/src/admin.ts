import fs from 'node:fs';
import path from 'node:path';
import { createIds, type AuditEntry, type PinHasher, type Role, type Staff, type Store } from '@cake-pos/panel';
import { stamp, verifyBackupFile } from './backup';
import { serverRunning } from './lock';

const ids = createIds();
const PIN = /^\d{4,6}$/;

async function audit(store: Store, summary: string, intent: string, target?: string) {
  await store.put<AuditEntry>('audit', {
    id: ids.next('aud'),
    at: new Date().toISOString(),
    actorName: 'Admin tool on the server',
    intent,
    target,
    summary,
    outcome: 'ok',
  });
}

export async function listStaff(store: Store) {
  return (await store.list<Staff>('staff')).filter((s) => !s.removedAt).sort((a, b) => a.name.localeCompare(b.name));
}

/** Make a new active staff member. Used to create the first owner, or a new one if every owner is locked out. */
export async function createStaff(store: Store, hasher: PinHasher, o: { name: string; pin: string; role: Role }): Promise<Staff> {
  const name = o.name.trim();
  if (!name) throw new Error('Enter a name.');
  if (!PIN.test(o.pin)) throw new Error('The PIN must be 4 to 6 digits.');
  const all = await listStaff(store);
  if (all.some((s) => s.active && s.name.toLowerCase() === name.toLowerCase())) throw new Error(`Someone called "${name}" already works here.`);
  const id = ids.next('stf');
  const staff: Staff = { id, name, role: o.role, pinHash: await hasher.hash(id, o.pin), active: true };
  await store.put('staff', staff);
  await audit(store, `Added ${name} as ${o.role}`, 'admin/create_staff', id);
  return staff;
}

/** For a forgotten PIN when nobody else can reset it. Also unlocks the account and signs it out everywhere. */
export async function resetPin(store: Store, hasher: PinHasher, o: { name: string; pin: string }): Promise<Staff> {
  if (!PIN.test(o.pin)) throw new Error('The PIN must be 4 to 6 digits.');
  const matches = (await listStaff(store)).filter((s) => s.name.toLowerCase() === o.name.trim().toLowerCase());
  if (matches.length === 0) throw new Error(`Nobody is called "${o.name}". Run list-staff to see names.`);
  const staff = matches.find((s) => s.active) ?? matches[0]!;
  await store.transaction(async () => {
    await store.put('staff', { ...staff, pinHash: await hasher.hash(staff.id, o.pin) });
    await store.put('loginState', { id: staff.id, failures: 0, lockCount: 0 });
    for (const s of await store.find<{ id: string }>('sessions', { where: { userId: staff.id } })) await store.delete('sessions', s.id);
    await audit(store, `PIN reset for ${staff.name}`, 'admin/reset_pin', staff.id);
  });
  return staff;
}

export interface RestoreResult {
  previous: string | null;
  staff: number;
}

/**
 * Put a backup in place of the live database. The current database is kept next to it, never deleted,
 * so a restore can itself be undone. The server must be stopped first.
 */
export function restoreBackup(o: { file: string; dbFile: string; dataDir: string }): RestoreResult {
  const running = serverRunning(o.dataDir);
  if (running) throw new Error(`The server is still running (process ${running}). Stop it, then restore.`);
  if (!fs.existsSync(o.file)) throw new Error(`No such file: ${o.file}`);

  // Check a copy, so the original backup is never altered by checking it.
  const work = `${o.dbFile}.restoring`;
  fs.mkdirSync(path.dirname(o.dbFile), { recursive: true });
  fs.copyFileSync(o.file, work);
  const check = verifyBackupFile(work);
  if (!check.ok) {
    fs.rmSync(work, { force: true });
    throw new Error(`That file is not a healthy Cake POS backup, so nothing was changed. (${check.detail})`);
  }

  let previous: string | null = null;
  if (fs.existsSync(o.dbFile)) {
    previous = `${o.dbFile}.before-restore-${stamp(new Date())}`;
    fs.renameSync(o.dbFile, previous);
  }
  for (const ext of ['-wal', '-shm']) fs.rmSync(`${o.dbFile}${ext}`, { force: true });
  fs.renameSync(work, o.dbFile);
  return { previous, staff: check.staff };
}
