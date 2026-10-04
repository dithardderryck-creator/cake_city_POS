import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_PHOTO_BYTES, type DispatchResult, type FeedName, type FeedResult, type IntentName, type Panel } from '@cake-pos/panel';
import type { ServerConfig } from './config';
import { errorFields, type Logger } from './log';

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 256 * 1024;

export const statusFor = (code: string): number =>
  ({ unauthenticated: 401, forbidden: 403, invalid: 422, error: 500 })[code] ?? 500;

function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()) => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    return recent.length <= max;
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface HttpHandle {
  server: http.Server;
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
  clientCount(): number;
}

export interface HttpOptions {
  panel: Panel;
  log: Logger;
  config: Pick<ServerConfig, 'allowedOrigins' | 'staticDir' | 'tls'>;
  version: string;
}

export function createHttpServer(o: HttpOptions): HttpHandle {
  const { panel, log } = o;
  const signInLimit = rateLimiter(20, 60_000);
  const sockets = new Set<WebSocket>();

  const originAllowed = (origin: string | undefined) =>
    !!origin && (o.config.allowedOrigins === '*' || o.config.allowedOrigins.includes(origin));

  function baseHeaders(req: http.IncomingMessage, api: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (api) h['Cache-Control'] = 'no-store';
    const origin = req.headers.origin;
    if (originAllowed(origin)) {
      h['Access-Control-Allow-Origin'] = origin!;
      h['Vary'] = 'Origin';
    }
    return h;
  }

  function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown) {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...baseHeaders(req, true), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  const errBody = (code: string, message: string) => ({ ok: false, error: { code, messages: [message] } });

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'invalid', 'Send JSON with Content-Type: application/json.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'invalid', 'That request is too large.');
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'invalid', 'The request body is not valid JSON.');
    }
  }

  /** The raw bytes of an upload, refusing anything over the limit before it is all read. */
  async function readBytes(req: http.IncomingMessage, limit: number): Promise<Uint8Array> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'invalid', 'That picture is too big. Pictures can be up to 5 MB.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, 'invalid', 'That picture is too big. Pictures can be up to 5 MB.');
      chunks.push(chunk as Buffer);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  const bearer = (req: http.IncomingMessage) => {
    const m = /^Bearer\s+(\S{20,200})$/.exec(req.headers.authorization ?? '');
    return m?.[1];
  };

  // The socket is gone if the client hung up before we answered, so this must not assume it exists.
  const ipOf = (req: http.IncomingMessage) => req.socket?.remoteAddress ?? 'unknown';

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, root: string, urlPath: string) {
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      throw new HttpError(400, 'invalid', 'Bad address.');
    }
    const resolved = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new HttpError(403, 'forbidden', 'Not allowed.');
    let file = resolved;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Pages in the UI's own router have no file extension: give them the app.
      if (path.extname(rel)) throw new HttpError(404, 'invalid', 'Not found.');
      file = path.join(root, 'index.html');
      if (!fs.existsSync(file)) throw new HttpError(404, 'invalid', 'The UI has not been built into this folder yet.');
    }
    const ext = path.extname(file).toLowerCase();
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      ...baseHeaders(req, false),
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ note?: string }> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...baseHeaders(req, true),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return {};
    }

    if (!p.startsWith('/api/')) {
      if ((req.method === 'GET' || req.method === 'HEAD') && o.config.staticDir) {
        serveStatic(req, res, o.config.staticDir, p);
        return {};
      }
      throw new HttpError(404, 'invalid', 'Not found.');
    }

    if (req.method === 'GET' && p === '/api/health') {
      sendJson(req, res, 200, { ok: true, name: 'cake-pos', version: o.version, time: new Date().toISOString() });
      return {};
    }

    if (req.method === 'GET' && p === '/api/staff') {
      const r = await panel.feed('staff_signin', {});
      sendJson(req, res, r.ok ? 200 : statusFor(r.error.code), r);
      return {};
    }

    if (req.method === 'GET' && p.startsWith('/api/photos/')) {
      const id = decodeURIComponent(p.slice('/api/photos/'.length));
      const r = await panel.readPhoto(id.slice(0, 64), bearer(req));
      if (!r.ok) {
        sendJson(req, res, r.error.code === 'invalid' ? 404 : statusFor(r.error.code), r);
        return {};
      }
      // Pictures never change once stored, so the browser may keep them. They are still private to signed-in staff.
      res.writeHead(200, {
        ...baseHeaders(req, true),
        'Cache-Control': 'private, max-age=86400',
        'Content-Type': r.mime,
        'Content-Length': r.bytes.length,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.end(Buffer.from(r.bytes));
      return { note: 'photo' };
    }

    if (req.method === 'POST' && p === '/api/photos') {
      const type = req.headers['content-type'] ?? '';
      if (!/^(image\/(jpeg|png|webp)|application\/octet-stream)\b/i.test(type))
        throw new HttpError(415, 'invalid', 'Send the picture as image/jpeg, image/png or image/webp.');
      const bytes = await readBytes(req, MAX_PHOTO_BYTES);
      const r = await panel.uploadPhoto(bytes, bearer(req));
      sendJson(req, res, r.ok ? 200 : statusFor(r.error.code), r);
      return { note: r.ok ? 'photo upload' : `photo upload -> ${r.error.code}` };
    }

    if (req.method !== 'POST') throw new HttpError(405, 'invalid', 'Use POST for this address.');
    const body = await readJson(req);
    const token = bearer(req);

    if (p === '/api/sign-in') {
      if (!signInLimit(ipOf(req))) throw new HttpError(429, 'forbidden', 'Too many sign-in attempts. Wait a minute and try again.');
      const r = await panel.dispatch('auth/sign_in', { userId: body.userId as string, pin: body.pin as string });
      if (!r.ok) {
        sendJson(req, res, r.error.code === 'unauthenticated' ? 403 : statusFor(r.error.code), r);
        return { note: 'sign-in refused' };
      }
      const data = r.data as { sessionId: string; session: unknown };
      sendJson(req, res, 200, { ok: true, token: data.sessionId, session: data.session, warnings: r.warnings, summary: r.summary });
      return { note: 'signed in' };
    }

    if (p === '/api/sign-out') {
      const r = await panel.dispatch('auth/sign_out', {}, token);
      sendJson(req, res, r.ok ? 200 : statusFor(r.error.code), r);
      return {};
    }

    if (p === '/api/dispatch') {
      if (typeof body.type !== 'string') throw new HttpError(422, 'invalid', 'Send { "type": "...", "payload": { ... } }.');
      const requestId = typeof body.requestId === 'string' && body.requestId.length <= 80 ? body.requestId : undefined;
      const r: DispatchResult = await panel.dispatch(body.type as IntentName, (body.payload ?? {}) as never, token, { requestId });
      sendJson(req, res, r.ok ? 200 : statusFor(r.error.code), r);
      return { note: `${body.type}${r.ok ? '' : ` -> ${r.error.code}`}` };
    }

    if (p === '/api/feed') {
      if (typeof body.name !== 'string') throw new HttpError(422, 'invalid', 'Send { "name": "...", "params": { ... } }.');
      const r: FeedResult<unknown> = await panel.feed(body.name as FeedName, (body.params ?? {}) as never, token);
      sendJson(req, res, r.ok ? 200 : statusFor(r.error.code), r);
      return { note: String(body.name) };
    }

    throw new HttpError(404, 'invalid', 'Not found.');
  }

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const started = Date.now();
    res.on('finish', () => {
      // Logging must never be able to take the server down.
      try {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/api/health' && res.statusCode === 200) return;
        log.info('request', { method: req.method, path, status: res.statusCode, ms: Date.now() - started, ip: ipOf(req) });
      } catch {
        /* ignore */
      }
    });
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJson(req, res, err.status, errBody(err.code, err.message));
      log.error('Unhandled request error', errorFields(err));
      sendJson(req, res, 500, errBody('error', 'Something went wrong on the server. Nothing was saved, so it is safe to try again.'));
    });
  };
  const server: http.Server = o.config.tls
    ? https.createServer({ cert: fs.readFileSync(o.config.tls.cert), key: fs.readFileSync(o.config.tls.key) }, onRequest)
    : http.createServer(onRequest);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  /* ---------- Live feeds over WebSocket ---------- */

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/live') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    let token: string | undefined;
    let alive = true;
    const subs = new Map<string, () => void>();
    const send = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

    const authTimer = setTimeout(() => {
      if (!token) ws.close(4001, 'Sign in first');
    }, 10_000);
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on('pong', () => (alive = true));

    ws.on('message', async (raw) => {
      let msg: { op?: string; id?: unknown; name?: unknown; params?: unknown; token?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ op: 'error', error: { code: 'invalid', messages: ['That message was not valid JSON.'] } });
      }
      switch (msg.op) {
        case 'auth': {
          const r = await panel.feed('navigation', {}, typeof msg.token === 'string' ? msg.token : undefined);
          if (r.ok) token = msg.token as string;
          return send(r.ok ? { op: 'auth', ok: true } : { op: 'auth', ok: false, error: r.error });
        }
        case 'subscribe': {
          if (typeof msg.id !== 'string' || msg.id.length > 64 || typeof msg.name !== 'string')
            return send({ op: 'error', error: { code: 'invalid', messages: ['subscribe needs a string id and feed name.'] } });
          if (!token && msg.name !== 'staff_signin') return send({ op: 'error', id: msg.id, error: { code: 'unauthenticated', messages: ['Sign in first.'] } });
          if (subs.size >= 30 && !subs.has(msg.id)) return send({ op: 'error', id: msg.id, error: { code: 'invalid', messages: ['Too many live feeds on one connection.'] } });
          subs.get(msg.id)?.();
          const id = msg.id;
          subs.set(id, panel.subscribe(msg.name as FeedName, (msg.params ?? {}) as never, token, (result) => send({ op: 'feed', id, result })));
          return;
        }
        case 'unsubscribe':
          if (typeof msg.id === 'string') {
            subs.get(msg.id)?.();
            subs.delete(msg.id);
          }
          return;
        case 'ping':
          return send({ op: 'pong' });
        default:
          return send({ op: 'error', error: { code: 'invalid', messages: ['Unknown message.'] } });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      for (const off of subs.values()) off();
      subs.clear();
      sockets.delete(ws);
    });
    ws.on('error', (err) => log.warn('WebSocket error', errorFields(err)));
  });

  return {
    server,
    clientCount: () => sockets.size,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve((server.address() as { port: number }).port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.close(1001, 'Server is restarting');
        wss.close();
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 2000).unref();
      }),
  };
}
