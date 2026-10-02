import fs from 'node:fs';
import path from 'node:path';

export class LockedError extends Error {}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const lockFile = (dataDir: string) => path.join(dataDir, 'server.lock');

/** The process id of a running server using this data folder, or null. */
export function serverRunning(dataDir: string): number | null {
  try {
    const { pid } = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8')) as { pid: number };
    return Number.isInteger(pid) && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Two servers on one database would fight over it. This makes the second one refuse to start. */
export function acquireLock(dataDir: string): () => void {
  const file = lockFile(dataDir);
  const other = serverRunning(dataDir);
  if (other) {
    throw new LockedError(
      `Another Cake POS server (process ${other}) is already using ${dataDir}. Stop it first. If you are sure it is not running, delete ${file} and try again.`,
    );
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return () => {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
      if (cur.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}
