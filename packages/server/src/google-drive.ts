import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Google Drive, using only the standard web interface (no Google library to install).
 *
 * The shop signs in once as itself (`google-auth` in the admin tool). Google then hands the server a long-lived
 * permission slip (a "refresh token") limited to the `drive.file` scope: the server can only see and change files it
 * created itself, never the rest of the Drive. The slip is kept in the data folder, readable by the server's user only.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveEndpoints {
  token: string;
  deviceCode: string;
  api: string;
  upload: string;
}
export const GOOGLE_ENDPOINTS: DriveEndpoints = {
  token: 'https://oauth2.googleapis.com/token',
  deviceCode: 'https://oauth2.googleapis.com/device/code',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The top folder everything goes in, created on first use. */
  folderName: string;
  connectedAt?: string;
  /** Who signed in, shown to the owner so they can tell which Google account is connected. */
  account?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
}

export class DriveError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the server could not be reached at all. */
    public status: number,
    /** True when trying again later could work (no internet, busy, rate limit). False when a person has to act. */
    public retryable: boolean,
  ) {
    super(message);
  }
}

export interface DriveDeps {
  fetch?: typeof fetch;
  endpoints?: DriveEndpoints;
  now?: () => number;
}

export type UploadSource = { bytes: Uint8Array } | { path: string };

export interface DriveClient {
  /** Finds or creates a folder path under My Drive. Returns the last folder's id. */
  ensureFolder(segments: string[]): Promise<string>;
  /**
   * Uploads a file. If a file with this name is already in the folder (a previous try got as far as Google), that one is
   * returned instead of making a copy. `convertTo` makes Google turn a .xlsx into a real Google Sheet.
   */
  upload(args: { name: string; parentId: string; source: UploadSource; mimeType: string; convertTo?: string }): Promise<DriveFile>;
  find(parentId: string, name: string): Promise<DriveFile | undefined>;
  list(parentId: string): Promise<DriveFile[]>;
  remove(fileId: string): Promise<void>;
  /** A cheap call that proves the permission slip still works. */
  check(): Promise<{ account?: string }>;
}

const escQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function googleMessage(body: unknown, fallback: string): string {
  const b = body as { error?: { message?: string } | string; error_description?: string } | null;
  if (b && typeof b === 'object') {
    if (typeof b.error_description === 'string') return b.error_description;
    if (typeof b.error === 'string') return b.error;
    if (b.error && typeof b.error === 'object' && typeof b.error.message === 'string') return b.error.message;
  }
  return fallback;
}

export function createDriveClient(creds: DriveCredentials, deps: DriveDeps = {}): DriveClient {
  const doFetch = deps.fetch ?? fetch;
  const ep = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const now = deps.now ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;
  const folderIds = new Map<string, string>();

  async function send(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
    } catch (err) {
      const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new DriveError(`Could not reach Google (${why}). It will be tried again when the internet is back.`, 0, true);
    }
  }

  async function accessToken(force = false): Promise<string> {
    if (!force && token && token.expiresAt - 60_000 > now()) return token.value;
    const res = await send(ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: 'refresh_token' }),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;
    if (!res.ok || !body?.access_token) {
      const revoked = body?.error === 'invalid_grant' || body?.error === 'invalid_client' || body?.error === 'unauthorized_client';
      throw new DriveError(
        revoked
          ? 'Google no longer accepts this shop\'s sign-in (it was removed, or the Google account password changed). Run "google-auth" in the admin tool again.'
          : `Google sign-in failed (${googleMessage(body, `status ${res.status}`)}).`,
        res.status,
        !revoked && (res.status >= 500 || res.status === 429),
      );
    }
    token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  /** One authorised request. A rejected token is refreshed once. `make` builds a fresh request each try (a file stream cannot be replayed). */
  async function call(make: (bearer: string) => { url: string; init: RequestInit & { timeoutMs?: number } }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const { url, init } = make(await accessToken(attempt > 0));
      const res = await send(url, init);
      if (res.status === 401 && attempt === 0) {
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      if (res.ok) return res;
      const body = await res.json().catch(() => null);
      const reason = (body as { error?: { errors?: { reason?: string }[] } } | null)?.error?.errors?.[0]?.reason;
      const full = reason === 'storageQuotaExceeded' || reason === 'quotaExceeded';
      const limited = res.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      throw new DriveError(
        full ? 'The Google Drive is full. Free some space or buy more storage.' : googleMessage(body, `Google Drive answered ${res.status}.`),
        res.status,
        limited || res.status >= 500,
      );
    }
  }

  const authed = (bearer: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${bearer}`, ...extra });
  const FILE_FIELDS = 'id,name,webViewLink,mimeType,size,createdTime';

  async function list(parentId: string, name?: string, folderOnly = false): Promise<DriveFile[]> {
    const q = [`'${escQ(parentId)}' in parents`, 'trashed = false', name !== undefined ? `name = '${escQ(name)}'` : '', folderOnly ? `mimeType = '${FOLDER_MIME}'` : '']
      .filter(Boolean)
      .join(' and ');
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '200', orderBy: 'createdTime' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await call((b) => ({ url: `${ep.api}/files?${params}`, init: { headers: authed(b) } }));
      const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  async function ensureFolder(segments: string[]): Promise<string> {
    let parent = 'root';
    const trail: string[] = [];
    for (const seg of segments) {
      trail.push(seg);
      const key = trail.join('/');
      const cached = folderIds.get(key);
      if (cached) {
        parent = cached;
        continue;
      }
      const existing = (await list(parent, seg, true))[0];
      let id = existing?.id;
      if (!id) {
        const res = await call((b) => ({
          url: `${ep.api}/files?fields=id`,
          init: { method: 'POST', headers: authed(b, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name: seg, mimeType: FOLDER_MIME, parents: [parent] }) },
        }));
        id = ((await res.json()) as { id: string }).id;
      }
      folderIds.set(key, id);
      parent = id;
    }
    return parent;
  }

  async function upload(args: { name: string; parentId: string; source: UploadSource; mimeType: string; convertTo?: string }): Promise<DriveFile> {
    const already = (await list(args.parentId, args.name))[0];
    if (already) return already;
    const size = 'bytes' in args.source ? args.source.bytes.byteLength : fs.statSync(args.source.path).size;
    const start = await call((b) => ({
      url: `${ep.upload}/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      init: {
        method: 'POST',
        headers: authed(b, { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': args.mimeType, 'X-Upload-Content-Length': String(size) }),
        body: JSON.stringify({ name: args.name, parents: [args.parentId], mimeType: args.convertTo ?? args.mimeType }),
      },
    }));
    const session = start.headers.get('location');
    await start.arrayBuffer().catch(() => undefined);
    if (!session) throw new DriveError('Google did not give an upload address.', start.status, true);
    const timeoutMs = 120_000 + Math.ceil(size / 50_000) * 1000; // at least 50 KB/s
    const done = await call((b) => ({
      url: session,
      init: {
        method: 'PUT',
        headers: authed(b, { 'Content-Type': args.mimeType, 'Content-Length': String(size) }),
        body: ('bytes' in args.source ? (args.source.bytes as unknown as BodyInit) : (Readable.toWeb(fs.createReadStream(args.source.path)) as unknown as BodyInit)),
        // Node's fetch needs this to send a stream
        duplex: 'half',
        timeoutMs,
      },
    }));
    return (await done.json()) as DriveFile;
  }

  return {
    ensureFolder,
    upload: async (args) => {
      try {
        return await upload(args);
      } catch (err) {
        // The folder was deleted in Drive since we last saw it: forget it, and the caller's next try makes it again.
        if (err instanceof DriveError && err.status === 404) folderIds.clear();
        throw err;
      }
    },
    find: async (parentId, name) => (await list(parentId, name))[0],
    list: (parentId) => list(parentId),
    async remove(fileId) {
      try {
        await call((b) => ({ url: `${ep.api}/files/${encodeURIComponent(fileId)}`, init: { method: 'DELETE', headers: authed(b) } }));
      } catch (err) {
        if (err instanceof DriveError && err.status === 404) return; // already gone
        throw err;
      }
    },
    async check() {
      const res = await call((b) => ({ url: `${ep.api}/about?fields=user(emailAddress)`, init: { headers: authed(b) } }));
      const data = (await res.json()) as { user?: { emailAddress?: string } };
      return { account: data.user?.emailAddress };
    },
  };
}

/* ---------- Saved sign-in ---------- */

export function loadDriveCredentials(file: string): DriveCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let data: Partial<DriveCredentials>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is damaged. Run "google-auth" in the admin tool to sign in again.`);
  }
  if (!data.clientId || !data.clientSecret || !data.refreshToken) throw new Error(`${file} is incomplete. Run "google-auth" in the admin tool to sign in again.`);
  return { clientId: data.clientId, clientSecret: data.clientSecret, refreshToken: data.refreshToken, folderName: data.folderName || 'Cake POS', connectedAt: data.connectedAt, account: data.account };
}

export function saveDriveCredentials(file: string, creds: DriveCredentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/* ---------- One-time sign-in (the "enter this code on your phone" flow) ---------- */

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export async function requestDeviceCode(clientId: string, deps: DriveDeps = {}): Promise<DeviceCode> {
  const doFetch = deps.fetch ?? fetch;
  const ep = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const res = await doFetch(ep.deviceCode, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, scope: DRIVE_SCOPE }) });
  const b = (await res.json().catch(() => null)) as { device_code?: string; user_code?: string; verification_url?: string; expires_in?: number; interval?: number } | null;
  if (!res.ok || !b?.device_code || !b.user_code || !b.verification_url) throw new DriveError(`Google refused the sign-in request (${googleMessage(b, `status ${res.status}`)}). Check the client ID.`, res.status, false);
  return { deviceCode: b.device_code, userCode: b.user_code, verificationUrl: b.verification_url, expiresInSeconds: b.expires_in ?? 1800, intervalSeconds: b.interval ?? 5 };
}

/** Waits until the person has approved on their phone or computer. Returns the long-lived refresh token. */
export async function waitForDeviceApproval(
  creds: { clientId: string; clientSecret: string },
  code: DeviceCode,
  deps: DriveDeps & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const ep = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + code.expiresInSeconds * 1000;
  let wait = code.intervalSeconds * 1000;
  while (now() < deadline) {
    await sleep(wait);
    const res = await doFetch(ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, device_code: code.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const b = (await res.json().catch(() => null)) as { refresh_token?: string; error?: string } | null;
    if (res.ok && b?.refresh_token) return b.refresh_token;
    if (b?.error === 'authorization_pending') continue;
    if (b?.error === 'slow_down') {
      wait += 5000;
      continue;
    }
    if (b?.error === 'access_denied') throw new DriveError('The sign-in was declined on the Google page. Nothing was connected.', res.status, false);
    if (b?.error === 'expired_token') break;
    throw new DriveError(`Google sign-in failed (${googleMessage(b, `status ${res.status}`)}).`, res.status, false);
  }
  throw new DriveError('The code expired before it was approved. Run "google-auth" again.', 0, false);
}
