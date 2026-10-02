import { Button, Note, StatusChip, type Tone } from '@cake-pos/design-system';
import { useFeed, useRun } from '../lib/panel';

const stateTone = (s: string): Tone => (s === 'connected' || s === 'online' ? 'ready' : s === 'offline' ? 'attention' : 'muted');

const since = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'No activity');

/** The circuit box: every circuit, every connection, and what is waiting to be sent. For IT. */
export function PanelMap() {
  const feed = useFeed('panel_map', {});
  const run = useRun();
  if (feed.error) return <Note tone="danger">{feed.error}</Note>;
  if (!feed.data) return <p className="cp-muted">Loading the panel map…</p>;
  const d = feed.data;

  return (
    <div className="cp-stack" style={{ gap: 'var(--cp-space-5)' }}>
      <div className="cp-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="cp-display app-title" style={{ margin: 0 }}>
            Panel map
          </h1>
          <p className="cp-muted" style={{ margin: 0 }}>
            {d.activeSessions} signed in on this device
          </p>
        </div>
        <Button variant="soft" onClick={() => run('sync/flush', {})}>
          Try sync now
        </Button>
      </div>

      <section aria-label="Circuits">
        <h2 className="cp-display" style={{ fontSize: 'var(--cp-text-lg)' }}>
          Circuits
        </h2>
        <div className="app-circuits">
          {d.circuits.map((c) => (
            <div key={c.name} className="cp-card cp-stack" style={{ gap: 4, opacity: c.status === 'planned' ? 0.7 : 1 }}>
              <div className="cp-row">
                <strong>{c.name}</strong>
                <StatusChip label={c.status === 'live' ? 'Live' : 'Planned'} tone={c.status === 'live' ? 'ready' : 'muted'} />
              </div>
              {c.status === 'live' ? (
                <>
                  <span className="cp-muted">
                    {c.handled} done, {c.denied} blocked, {c.invalid} rejected, {c.errors} errors
                  </span>
                  <span className="cp-muted">Last: {since(c.lastActivityAt)}</span>
                </>
              ) : (
                <span className="cp-muted">Not built yet</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Outbox">
        <h2 className="cp-display" style={{ fontSize: 'var(--cp-text-lg)' }}>
          Waiting to sync
        </h2>
        <div className="cp-card cp-row">
          <span>
            <strong>{d.outbox.pending}</strong> waiting
          </span>
          <span className="cp-muted">{d.outbox.sent} sent</span>
          <span className="cp-muted">{d.outbox.failed} failed</span>
        </div>
      </section>

      <section aria-label="Backups">
        <h2 className="cp-display" style={{ fontSize: 'var(--cp-text-lg)' }}>
          Backups
        </h2>
        <div className="cp-card cp-stack" style={{ gap: 4 }}>
          {d.backup ? (
            <>
              <span>
                {d.backup.lastOkAt ? `Last good backup: ${new Date(d.backup.lastOkAt).toLocaleString()}` : 'No backup has been taken yet.'}
              </span>
              {d.backup.pendingUploads > 0 && <span className="cp-muted">{d.backup.pendingUploads} waiting to reach the cloud copy</span>}
              {d.backup.lastError && <Note tone="danger">The last backup failed: {d.backup.lastError}</Note>}
            </>
          ) : (
            <span className="cp-muted">Backups are not set up on this server.</span>
          )}
        </div>
      </section>

      {d.system.length > 0 && (
        <section aria-label="This computer">
          <h2 className="cp-display" style={{ fontSize: 'var(--cp-text-lg)' }}>
            This computer
          </h2>
          <ul className="app-plain cp-card cp-card--flush">
            {d.system.map((x) => (
              <li key={x.label} className="app-activity" style={{ gridTemplateColumns: '10rem 1fr' }}>
                <span className="cp-muted">{x.label}</span>
                <span>{x.value}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Connections">
        <h2 className="cp-display" style={{ fontSize: 'var(--cp-text-lg)' }}>
          Connections
        </h2>
        <ul className="app-plain cp-card cp-card--flush">
          {d.terminals.map((t) => (
            <li key={t.name} className="app-activity" style={{ gridTemplateColumns: '1fr auto' }}>
              <span>{t.name}</span>
              <StatusChip label={t.state} tone={stateTone(t.state)} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
