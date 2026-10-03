/**
 * The bridge between the UI and the panel. Screens get exactly two tools from here:
 *   useFeed(name, params)  reads display-ready data
 *   useRun()               sends an intent
 *
 * Two ways to run, chosen by one setting at build time:
 *   VITE_SERVER_URL unset   Standalone demo. The panel runs inside the browser (IndexedDB).
 *   VITE_SERVER_URL set     Real mode. The panel runs on the shop server; this talks to it.
 *                           Use "" or "/" when the server also serves this app.
 * Screens do not know or care which one is in use.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Toasts, type ToastItem } from '@cake-pos/design-system';
import { createClient, localStorageTokenStore } from '@cake-pos/client';
import {
  createIndexedDbStore,
  createPanel,
  seedDemo,
  type DispatchResult,
  type FeedMap,
  type FeedName,
  type IntentMap,
  type IntentName,
  type Role,
} from '@cake-pos/panel';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? null;
export const SERVER_MODE = SERVER_URL !== null;

export interface SessionInfo {
  sessionId: string;
  name: string;
  role: Role;
}

/* ---------- the two backends, behind one small interface ---------- */

interface Backend {
  start(): Promise<void>;
  signIn(userId: string, pin: string): Promise<{ session: SessionInfo } | { error: string }>;
  restore(): Promise<SessionInfo | null>;
  signOut(session: SessionInfo): Promise<void>;
  dispatch<K extends IntentName>(type: K, payload: IntentMap[K], session: SessionInfo | null): Promise<DispatchResult>;
  subscribe<K extends FeedName>(
    name: K,
    params: FeedMap[K]['params'],
    session: SessionInfo | null,
    cb: (r: { ok: true; data: FeedMap[K]['data'] } | { ok: false; message: string }) => void,
  ): () => void;
  /** Called when the server ends a sign-in behind our back. */
  onSignedOut(cb: () => void): void;
}

function localBackend(): Backend {
  const devicePrefix = (() => {
    try {
      let d = localStorage.getItem('cake-pos-device');
      if (!d) {
        const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        d = Array.from({ length: 2 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
        localStorage.setItem('cake-pos-device', d);
      }
      return d;
    } catch {
      return 'X';
    }
  })();
  const store = createIndexedDbStore('cake-pos');
  const panel = createPanel({ store, devicePrefix });
  return {
    start: () => seedDemo(store, panel),
    signIn: async (userId, pin) => {
      const r = await panel.dispatch('auth/sign_in', { userId, pin });
      if (!r.ok) return { error: r.error.messages[0] ?? 'Could not sign in.' };
      const d = r.data as { sessionId: string; session: { name: string; role: Role } };
      return { session: { sessionId: d.sessionId, name: d.session.name, role: d.session.role } };
    },
    restore: async () => null,
    signOut: async (s) => void (await panel.dispatch('auth/sign_out', {}, s.sessionId)),
    dispatch: (type, payload, s) => panel.dispatch(type, payload, s?.sessionId),
    subscribe: (name, params, s, cb) =>
      panel.subscribe(name, params, s?.sessionId, (r) => cb(r.ok ? { ok: true, data: r.data } : { ok: false, message: r.error.messages[0] ?? 'Could not load.' })),
    onSignedOut: () => undefined,
  };
}

function serverBackend(baseUrl: string): Backend {
  let signedOut: () => void = () => undefined;
  const client = createClient({
    baseUrl: baseUrl === '/' ? '' : baseUrl,
    tokenStore: localStorageTokenStore(),
    onSignedOut: () => signedOut(),
  });
  const tokenOf = () => 'server-session';
  return {
    start: async () => undefined,
    signIn: async (userId, pin) => {
      const r = await client.signIn(userId, pin);
      return r.ok ? { session: { sessionId: tokenOf(), name: r.session.name, role: r.session.role } } : { error: r.messages[0] ?? 'Could not sign in.' };
    },
    restore: async () => {
      const me = await client.restore();
      return me ? { sessionId: tokenOf(), name: me.name, role: me.role } : null;
    },
    signOut: async () => void (await client.signOut()),
    dispatch: async (type, payload) => {
      const r = await client.dispatch(type, payload);
      // "offline" is the one result the panel never produces. The screens treat it as an ordinary error.
      return r.ok || r.error.code !== 'offline' ? (r as DispatchResult) : { ok: false, error: { code: 'error', messages: r.error.messages } };
    },
    subscribe: (name, params, _s, cb) => {
      if (name === 'staff_signin') {
        // The sign-in list is needed before anyone has signed in, so it cannot use the live connection.
        let alive = true;
        void client.staff().then((data) => alive && cb({ ok: true, data: data as FeedMap[typeof name]['data'] }));
        return () => void (alive = false);
      }
      return client.subscribe(name, params, (r) => cb(r.ok ? { ok: true, data: r.data } : { ok: false, message: r.error.messages[0] ?? 'Could not load.' }));
    },
    onSignedOut: (cb) => void (signedOut = cb),
  };
}

const backend: Backend = SERVER_MODE ? serverBackend(SERVER_URL!) : localBackend();

/* ---------- provider and hooks ---------- */

interface PanelState {
  ready: boolean;
  failed: boolean;
  session: SessionInfo | null;
  signIn: (userId: string, pin: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  notify: (text: string, tone?: ToastItem['tone']) => void;
}

const Ctx = createContext<PanelState | null>(null);

export function PanelProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const notify = useCallback((text: string, tone: ToastItem['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'info' ? 3000 : 5500);
  }, []);

  useEffect(() => {
    backend.onSignedOut(() => {
      setSession(null);
      notify('You were signed out. Sign in again to continue.', 'warning');
    });
    backend
      .start()
      .then(() => backend.restore())
      .then((s) => {
        if (s) setSession(s);
        setReady(true);
      })
      .catch(() => setFailed(true));
  }, [notify]);

  const signIn = useCallback(async (userId: string, pin: string) => {
    const r = await backend.signIn(userId, pin);
    if ('error' in r) return r.error;
    setSession(r.session);
    return null;
  }, []);

  const signOut = useCallback(async () => {
    if (session) await backend.signOut(session);
    setSession(null);
  }, [session]);

  const value = useMemo(() => ({ ready, failed, session, signIn, signOut, notify }), [ready, failed, session, signIn, signOut, notify]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toasts items={toasts} />
    </Ctx.Provider>
  );
}

export function usePanelState() {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePanelState must be used inside PanelProvider');
  return v;
}

export interface RunOptions {
  /** The caller shows failures inline, so skip the error toast. */
  inlineErrors?: boolean;
}

/** Send an intent. Success and warnings become toasts using the panel's own wording. */
export function useRun() {
  const { session, notify } = usePanelState();
  return useCallback(
    async <K extends IntentName>(type: K, payload: IntentMap[K], opts: RunOptions = {}): Promise<DispatchResult> => {
      const r = await backend.dispatch(type, payload, session);
      if (r.ok) {
        notify(r.summary);
        for (const w of r.warnings) notify(w, 'warning');
      } else if (!opts.inlineErrors) {
        notify(r.error.messages[0] ?? 'Something went wrong.', 'error');
      }
      return r;
    },
    [session, notify],
  );
}

export interface FeedState<K extends FeedName> {
  data: FeedMap[K]['data'] | null;
  error: string | null;
  loading: boolean;
}

/** Read a feed. It updates by itself after every change anyone makes. */
export function useFeed<K extends FeedName>(name: K, params: FeedMap[K]['params'], enabled = true): FeedState<K> {
  const { session } = usePanelState();
  const key = JSON.stringify(params);
  const [state, setState] = useState<FeedState<K>>({ data: null, error: null, loading: true });

  useEffect(() => {
    if (!enabled) return;
    setState((s) => ({ ...s, loading: s.data === null }));
    return backend.subscribe(name, JSON.parse(key) as FeedMap[K]['params'], session, (r) => {
      setState(r.ok ? { data: r.data, error: null, loading: false } : { data: null, error: r.message, loading: false });
    });
  }, [name, key, session, enabled]);

  return state;
}

export function useWide(min = 960) {
  const query = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return wide;
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
