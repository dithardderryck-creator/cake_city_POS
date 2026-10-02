/**
 * Client for the Cake POS shop server.
 *
 * Works in browsers and in Node. It avoids crypto.randomUUID and crypto.subtle on purpose:
 * browsers switch those off on plain http:// addresses, which is how a shop server is usually reached.
 */
import type { DispatchResult, FeedMap, FeedName, FeedResult, IntentMap, IntentName, Role, StaffSigninRow } from '@cake-pos/panel';

export type { DispatchResult, FeedMap, FeedName, FeedResult, IntentMap, IntentName, Role, StaffSigninRow };

export interface SessionInfo {
  userId: string;
  name: string;
  role: Role;
}

/** The server could not be reached at all, even after retrying. Nothing is known to have happened. */
export interface OfflineError {
  ok: false;
  error: { code: 'offline'; messages: string[] };
}
export type ClientResult = DispatchResult | OfflineError;
export type ClientFeedResult<D> = FeedResult<D> | OfflineError;

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

/** Keeps the sign-in across page reloads. Only use where localStorage exists. */
export function localStorageTokenStore(key = 'cake-pos-token'): TokenStore {
  return {
    get: () => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (t) => {
      try {
        if (t) globalThis.localStorage?.setItem(key, t);
        else globalThis.localStorage?.removeItem(key);
      } catch {
        /* storage blocked: the sign-in just will not survive a reload */
      }
    },
  };
}

/** The bit of the WebSocket API we use, so Node's `ws` or the browser's WebSocket both fit. */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
type SocketCtor = new (url: string) => SocketLike;

export interface ClientOptions {
  /** For example "http://192.168.1.20:8787". Leave empty when the UI is served by the server itself. */
  baseUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: SocketCtor;
  tokenStore?: TokenStore;
  /** How many times to retry when the network fails. The same request id is reused, so nothing runs twice. */
  retries?: number;
  /** Called when the server says the sign-in is no longer valid (expired, signed out elsewhere, switched off). */
  onSignedOut?: () => void;
}

export type SignInResult = { ok: true; session: SessionInfo } | { ok: false; code: string; messages: string[] };

export interface Client {
  staff(): Promise<StaffSigninRow[]>;
  signIn(userId: string, pin: string): Promise<SignInResult>;
  /** Use a saved token. Returns who is signed in, or null if there is no valid sign-in. */
  restore(): Promise<SessionInfo | null>;
  signOut(): Promise<void>;
  dispatch<K extends IntentName>(type: K, payload: IntentMap[K]): Promise<ClientResult>;
  feed<K extends FeedName>(name: K, params: FeedMap[K]['params']): Promise<ClientFeedResult<FeedMap[K]['data']>>;
  /** Live data: called now, and again after every change anyone makes. Returns an unsubscribe function. */
  subscribe<K extends FeedName>(name: K, params: FeedMap[K]['params'], listener: (r: FeedResult<FeedMap[K]['data']>) => void): () => void;
  onConnection(listener: (s: ConnectionState) => void): () => void;
  readonly connection: ConnectionState;
  readonly signedIn: boolean;
  close(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const offlineResult = (): OfflineError => ({
  ok: false,
  error: { code: 'offline', messages: ['Cannot reach the shop server. Check the wifi. Nothing was changed, and it is safe to try again.'] },
});

export function createClient(options: ClientOptions = {}): Client {
  const f: typeof fetch = options.fetch ?? ((...a) => globalThis.fetch(...a));
  const retries = options.retries ?? 3;
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  let token: string | null = options.tokenStore?.get() ?? null;

  const setToken = (t: string | null) => {
    token = t;
    options.tokenStore?.set(t);
  };
  const lostSignIn = () => {
    if (token === null) return;
    setToken(null);
    options.onSignedOut?.();
  };

  async function post(path: string, body: unknown): Promise<{ status: number; json: unknown } | 'offline'> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await f(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if ([502, 503, 504].includes(res.status) && attempt < retries) throw new Error('server busy');
        return { status: res.status, json: await res.json().catch(() => null) };
      } catch {
        if (attempt >= retries) return 'offline';
        await sleep(200 * 3 ** attempt);
      }
    }
  }

  const bad = (status: number): DispatchResult => ({
    ok: false,
    error: { code: status === 401 ? 'unauthenticated' : 'error', messages: ['The server gave an answer this app does not understand.'] },
  });

  /* ---------- live feeds ---------- */

  interface Sub {
    id: string;
    name: string;
    params: unknown;
    listener: (r: FeedResult<never>) => void;
  }
  const subs = new Map<string, Sub>();
  const connListeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'offline';
  let socket: SocketLike | null = null;
  let authed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let closed = false;

  const setState = (s: ConnectionState) => {
    if (s === state) return;
    state = s;
    for (const l of connListeners) l(s);
  };

  const wsUrl = () => {
    const origin = base || (globalThis.location ? globalThis.location.origin : '');
    return origin.replace(/^http/, 'ws') + '/api/live';
  };

  function connect() {
    if (closed || socket || !token || subs.size === 0) return;
    const Ctor = options.WebSocket ?? (globalThis as unknown as { WebSocket?: SocketCtor }).WebSocket;
    if (!Ctor) return;
    setState('connecting');
    const ws = new Ctor(wsUrl());
    socket = ws;
    authed = false;
    ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', token }));
    ws.onmessage = (ev) => {
      let msg: { op: string; id?: string; ok?: boolean; result?: FeedResult<never>; error?: { code: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.op === 'auth') {
        if (!msg.ok) {
          lostSignIn();
          ws.close();
          return;
        }
        authed = true;
        failures = 0;
        setState('online');
        // On every (re)connection the server sends the current state of each feed straight away.
        for (const s of subs.values()) ws.send(JSON.stringify({ op: 'subscribe', id: s.id, name: s.name, params: s.params }));
      } else if (msg.op === 'feed' && msg.id && msg.result) {
        if (!msg.result.ok && msg.result.error.code === 'unauthenticated') lostSignIn();
        subs.get(msg.id)?.listener(msg.result);
      }
    };
    const dropped = () => {
      if (socket !== ws) return;
      socket = null;
      authed = false;
      setState('offline');
      if (closed || subs.size === 0 || !token) return;
      failures++;
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(failures - 1, 4)) * (0.75 + Math.random() * 0.5);
      retryTimer = setTimeout(connect, delay);
    };
    ws.onclose = dropped;
    ws.onerror = () => undefined; // onclose follows
  }

  return {
    get connection() {
      return state;
    },
    get signedIn() {
      return token !== null;
    },

    async staff() {
      try {
        const res = await f(base + '/api/staff', { signal: AbortSignal.timeout(15_000) });
        const json = (await res.json()) as FeedResult<StaffSigninRow[]>;
        return json.ok ? json.data : [];
      } catch {
        return [];
      }
    },

    async signIn(userId, pin) {
      const r = await post('/api/sign-in', { userId, pin });
      if (r === 'offline') return { ok: false, code: 'offline', messages: offlineResult().error.messages };
      const j = r.json as { ok: boolean; token?: string; session?: SessionInfo; error?: { code: string; messages: string[] } } | null;
      if (j?.ok && j.token && j.session) {
        setToken(j.token);
        connect();
        return { ok: true, session: j.session };
      }
      return { ok: false, code: j?.error?.code ?? 'error', messages: j?.error?.messages ?? ['Could not sign in.'] };
    },

    async restore() {
      if (!token) return null;
      const r = await post('/api/feed', { name: 'me', params: {} });
      if (r === 'offline') return null; // token kept: the server may just be starting
      const j = r.json as FeedResult<SessionInfo> | null;
      if (j?.ok) {
        connect();
        return j.data;
      }
      if (r.status === 401) lostSignIn();
      return null;
    },

    async signOut() {
      await post('/api/sign-out', {});
      setToken(null);
      socket?.close();
    },

    async dispatch(type, payload) {
      const r = await post('/api/dispatch', { type, payload, requestId: randomId() });
      if (r === 'offline') return offlineResult();
      if (r.status === 401) lostSignIn();
      return (r.json as DispatchResult | null) ?? bad(r.status);
    },

    async feed(name, params) {
      const r = await post('/api/feed', { name, params });
      if (r === 'offline') return offlineResult();
      if (r.status === 401) lostSignIn();
      return (r.json as FeedResult<never> | null) ?? (bad(r.status) as FeedResult<never>);
    },

    subscribe(name, params, listener) {
      const id = randomId();
      subs.set(id, { id, name, params, listener: listener as Sub['listener'] });
      if (socket && authed) socket.send(JSON.stringify({ op: 'subscribe', id, name, params }));
      else connect();
      return () => {
        subs.delete(id);
        if (socket && authed) socket.send(JSON.stringify({ op: 'unsubscribe', id }));
        if (subs.size === 0) {
          if (retryTimer) clearTimeout(retryTimer);
          socket?.close();
        }
      };
    },

    onConnection(listener) {
      connListeners.add(listener);
      return () => connListeners.delete(listener);
    },

    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      subs.clear();
    },
  };
}
