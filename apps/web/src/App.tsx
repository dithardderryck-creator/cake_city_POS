import { useEffect, useState } from 'react';
import { Button, DesignDocs, EmptyState, StatusChip, Tabs } from '@cake-pos/design-system';
import type { ScreenId } from '@cake-pos/panel';
import { useFeed, useOnline, usePanelState } from './lib/panel';
import { SignIn } from './screens/SignIn';
import { Sell } from './screens/Sell';
import { Orders } from './screens/Orders';
import { Catalogue } from './screens/Catalogue';
import { Activity } from './screens/Activity';
import { PanelMap } from './screens/PanelMap';

function useHashRoute() {
  const read = () => (window.location.hash.startsWith('#/design') ? 'design' : 'app');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function Shell() {
  const { session, signOut } = usePanelState();
  const nav = useFeed('navigation', {});
  const online = useOnline();
  const [screen, setScreen] = useState<ScreenId | null>(null);
  const [draftOrderId, setDraftOrderId] = useState<string | null>(null);

  const items = nav.data ?? [];
  const current = items.find((i) => i.id === screen)?.id ?? items[0]?.id;

  return (
    <div className="app-shell">
      <header className="app-top">
        <span className="app-brand cp-display">Cake POS</span>
        <Tabs label="Screens" items={items} current={current ?? ''} onChange={(id) => setScreen(id as ScreenId)} />
        <div className="app-top__right">
          <StatusChip label={online ? 'Online' : 'Offline, saving here'} tone={online ? 'ready' : 'attention'} />
          <span className="app-user">{session?.name}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="app-main">
        {current === 'sell' && <Sell draftOrderId={draftOrderId} setDraftOrderId={setDraftOrderId} />}
        {current === 'orders' && <Orders />}
        {current === 'catalogue' && <Catalogue />}
        {current === 'audit' && <Activity />}
        {current === 'panel_map' && <PanelMap />}
        {!current && <EmptyState title="Nothing here for your role yet">Ask the owner what you should be able to see.</EmptyState>}
      </main>
      <footer className="app-foot">
        <a href="#/design">Design system</a>
      </footer>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const { ready, failed, session } = usePanelState();

  let body;
  if (route === 'design') {
    body = (
      <>
        <a className="app-back" href="#/">
          Back to the app
        </a>
        <DesignDocs />
      </>
    );
  } else if (failed) {
    body = (
      <EmptyState title="The shop data could not be opened">
        This browser blocked local storage. Turn off private browsing or allow site data, then reload.
      </EmptyState>
    );
  } else if (!ready) {
    body = (
      <div className="app-center">
        <p className="cp-muted">Opening the shop…</p>
      </div>
    );
  } else if (!session) {
    body = <SignIn />;
  } else {
    body = <Shell />;
  }

  return <div className="cp-root app-root">{body}</div>;
}
