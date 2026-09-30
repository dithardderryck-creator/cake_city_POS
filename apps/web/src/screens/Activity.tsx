import { EmptyState, Note, StatusChip, type Tone } from '@cake-pos/design-system';
import { useFeed } from '../lib/panel';

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  ok: { label: 'Done', tone: 'ready' },
  denied: { label: 'Blocked', tone: 'danger' },
  invalid: { label: 'Rejected', tone: 'attention' },
  error: { label: 'Error', tone: 'danger' },
};

const when = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Activity() {
  const feed = useFeed('audit_view', {});
  return (
    <div className="cp-stack">
      <h1 className="cp-display app-title" style={{ margin: 0 }}>
        Activity
      </h1>
      <p className="cp-muted">Everything anyone did or tried to do, newest first. Blocked and rejected attempts are here too.</p>
      {feed.error && <Note tone="danger">{feed.error}</Note>}
      {feed.data && feed.data.length === 0 && <EmptyState title="Nothing yet">Actions will appear here as staff work.</EmptyState>}
      <ul className="app-plain cp-card cp-card--flush">
        {(feed.data ?? []).map((a) => {
          const o = OUTCOME[a.outcome] ?? OUTCOME.ok!;
          return (
            <li key={a.id} className="app-activity">
              <span className="cp-muted app-when">{when(a.at)}</span>
              <span>
                <strong>{a.who}</strong> <span className="cp-muted">{a.role ?? ''}</span>
                <br />
                {a.summary}
              </span>
              <StatusChip label={o.label} tone={o.tone} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
