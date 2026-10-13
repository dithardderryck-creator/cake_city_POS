/**
 * Client for the Cake POS shop server.
 *
 * Works in browsers and in Node. It avoids crypto.randomUUID and crypto.subtle on purpose:
 * browsers switch those off on plain http:// addresses, which is how a shop server is usually reached.
 */
import type { DispatchResult, FeedMap, FeedName, FeedResult, IntentMap, IntentName, Role, StaffSigninRow } from '@cake-pos/panel';

export type { DispatchResult, FeedMap, FeedName, FeedResult, IntentMap, IntentName, Role, StaffSigninRow };

/** The error shape every call uses when the server answers with a refusal. */
export interface ServerError {
  ok: false;
  error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] };
}

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
export type PhotoUpload = { ok: true; photoId: string; mime: string; size: number } | ServerError | OfflineError;
export type PhotoDownload = { ok: true; blob: Blob; mime: string } | ServerError | OfflineError;

/** Timing defaults. A tap on a stuck server gives up after about `deadlineMs`, not after the sum of every retry. */
export const CLIENT_DEFAULTS = { retries: 2, timeoutMs: 8_000, deadlineMs: 15_000, signOutRetryMs: 20_000 } as const;

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
  /** Keeps the secret this browser got when it was registered. Use `localStorageTokenStore('cake-pos-device')` in a page. */
  deviceStore?: TokenStore;
  /** How many times to retry when the network fails. The same request id is reused, so nothing runs twice. */
  retries?: number;
  /** How long one attempt may take before it is abandoned. */
  timeoutMs?: number;
  /** The most time one call may take in total, retries included. */
  deadlineMs?: number;
  /** When sign-out could not reach the server, how often to try again in the background to end the sign-in there. */
  signOutRetryMs?: number;
  /** Called when the server says the sign-in is no longer valid (expired, signed out elsewhere, switched off). */
  onSignedOut?: () => void;
}

export type DeviceStatus = { required: boolean; registered: boolean; name?: string };
export type PairResult = { ok: true; name: string } | { ok: false; code: string; messages: string[] };

export type SignInResult = { ok: true; session: SessionInfo } | { ok: false; code: string; messages: string[] };

export interface Client {
  /** Is this browser registered? Null when the server cannot be reached. Forgets a saved secret the server no longer knows (revoked). */
  deviceStatus(): Promise<DeviceStatus | null>;
  /** Register this browser with a one-time code from the owner or IT. Saves the secret it gets back. */
  pairDevice(code: string): Promise<PairResult>;
  staff(): Promise<StaffSigninRow[]>;
  signIn(userId: string, pin: string): Promise<SignInResult>;
  /** Use a saved token. Returns who is signed in, or null if there is no valid sign-in. */
  restore(): Promise<SessionInfo | null>;
  /**
   * Signs out on this device immediately. Then asks the server to end the sign-in too;
   * `serverEnded` is false when it could not be reached (it keeps trying in the background).
   */
  signOut(): Promise<{ serverEnded: boolean }>;
  /**
   * Upload a reference picture (JPEG, PNG or WebP, up to 5 MB; shrink phone photos first).
   * Pass the returned `photoId` to the `orders/attach_reference_photo` instruction.
   */
  uploadPhoto(data: Blob | ArrayBuffer | Uint8Array, mime?: string): Promise<PhotoUpload>;
  /** Fetch a stored picture. Show it with `URL.createObjectURL(result.blob)`. */
  photo(photoId: string): Promise<PhotoDownload>;
  dispatch<K extends IntentName>(type: K, payload: IntentMap[K]): Promise<ClientResult>;
  feed<K extends FeedName>(name: K, params: FeedMap[K]['params']): Promise<ClientFeedResult<FeedMap[K]['data']>>;
  /** Live data: called now, and again after every change anyone makes. Returns an unsubscribe function. */
  subscribe<K extends FeedName>(name: K, params: FeedMap[K]['params'], listener: (r: FeedResult<FeedMap[K]['data']>) => void): () => void;
  onConnection(listener: (s: ConnectionState) => void): () => void;
  /** Fires when the sign-in ends without the user asking: expired, signed out elsewhere, or switched off. */
  onSignedOut(listener: () => void): () => void;
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

/** For an action: the request may have reached the server before the answer was lost, so the wording must not claim otherwise. */
const offlineActionResult = (): OfflineError => ({
  ok: false,
  error: { code: 'offline', messages: ['Cannot reach the shop server. Check the wifi. The last action may or may not have gone through. Tap it again when the wifi is back: it will not be done twice.'] },
});

export function createClient(options: ClientOptions = {}): Client {
  const f: typeof fetch = options.fetch ?? ((...a) => globalThis.fetch(...a));
  const retries = options.retries ?? CLIENT_DEFAULTS.retries;
  const timeoutMs = options.timeoutMs ?? CLIENT_DEFAULTS.timeoutMs;
  const deadlineMs = options.deadlineMs ?? CLIENT_DEFAULTS.deadlineMs;
  const signOutRetryMs = options.signOutRetryMs ?? CLIENT_DEFAULTS.signOutRetryMs;
  const signedOutListeners = new Set<() => void>();
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  let token: string | null = options.tokenStore?.get() ?? null;
  const deviceToken = () => options.deviceStore?.get() ?? null;
  const deviceHeader = (): Record<string, string> => {
    const d = deviceToken();
    return d ? { 'x-device-token': d } : {};
  };

  const setToken = (t: string | null) => {
    token = t;
    options.tokenStore?.set(t);
  };
  const lostSignIn = () => {
    if (token === null) return;
    setToken(null);
    socket?.close();
    options.onSignedOut?.();
    for (const l of signedOutListeners) l();
  };

  interface Limits {
    timeoutMs: number;
    deadlineMs: number;
  }
  const normalLimits: Limits = { timeoutMs, deadlineMs };
  /** Actions that got no answer, by what they were, with the request id they used. */
  const unsure = new Map<string, string>();

  /** One call with retries inside an overall deadline. `read` turns the response into what the caller wants. */
  async function send<T>(
    path: string,
    init: (authToken: string | null) => RequestInit,
    read: (res: Response) => Promise<T>,
    authToken: string | null = token,
    limits: Limits = normalLimits,
  ): Promise<{ status: number; value: T } | 'offline'> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const left = limits.deadlineMs - (Date.now() - started);
      if (left <= 0) return 'offline';
      try {
        const res = await f(base + path, { ...init(authToken), signal: AbortSignal.timeout(Math.min(limits.timeoutMs, left)) });
        if ([502, 503, 504].includes(res.status) && attempt < retries) throw new Error('server busy');
        return { status: res.status, value: await read(res) };
      } catch {
        if (attempt >= retries) return 'offline';
        const pause = 200 * 3 ** attempt;
        if (limits.deadlineMs - (Date.now() - started) <= pause) return 'offline';
        await sleep(pause);
      }
    }
  }

  async function post(path: string, body: unknown, authToken: string | null = token): Promise<{ status: number; json: unknown } | 'offline'> {
    const r = await send(
      path,
      (t) => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', ...deviceHeader(), ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify(body),
      }),
      (res) => res.json().catch(() => null) as Promise<unknown>,
      authToken,
    );
    return r === 'offline' ? r : { status: r.status, json: r.value };
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
    ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', token, deviceToken: deviceToken() ?? undefined }));
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
        for (const s of subs.values()) ws.send(JSON.stringify({ op: 'subscribe', id: s.id, name: s.name, params: s.params, deviceToken: deviceToken() ?? undefined }));
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

  /** An old sign-in the server has not yet been told to end. Retried quietly until it works or we give up. */
  const pendingRevokes = new Set<ReturnType<typeof setTimeout>>();
  function scheduleRevoke(_old: string, tryRevoke: () => Promise<boolean>, tries = 0) {
    if (closed || tries >= 40) return;
    const t = setTimeout(async () => {
      pendingRevokes.delete(t);
      if (closed) return;
      if (!(await tryRevoke())) scheduleRevoke(_old, tryRevoke, tries + 1);
    }, signOutRetryMs);
    pendingRevokes.add(t);
  }

  return {
    get connection() {
      return state;
    },
    get signedIn() {
      return token !== null;
    },

    async deviceStatus() {
      try {
        const res = await f(base + '/api/device', { headers: deviceHeader(), signal: AbortSignal.timeout(timeoutMs) });
        const j = (await res.json()) as { ok?: boolean } & DeviceStatus;
        if (!j?.ok) return null;
        if (j.required && !j.registered && deviceToken()) options.deviceStore?.set(null);
        return { required: j.required, registered: j.registered, ...(j.name ? { name: j.name } : {}) };
      } catch {
        return null;
      }
    },

    async pairDevice(code) {
      const r = await post('/api/pair', { code }, null);
      if (r === 'offline') return { ok: false, code: 'offline', messages: offlineResult().error.messages };
      const j = r.json as { ok: boolean; deviceToken?: string; deviceName?: string; error?: { code: string; messages: string[] } } | null;
      if (j?.ok && j.deviceToken) {
        options.deviceStore?.set(j.deviceToken);
        return { ok: true, name: j.deviceName ?? 'This device' };
      }
      return { ok: false, code: j?.error?.code ?? 'error', messages: j?.error?.messages ?? ['Could not register this device.'] };
    },

    async staff() {
      try {
        const res = await f(base + '/api/staff', { headers: deviceHeader(), signal: AbortSignal.timeout(timeoutMs) });
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
      // Sign out on this device first so the next person at the till can never inherit it, whatever the network does.
      const old = token;
      setToken(null);
      socket?.close();
      if (!old) return { serverEnded: true };
      const tryRevoke = async () => {
        const r = await post('/api/sign-out', {}, old);
        // 401 means the server no longer honours this token, which is the outcome we wanted.
        return r !== 'offline';
      };
      if (await tryRevoke()) return { serverEnded: true };
      scheduleRevoke(old, tryRevoke);
      return { serverEnded: false };
    },

    async uploadPhoto(data, mime) {
      const body = data instanceof Blob ? data : new Blob([data as BlobPart]);
      const type = mime ?? (data instanceof Blob && data.type ? data.type : 'application/octet-stream');
      // A picture is big, so give it more time than a tap, but still never hang forever.
      const limits: Limits = { timeoutMs: Math.max(timeoutMs, 30_000), deadlineMs: Math.max(deadlineMs, 60_000) };
      const r = await send(
        '/api/photos',
        (t) => ({ method: 'POST', headers: { 'content-type': type, ...(t ? { authorization: `Bearer ${t}` } : {}) } as Record<string, string>, body }),
        (res) => res.json().catch(() => null) as Promise<PhotoUpload | null>,
        token,
        limits,
      );
      if (r === 'offline') return offlineResult();
      if (r.status === 401) lostSignIn();
      return r.value ?? { ok: false, error: { code: 'error', messages: ['The server gave an answer this app does not understand.'] } };
    },

    async photo(photoId) {
      type Body = { kind: 'image'; blob: Blob; mime: string } | { kind: 'error'; error: ServerError | null };
      const r = await send<Body>(
        `/api/photos/${encodeURIComponent(photoId)}`,
        (t) => ({ method: 'GET', headers: t ? ({ authorization: `Bearer ${t}` } as Record<string, string>) : ({} as Record<string, string>) }),
        async (res) =>
          res.ok
            ? { kind: 'image', blob: await res.blob(), mime: res.headers.get('content-type') ?? 'application/octet-stream' }
            : { kind: 'error', error: (await res.json().catch(() => null)) as ServerError | null },
        token,
        { timeoutMs: Math.max(timeoutMs, 20_000), deadlineMs: Math.max(deadlineMs, 30_000) },
      );
      if (r === 'offline') return offlineResult();
      if (r.status === 401) lostSignIn();
      if (r.value.kind === 'image') return { ok: true, blob: r.value.blob, mime: r.value.mime };
      return r.value.error ?? { ok: false, error: { code: 'error', messages: ['The server gave an answer this app does not understand.'] } };
    },

    async dispatch(type, payload) {
      // An action whose answer never came back may still have run. Asking again with the same request id
      // makes the server answer from memory instead of doing it twice, so a second tap is always safe.
      const key = `${type}:${JSON.stringify(payload)}`;
      const requestId = unsure.get(key) ?? randomId();
      const r = await post('/api/dispatch', { type, payload, requestId });
      if (r === 'offline') {
        unsure.delete(key);
        unsure.set(key, requestId);
        if (unsure.size > 20) unsure.delete(unsure.keys().next().value as string);
        return offlineActionResult();
      }
      unsure.delete(key);
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

    onSignedOut(listener) {
      signedOutListeners.add(listener);
      return () => signedOutListeners.delete(listener);
    },

    onConnection(listener) {
      connListeners.add(listener);
      return () => connListeners.delete(listener);
    },

    close() {
      closed = true;
      for (const t of pendingRevokes) clearTimeout(t);
      pendingRevokes.clear();
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      subs.clear();
    },
  };
}

export * from './alerts';
