import { createDriveAccounts, type DriveAccounts } from './drive-accounts';
import type { ServerConfig } from './config';
import type { DriveDeps } from './google-drive';
import type { Logger } from './log';

/**
 * The shop's Google accounts. "Not connected" (no accounts yet) is a normal state: backups simply stay on this
 * computer until someone signs an account in from the Owner or IT screen (or with `google-auth` in the admin tool).
 */
export function openDrive(
  config: Pick<ServerConfig, 'driveFile' | 'googleClient' | 'googleEndpoints'>,
  log: Logger,
  extra: { deps?: DriveDeps; onConnected?: (email: string | null) => void; sleep?: (ms: number) => Promise<void> } = {},
): DriveAccounts {
  return createDriveAccounts({
    file: config.driveFile,
    client: config.googleClient,
    deps: { ...(config.googleEndpoints ? { endpoints: config.googleEndpoints } : {}), ...extra.deps },
    log,
    ...(extra.onConnected ? { onConnected: extra.onConnected } : {}),
    ...(extra.sleep ? { sleep: extra.sleep } : {}),
  });
}
