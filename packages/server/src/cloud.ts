import { createDriveClient, loadDriveCredentials, type DriveClient, type DriveDeps } from './google-drive';
import type { ServerConfig } from './config';

export interface Cloud {
  client: DriveClient;
  folderName: string;
  account?: string;
}

/** The shop's Google Drive, if someone has run `google-auth`. Null means "not connected", which is a normal state. */
export function loadCloud(config: Pick<ServerConfig, 'driveFile'>, deps: DriveDeps = {}): Cloud | null {
  const creds = loadDriveCredentials(config.driveFile);
  if (!creds) return null;
  return { client: createDriveClient(creds, deps), folderName: creds.folderName, account: creds.account };
}
