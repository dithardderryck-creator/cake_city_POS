/**
 * The bridge between the UI and the panel. Screens get exactly two tools from here:
 *   useFeed(name, params)  reads display-ready data
 *   useRun()               sends an intent
 * Nothing else in the app talks to the panel, storage or the network.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Toasts, type ToastItem } from '@cake-pos/design-system';
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
export const panel = createPanel({ store, devicePrefix });

export interface SessionInfo {
  sessionId: string;
  name: string;
  role: Role;
}

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

  useEffect(() => {
    seedDemo(store, panel)
      .then(() => setReady(true))
      .catch(() => setFailed(true));
  }, []);

  const notify = useCallback((text: string, tone: ToastItem['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'info' ? 3000 : 5500);
  }, []);

  const signIn = useCallback(async (userId: string, pin: string) => {
    const r = await panel.dispatch('auth/sign_in', { userId, pin });
    if (!r.ok) return r.error.messages[0] ?? 'Could not sign in.';
    const data = r.data as { sessionId: string; session: { name: string; role: Role } };
    setSession({ sessionId: data.sessionId, name: data.session.name, role: data.session.role });
    return null;
  }, []);

  const signOut = useCallback(async () => {
    if (session) await panel.dispatch('auth/sign_out', {}, session.sessionId);
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
      const r = await panel.dispatch(type, payload, session?.sessionId);
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

/** Read a feed. It updates by itself after every change the panel makes. */
export function useFeed<K extends FeedName>(name: K, params: FeedMap[K]['params'], enabled = true): FeedState<K> {
  const { session } = usePanelState();
  const key = JSON.stringify(params);
  const [state, setState] = useState<FeedState<K>>({ data: null, error: null, loading: true });

  useEffect(() => {
    if (!enabled) return;
    setState((s) => ({ ...s, loading: s.data === null }));
    return panel.subscribe(name, JSON.parse(key) as FeedMap[K]['params'], session?.sessionId, (r) => {
      setState(r.ok ? { data: r.data, error: null, loading: false } : { data: null, error: r.error.messages[0] ?? 'Could not load.', loading: false });
    });
  }, [name, key, session?.sessionId, enabled]);

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
