import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DriveEndpoints } from './google-drive';

/** A stand-in for the parts of Google the server uses, so tests can run without a Google account. */
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  body: Buffer;
  trashed?: boolean;
  createdTime: string;
}

export interface FakeGoogle {
  endpoints: DriveEndpoints;
  files: Map<string, FakeFile>;
  tokenRequests: number;
  /** Next N calls to the Drive API answer with this status instead. */
  failNext(status: number, n?: number, reason?: string): void;
  revoke(): void;
  /** Takes back one account's permission slip only. */
  revokeAccount(email: string): void;
  /** Device sign-in: approve after this many polls. */
  approveAfter: number;
  /** The Google accounts the next device sign-ins will approve, in order. After the list runs out, new ones are made up. */
  approveAs: string[];
  /** The files of one Google account (the first account's files are also `files`). */
  accountFiles(email: string): Map<string, FakeFile>;
  /** Gives an account a storage limit in bytes (`undefined` removes it). Uploads that do not fit are refused as "storage full". */
  setLimit(email: string, limitBytes: number | undefined, hidden?: boolean): void;
  close(): Promise<void>;
}

interface Acct {
  email: string;
  files: Map<string, FakeFile>;
  limit?: number;
  /** The limit is enforced but not reported by the about call, so only a real upload finds out. */
  limitHidden?: boolean;
  revoked: boolean;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const DEFAULT = 'owner@example.com';
  const accts = new Map<string, Acct>();
  const acct = (email: string): Acct => {
    let a = accts.get(email);
    if (!a) accts.set(email, (a = { email, files: new Map(), revoked: false }));
    return a;
  };
  const files = acct(DEFAULT).files;
  const refreshOwner = new Map<string, string>([['refresh-from-device', DEFAULT]]);
  const bearerOwner = new Map<string, string>();
  let approvals = 0;
  let seq = 0;
  let failures: { status: number; n: number; reason?: string } | null = null;
  let polls = 0;
  const uploads = new Map<string, { name: string; parents: string[]; mimeType: string }>();
  const state: FakeGoogle = {
    endpoints: undefined as never,
    files,
    tokenRequests: 0,
    failNext: (status, n = 1, reason) => (failures = { status, n, reason }),
    revoke: () => {
      for (const a of accts.values()) a.revoked = true;
    },
    revokeAccount: (email) => {
      acct(email).revoked = true;
      for (const [b, e] of bearerOwner) if (e === email) bearerOwner.delete(b); // its access token stops working too
    },
    approveAfter: 1,
    approveAs: [],
    accountFiles: (email) => acct(email).files,
    setLimit: (email, limitBytes, hidden = false) => {
      acct(email).limit = limitBytes;
      acct(email).limitHidden = hidden;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const body = await readBody(req);
    if (url.pathname === '/token') {
      state.tokenRequests++;
      const form = new URLSearchParams(body.toString());
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (++polls < state.approveAfter) return json(res, 428, { error: 'authorization_pending' });
        polls = 0;
        approvals++;
        const email = state.approveAs.shift() ?? (approvals === 1 ? DEFAULT : `user${approvals}@example.com`);
        const token = approvals === 1 && email === DEFAULT ? 'refresh-from-device' : `refresh-${approvals}-${email}`;
        refreshOwner.set(token, email);
        acct(email).revoked = false;
        return json(res, 200, { access_token: 'tok', refresh_token: token, expires_in: 3600 });
      }
      const email = refreshOwner.get(form.get('refresh_token') ?? '') ?? DEFAULT;
      if (acct(email).revoked) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      for (const [b, e] of bearerOwner) if (e === email) bearerOwner.delete(b); // a new token replaces the old one
      const bearer = `tok-${state.tokenRequests}`;
      bearerOwner.set(bearer, email);
      return json(res, 200, { access_token: bearer, expires_in: 3600 });
    }
    if (url.pathname === '/device/code') return json(res, 200, { device_code: 'dev', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 600, interval: 1 });

    // Everything below needs a good bearer token.
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const who = bearer ? bearerOwner.get(bearer) : undefined;
    if (!who) return json(res, 401, { error: { message: 'Invalid Credentials' } });
    const me = acct(who);
    const used = () => [...me.files.values()].reduce((n, f) => n + f.body.length, 0);
    if (failures && failures.n > 0) {
      failures.n--;
      return json(res, failures.status, { error: { message: 'Injected failure', errors: [{ reason: failures.reason ?? 'backendError' }] } });
    }

    if (url.pathname === '/drive/v3/about') return json(res, 200, { user: { emailAddress: me.email }, storageQuota: { usage: String(used()), ...(me.limit !== undefined && !me.limitHidden ? { limit: String(me.limit) } : {}) } });
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const out = [...me.files.values()].filter((f) => !f.trashed && (!parent || f.parents.includes(parent)) && (name === undefined || f.name === name) && (!folderOnly || f.mimeType === 'application/vnd.google-apps.folder'));
      return json(res, 200, { files: out.map(({ body: _b, parents: _p, trashed: _t, ...rest }) => ({ ...rest, size: String(_b.length) })) });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
      const id = `f${++seq}`;
      me.files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [], body: Buffer.alloc(0), createdTime: new Date(2026, 9, 5, 12, 0, seq).toISOString() });
      return json(res, 200, { id });
    }
    const del = /^\/drive\/v3\/files\/(.+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      if (!me.files.delete(decodeURIComponent(del[1]!))) return json(res, 404, { error: { message: 'File not found' } });
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
      const size = Number(req.headers['x-upload-content-length'] ?? 0);
      if (me.limit !== undefined && used() + size > me.limit) return json(res, 403, { error: { message: 'The user\'s Drive storage quota has been exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } });
      const sid = `s${++seq}`;
      uploads.set(sid, { name: meta.name, parents: meta.parents, mimeType: meta.mimeType });
      return json(res, 200, {}, { Location: `${state.endpoints.upload}/session/${sid}` });
    }
    const sess = /^\/upload\/drive\/v3\/session\/(.+)$/.exec(url.pathname);
    if (sess && req.method === 'PUT') {
      const meta = uploads.get(sess[1]!);
      if (!meta) return json(res, 404, { error: { message: 'Unknown upload' } });
      if (Number(req.headers['content-length']) !== body.length) return json(res, 400, { error: { message: 'Length mismatch' } });
      const id = `f${++seq}`;
      const f: FakeFile = { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, body, createdTime: new Date(2026, 9, 5, 12, 0, seq).toISOString() };
      me.files.set(id, f);
      return json(res, 200, { id, name: f.name, mimeType: f.mimeType, size: String(body.length), webViewLink: `https://drive.example/${id}` });
    }
    json(res, 404, { error: { message: `No route ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.endpoints = { token: `${base}/token`, deviceCode: `${base}/device/code`, api: `${base}/drive/v3`, upload: `${base}/upload/drive/v3` };
  return state;
}
