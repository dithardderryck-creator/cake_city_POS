import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Client, ClientResult, ConnectionState, FeedMap, FeedName, IntentMap, IntentName, SessionInfo, SignInResult } from './index';

const Ctx = createContext<Client | null>(null);

export function ClientProvider({ client, children }: { client: Client; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useClient(): Client {
  const c = useContext(Ctx);
  if (!c) throw new Error('useClient must be used inside <ClientProvider>.');
  return c;
}

export interface SessionState {
  status: 'loading' | 'signedOut' | 'signedIn';
  session: SessionInfo | null;
  signIn: (userId: string, pin: string) => Promise<SignInResult>;
  signOut: () => Promise<{ serverEnded: boolean }>;
}

/** Who is signed in. Restores a saved sign-in on load and drops it the moment the server ends it. */
export function useSession(): SessionState {
  const client = useClient();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionState['status']>('loading');

  useEffect(() => {
    let alive = true;
    client.restore().then((s) => {
      if (!alive) return;
      setSession(s);
      setStatus(s ? 'signedIn' : 'signedOut');
    });
    // If the server ends the sign-in while someone is working, any feed that notices updates this.
    const off = client.onSignedOut(() => {
      setSession(null);
      setStatus('signedOut');
    });
    return () => {
      alive = false;
      off();
    };
  }, [client]);

  const signIn = useCallback(
    async (userId: string, pin: string) => {
      const r = await client.signIn(userId, pin);
      if (r.ok) {
        setSession(r.session);
        setStatus('signedIn');
      }
      return r;
    },
    [client],
  );
  const signOut = useCallback(() => {
    // The screen goes to signed-out at once; the server is told in the background.
    setSession(null);
    setStatus('signedOut');
    return client.signOut();
  }, [client]);

  return useMemo(() => ({ status, session, signIn, signOut }), [status, session, signIn, signOut]);
}

export interface FeedState<K extends FeedName> {
  data: FeedMap[K]['data'] | null;
  error: string | null;
  loading: boolean;
  /** True while the connection is down: the data shown is the last that arrived, not necessarily current. */
  stale: boolean;
}

/** Live data for a screen. It updates by itself whenever anyone changes something. */
export function useFeed<K extends FeedName>(name: K, params: FeedMap[K]['params'], enabled = true): FeedState<K> {
  const client = useClient();
  const key = JSON.stringify(params);
  const [state, setState] = useState<Omit<FeedState<K>, 'stale'>>({ data: null, error: null, loading: true });
  const connection = useConnection();

  useEffect(() => {
    if (!enabled) return;
    setState((s) => ({ ...s, loading: s.data === null }));
    return client.subscribe(name, JSON.parse(key) as FeedMap[K]['params'], (r) => {
      setState(r.ok ? { data: r.data, error: null, loading: false } : { data: null, error: r.error.messages[0] ?? 'Could not load.', loading: false });
    });
  }, [client, name, key, enabled]);

  return { ...state, stale: connection === 'offline' && state.data !== null };
}

/** Send an instruction. You get the result back and decide what to show. */
export function useRun() {
  const client = useClient();
  return useCallback(<K extends IntentName>(type: K, payload: IntentMap[K]): Promise<ClientResult> => client.dispatch(type, payload), [client]);
}

export function useConnection(): ConnectionState {
  const client = useClient();
  const [s, setS] = useState<ConnectionState>(client.connection);
  useEffect(() => client.onConnection(setS), [client]);
  return s;
}
