import fs from 'node:fs';
import path from 'node:path';
import type { DriveAccountState, DriveAccountView, DriveConnectView, DriveResult, DriveStatus, DriveTerminal } from '@cake-pos/panel';
import {
  createDriveClient,
  DriveError,
  requestDeviceCode,
  waitForDeviceApproval,
  type DriveCheck,
  type DriveClient,
  type DriveDeps,
  type DriveFile,
  type UploadSource,
} from './google-drive';
import { errorFields, type Logger } from './log';

/**
 * The shop's Google accounts.
 *
 * Any number of accounts can be signed in. They are used in order: backups and archives go to the first one that has
 * room, and when it is full (or no longer accepts the sign-in) the next one takes over by itself. The accounts, and the
 * secrets that let the server act for them, live in one file in the data folder (readable by the server's user only).
 * They are never written to the database, because the database is what gets copied to Drive.
 *
 * The pool looks like ONE Drive to the rest of the server (`client`): folders are named by their path, and file ids
 * carry the account they live in.
 */

/** Less room than this counts as full (a backup is a few megabytes; this leaves space to grow). */
const MIN_FREE_BYTES = 20 * 1_048_576;
const FOLDER_PREFIX = 'v:';
const DEFAULT_FOLDER = 'Cake POS';

interface AccountRecord {
  id: string;
  refreshToken: string;
  account?: string;
  connectedAt: string;
  paused?: boolean;
}

interface DriveFileData {
  clientId?: string;
  clientSecret?: string;
  folderName: string;
  accounts: AccountRecord[];
}

interface RuntimeState {
  state: DriveAccountState;
  usedBytes: number | null;
  limitBytes: number | null;
  checkedAt: string | null;
  lastOkAt: string | null;
  problem: string | null;
}

export interface DriveAccountsOptions {
  file: string;
  /** Client ID and secret from the environment. When set they win over what was saved from the screen. */
  client?: { clientId: string; clientSecret: string } | null;
  deps?: DriveDeps;
  log: Logger;
  now?: () => number;
  /** Tests make waiting instant. */
  sleep?: (ms: number) => Promise<void>;
  /** A new account has just been connected: the server takes a backup so the new account gets a copy at once. */
  onConnected?: (email: string | null) => void;
}

export interface DriveAccounts {
  /** One Drive made of every account that is switched on. Throws a plain error when there is none. */
  client: DriveClient;
  folderName(): string;
  /** At least one account is connected and not paused. */
  active(): boolean;
  hasAccounts(): boolean;
  terminal: DriveTerminal;
  /** Looks at every account now: who it is, how much room it has, whether the sign-in still works. */
  refresh(): Promise<void>;
  /** Resolves when the sign-in that was started has ended (used by the admin tool). */
  waitForConnect(): Promise<DriveConnectView | null>;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function readFile(file: string): { data: DriveFileData; problem: string | null } {
  const empty: DriveFileData = { folderName: DEFAULT_FOLDER, accounts: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: empty, problem: null };
    return { data: empty, problem: `The saved Google sign-ins could not be read (${message(err)}).` };
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { data: empty, problem: 'The saved Google sign-in file is damaged. Connect the accounts again from this screen.' };
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const folderName = str(j.folderName) ?? DEFAULT_FOLDER;
  if (Array.isArray(j.accounts)) {
    const accounts = (j.accounts as Array<Record<string, unknown>>)
      .filter((a) => str(a.id) && str(a.refreshToken))
      .map((a) => ({ id: str(a.id)!, refreshToken: str(a.refreshToken)!, account: str(a.account), connectedAt: str(a.connectedAt) ?? new Date(0).toISOString(), ...(a.paused === true ? { paused: true } : {}) }));
    return { data: { clientId: str(j.clientId), clientSecret: str(j.clientSecret), folderName, accounts }, problem: null };
  }
  // The first version of the file held a single account.
  if (str(j.refreshToken)) {
    return {
      data: { clientId: str(j.clientId), clientSecret: str(j.clientSecret), folderName, accounts: [{ id: 'a1', refreshToken: str(j.refreshToken)!, account: str(j.account), connectedAt: str(j.connectedAt) ?? new Date(0).toISOString() }] },
      problem: null,
    };
  }
  return { data: { ...empty, clientId: str(j.clientId), clientSecret: str(j.clientSecret), folderName }, problem: null };
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function writeFile(file: string, data: DriveFileData): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const encodeFolder = (segments: string[]) => FOLDER_PREFIX + Buffer.from(JSON.stringify(segments)).toString('base64url');
function decodeFolder(id: string): string[] {
  if (!id.startsWith(FOLDER_PREFIX)) throw new DriveError('That folder is not one of the shop\'s Drive folders.', 0, false);
  return JSON.parse(Buffer.from(id.slice(FOLDER_PREFIX.length), 'base64url').toString()) as string[];
}

export function createDriveAccounts(o: DriveAccountsOptions): DriveAccounts {
  const now = o.now ?? Date.now;
  const realSleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const loaded = readFile(o.file);
  const data = loaded.data;
  let fileProblem = loaded.problem;
  if (fileProblem) o.log.error('Google sign-ins could not be read', { problem: fileProblem });
  let seenMtime = mtimeOf(o.file);
  const states = new Map<string, RuntimeState>();
  const clients = new Map<string, DriveClient>();
  let connect: { view: DriveConnectView; cancelled: boolean; done: Promise<void> } | null = null;

  const save = () => {
    writeFile(o.file, data);
    seenMtime = mtimeOf(o.file);
  };
  /** The admin tool can change the file while the server runs, so look again before acting. */
  const fresh = () => {
    const m = mtimeOf(o.file);
    if (m === seenMtime) return;
    seenMtime = m;
    const again = readFile(o.file);
    fileProblem = again.problem;
    if (again.problem) return; // keep what we have rather than drop every account because of a half-written file
    Object.assign(data, { clientId: again.data.clientId, clientSecret: again.data.clientSecret, folderName: again.data.folderName, accounts: again.data.accounts });
    clients.clear();
  };
  const creds = (): { clientId: string; clientSecret: string } | null => {
    if (o.client) return o.client;
    return data.clientId && data.clientSecret ? { clientId: data.clientId, clientSecret: data.clientSecret } : null;
  };
  const iso = () => new Date(now()).toISOString();
  const stateOf = (id: string): RuntimeState => {
    let s = states.get(id);
    if (!s) states.set(id, (s = { state: 'unknown', usedBytes: null, limitBytes: null, checkedAt: null, lastOkAt: null, problem: null }));
    return s;
  };
  const accountOf = (id: string) => data.accounts.find((a) => a.id === id);
  const clientOf = (a: AccountRecord): DriveClient => {
    let c = clients.get(a.id);
    if (!c) {
      const k = creds();
      if (!k) throw new DriveError('The Google client ID and secret are missing, so the saved accounts cannot be used.', 0, false, 'auth');
      c = createDriveClient({ ...k, refreshToken: a.refreshToken, folderName: data.folderName }, o.deps);
      clients.set(a.id, c);
    }
    return c;
  };
  const eligible = () => {
    fresh();
    return data.accounts.filter((a) => !a.paused);
  };

  /** Writes what a check or an upload taught us about one account. */
  function learn(a: AccountRecord, chk: DriveCheck | null, outcome: { state: DriveAccountState; problem?: string | null }) {
    const s = stateOf(a.id);
    s.state = outcome.state;
    s.problem = outcome.problem ?? null;
    s.checkedAt = iso();
    if (chk) {
      s.usedBytes = chk.usageBytes ?? s.usedBytes;
      s.limitBytes = chk.limitBytes ?? null;
      if (chk.account && chk.account !== a.account) {
        a.account = chk.account;
        save();
      }
    }
    if (outcome.state === 'ok') s.lastOkAt = iso();
  }

  const freeBytes = (c: DriveCheck) => (c.limitBytes === undefined ? Infinity : c.limitBytes - (c.usageBytes ?? 0));
  const fullProblem = (c: DriveCheck) => `Only ${Math.max(0, Math.round(freeBytes(c) / 1_048_576))} MB is left in this Google account. Free some space, or the next account is used.`;

  /** Runs one call against one account and turns the ways it can fail into what the pool should do next. */
  async function guarded<T>(a: AccountRecord, fn: (c: DriveClient) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: DriveError }> {
    try {
      return { ok: true, value: await fn(clientOf(a)) };
    } catch (err) {
      if (!(err instanceof DriveError)) throw err;
      if (err.kind === 'auth') learn(a, null, { state: 'needs_signin', problem: err.message });
      else if (err.kind === 'full') learn(a, null, { state: 'full', problem: err.message });
      else if (err.kind === 'network') learn(a, null, { state: 'unreachable', problem: err.message });
      else learn(a, null, { state: 'error', problem: err.message });
      return { ok: false, error: err };
    }
  }

  const prefixed = (a: AccountRecord, f: DriveFile): DriveFile => ({ ...f, id: `${a.id}~${f.id}` });
  function route(fileId: string): { a: AccountRecord; raw: string } | null {
    const i = fileId.indexOf('~');
    if (i < 0) {
      const first = data.accounts[0];
      return first ? { a: first, raw: fileId } : null;
    }
    const a = accountOf(fileId.slice(0, i));
    return a ? { a, raw: fileId.slice(i + 1) } : null;
  }

  const noAccount = () => new DriveError('No Google account is connected, or all of them are paused.', 0, false, 'other');

  const pool: DriveClient = {
    async ensureFolder(segments) {
      return encodeFolder(segments);
    },

    async find(parentId, name) {
      const segments = decodeFolder(parentId);
      for (const a of eligible()) {
        const r = await guarded(a, async (c) => c.find(await c.ensureFolder(segments), name));
        if (!r.ok) {
          if (r.error.kind === 'network') throw r.error;
          continue;
        }
        if (r.value) return prefixed(a, r.value);
      }
      return undefined;
    },

    async list(parentId) {
      const segments = decodeFolder(parentId);
      const out: DriveFile[] = [];
      for (const a of eligible()) {
        const r = await guarded(a, async (c) => c.list(await c.ensureFolder(segments)));
        if (!r.ok) {
          if (r.error.kind === 'network') throw r.error;
          continue;
        }
        out.push(...r.value.map((f) => prefixed(a, f)));
      }
      return out;
    },

    async upload(args: { name: string; parentId: string; source: UploadSource; mimeType: string; convertTo?: string }) {
      const segments = decodeFolder(args.parentId);
      const accounts = eligible();
      if (accounts.length === 0) throw noAccount();
      const size = 'bytes' in args.source ? args.source.bytes.byteLength : fs.statSync(args.source.path).size;
      // A previous try may have got as far as Google, in this account or another one: never make a second copy.
      const existing = await pool.find(args.parentId, args.name);
      if (existing) return existing;
      let sawFull = 0;
      let last: DriveError | null = null;
      for (const a of accounts) {
        const r = await guarded(a, async (c) => {
          const chk = await c.check();
          if (freeBytes(chk) < size + MIN_FREE_BYTES) {
            learn(a, chk, { state: 'full', problem: fullProblem(chk) });
            return null;
          }
          const folder = await c.ensureFolder(segments);
          const f = await c.upload({ ...args, parentId: folder });
          learn(a, chk, { state: 'ok' });
          return f;
        });
        if (r.ok && r.value) return prefixed(a, r.value);
        if (r.ok) {
          sawFull++;
          continue;
        }
        if (r.error.kind === 'network') throw r.error; // every account shares the same internet
        if (r.error.kind === 'full') sawFull++;
        last = r.error;
      }
      if (sawFull === accounts.length) {
        throw new DriveError(accounts.length === 1 ? 'The Google account is full. Free some space, or connect another account.' : `All ${accounts.length} connected Google accounts are full. Free some space, or connect another account.`, 403, false, 'full');
      }
      throw last ?? noAccount();
    },

    async remove(fileId) {
      fresh();
      const hit = route(fileId);
      if (!hit) return; // the account was disconnected; nothing more can be done for its files
      const r = await guarded(hit.a, (c) => c.remove(hit.raw));
      if (!r.ok) throw r.error;
    },

    async check() {
      const a = eligible()[0];
      if (!a) throw noAccount();
      return clientOf(a).check();
    },
  };

  async function checkAccount(a: AccountRecord): Promise<void> {
    if (a.paused) {
      stateOf(a.id).state = 'paused';
      return;
    }
    try {
      const chk = await clientOf(a).check();
      if (freeBytes(chk) < MIN_FREE_BYTES) learn(a, chk, { state: 'full', problem: fullProblem(chk) });
      else learn(a, chk, { state: 'ok' });
    } catch (err) {
      if (!(err instanceof DriveError)) {
        learn(a, null, { state: 'error', problem: message(err) });
        return;
      }
      learn(a, null, { state: err.kind === 'auth' ? 'needs_signin' : err.kind === 'network' ? 'unreachable' : err.kind === 'full' ? 'full' : 'error', problem: err.message });
    }
  }

  async function refresh() {
    fresh();
    for (const a of data.accounts) await checkAccount(a);
  }

  /* ---------- Signing in a new account ---------- */

  async function finishConnect(refreshToken: string, view: DriveConnectView): Promise<void> {
    const k = creds()!;
    const probe = createDriveClient({ ...k, refreshToken, folderName: data.folderName }, o.deps);
    const chk = await probe.check();
    await probe.ensureFolder([data.folderName, 'Backups']);
    await probe.ensureFolder([data.folderName, 'Archive']);
    const email = chk.account ?? null;
    const same = email ? data.accounts.find((a) => a.account === email) : undefined;
    let rec: AccountRecord;
    if (same) {
      same.refreshToken = refreshToken;
      delete same.paused;
      clients.delete(same.id);
      rec = same;
      view.message = `${email} was already connected. Its sign-in was renewed.`;
    } else {
      const n = data.accounts.reduce((m, a) => Math.max(m, Number(/^a(\d+)$/.exec(a.id)?.[1] ?? 0)), 0) + 1;
      rec = { id: `a${n}`, refreshToken, ...(email ? { account: email } : {}), connectedAt: iso() };
      data.accounts.push(rec);
      view.message = email ? `${email} is connected.` : 'The account is connected.';
    }
    save();
    learn(rec, chk, { state: freeBytes(chk) < MIN_FREE_BYTES ? 'full' : 'ok', problem: freeBytes(chk) < MIN_FREE_BYTES ? fullProblem(chk) : null });
    if (email) view.email = email;
    view.state = 'done';
    delete view.userCode;
    delete view.url;
    delete view.expiresAt;
    o.log.info('Google account connected', { account: email });
    o.onConnected?.(email);
  }

  const terminal: DriveTerminal = {
    async status(): Promise<DriveStatus> {
      fresh();
      const k = creds();
      return {
        clientReady: !!k,
        clientFrom: o.client ? 'environment' : k ? 'saved' : null,
        folderName: data.folderName,
        accounts: data.accounts.map((a, i): DriveAccountView => {
          const s = stateOf(a.id);
          return {
            id: a.id,
            email: a.account ?? null,
            connectedAt: a.connectedAt,
            state: a.paused ? 'paused' : s.state,
            usedBytes: s.usedBytes,
            limitBytes: s.limitBytes,
            checkedAt: s.checkedAt,
            lastOkAt: s.lastOkAt,
            problem: a.paused ? null : s.problem,
            position: i + 1,
          };
        }),
        connect: connect ? { ...connect.view } : null,
        problem: fileProblem,
      };
    },

    async saveClient(clientId, clientSecret) {
      fresh();
      if (o.client) return fail('The Google client ID and secret are set in the server settings, so they cannot be changed here.');
      const id = clientId.trim();
      const secret = clientSecret.trim();
      if (id.length < 10 || /\s/.test(id)) return fail('That does not look like a Google client ID. Copy it again from the Google Cloud Console.');
      if (secret.length < 8 || /\s/.test(secret)) return fail('That does not look like a Google client secret. Copy it again from the Google Cloud Console.');
      if (data.accounts.length > 0 && data.clientId !== id) return fail('Disconnect every Google account first: their sign-ins belong to the old client ID.');
      data.clientId = id;
      data.clientSecret = secret;
      save();
      return { ok: true };
    },

    async startConnect() {
      fresh();
      if (connect?.view.state === 'waiting') return fail('A sign-in is already waiting for a code. Finish it, or cancel it first.');
      const k = creds();
      if (!k) return fail('Save the Google client ID and secret first.');
      let code;
      try {
        code = await requestDeviceCode(k.clientId, o.deps);
      } catch (err) {
        return fail(message(err));
      }
      const expiresAt = new Date(now() + code.expiresInSeconds * 1000).toISOString();
      const view: DriveConnectView = { state: 'waiting', userCode: code.userCode, url: code.verificationUrl, expiresAt, at: iso() };
      const mine = { view, cancelled: false, done: Promise.resolve() };
      mine.done = (async () => {
        try {
          const refresh = await waitForDeviceApproval(k, code, {
            ...o.deps,
            sleep: async (ms) => {
              if (mine.cancelled) throw new DriveError('The sign-in was cancelled.', 0, false);
              await realSleep(ms);
              if (mine.cancelled) throw new DriveError('The sign-in was cancelled.', 0, false);
            },
          });
          await finishConnect(refresh, view);
        } catch (err) {
          view.state = 'failed';
          view.message = mine.cancelled ? 'The sign-in was cancelled.' : message(err);
          delete view.userCode;
          delete view.url;
          delete view.expiresAt;
          if (!mine.cancelled) o.log.warn('Connecting a Google account failed', errorFields(err));
        }
      })();
      connect = mine;
      return { ok: true, userCode: code.userCode, url: code.verificationUrl, expiresAt };
    },

    async cancelConnect() {
      if (!connect || connect.view.state !== 'waiting') return { ok: true };
      connect.cancelled = true;
      await connect.done;
      return { ok: true };
    },

    async remove(accountId) {
      fresh();
      const a = accountOf(accountId);
      if (!a) return fail('That Google account is not connected.');
      data.accounts = data.accounts.filter((x) => x.id !== accountId);
      clients.delete(accountId);
      states.delete(accountId);
      save();
      return { ok: true, email: a.account ?? null };
    },

    async move(accountId, direction) {
      fresh();
      const i = data.accounts.findIndex((a) => a.id === accountId);
      if (i < 0) return fail('That Google account is not connected.');
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= data.accounts.length) return { ok: true };
      [data.accounts[i], data.accounts[j]] = [data.accounts[j]!, data.accounts[i]!];
      save();
      return { ok: true };
    },

    async pause(accountId, paused) {
      fresh();
      const a = accountOf(accountId);
      if (!a) return fail('That Google account is not connected.');
      if (paused) a.paused = true;
      else delete a.paused;
      save();
      if (!paused) stateOf(a.id).state = 'unknown';
      return { ok: true, email: a.account ?? null };
    },

    async test(accountId) {
      fresh();
      if (accountId) {
        const a = accountOf(accountId);
        if (!a) return fail('That Google account is not connected.');
        await checkAccount(a);
      } else await refresh();
      return { ok: true };
    },
  };

  return {
    client: pool,
    folderName: () => data.folderName,
    active: () => eligible().length > 0,
    hasAccounts: () => data.accounts.length > 0,
    terminal,
    refresh,
    waitForConnect: async () => {
      await connect?.done;
      return connect ? { ...connect.view } : null;
    },
  };
}
