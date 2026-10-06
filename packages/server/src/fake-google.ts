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
  /** Device sign-in: approve after this many polls. */
  approveAfter: number;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const files = new Map<string, FakeFile>();
  let seq = 0;
  let validToken = 'tok-1';
  let revoked = false;
  let failures: { status: number; n: number; reason?: string } | null = null;
  let polls = 0;
  const uploads = new Map<string, { name: string; parents: string[]; mimeType: string }>();
  const state: FakeGoogle = {
    endpoints: undefined as never,
    files,
    tokenRequests: 0,
    failNext: (status, n = 1, reason) => (failures = { status, n, reason }),
    revoke: () => (revoked = true),
    approveAfter: 1,
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
        return json(res, 200, { access_token: 'tok', refresh_token: 'refresh-from-device', expires_in: 3600 });
      }
      if (revoked) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      validToken = `tok-${state.tokenRequests}`;
      return json(res, 200, { access_token: validToken, expires_in: 3600 });
    }
    if (url.pathname === '/device/code') return json(res, 200, { device_code: 'dev', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 600, interval: 1 });

    // Everything below needs a good bearer token.
    if (req.headers.authorization !== `Bearer ${validToken}`) return json(res, 401, { error: { message: 'Invalid Credentials' } });
    if (failures && failures.n > 0) {
      failures.n--;
      return json(res, failures.status, { error: { message: 'Injected failure', errors: [{ reason: failures.reason ?? 'backendError' }] } });
    }

    if (url.pathname === '/drive/v3/about') return json(res, 200, { user: { emailAddress: 'owner@example.com' } });
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const out = [...files.values()].filter((f) => !f.trashed && (!parent || f.parents.includes(parent)) && (name === undefined || f.name === name) && (!folderOnly || f.mimeType === 'application/vnd.google-apps.folder'));
      return json(res, 200, { files: out.map(({ body: _b, parents: _p, trashed: _t, ...rest }) => ({ ...rest, size: String(_b.length) })) });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
      const id = `f${++seq}`;
      files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [], body: Buffer.alloc(0), createdTime: new Date(2026, 9, 5, 12, 0, seq).toISOString() });
      return json(res, 200, { id });
    }
    const del = /^\/drive\/v3\/files\/(.+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      if (!files.delete(decodeURIComponent(del[1]!))) return json(res, 404, { error: { message: 'File not found' } });
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
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
      files.set(id, f);
      return json(res, 200, { id, name: f.name, mimeType: f.mimeType, size: String(body.length), webViewLink: `https://drive.example/${id}` });
    }
    json(res, 404, { error: { message: `No route ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.endpoints = { token: `${base}/token`, deviceCode: `${base}/device/code`, api: `${base}/drive/v3`, upload: `${base}/upload/drive/v3` };
  return state;
}
