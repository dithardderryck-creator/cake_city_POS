import { useState } from 'react';
import { Button, EmptyState, Note, OptionChips, Sheet, StatusChip, TextField } from '@cake-pos/design-system';
import type { Role } from '@cake-pos/panel';
import { useFeed, useRun } from '../lib/panel';

const ROLES: { id: Role; label: string }[] = [
  { id: 'cashier', label: 'Cashier' },
  { id: 'baker', label: 'Baker' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'owner', label: 'Owner' },
  { id: 'it', label: 'IT' },
];

function PinSheet({ title, onSubmit, onClose }: { title: string; onSubmit: (pin: string) => Promise<string | null>; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open title={title} onClose={onClose}>
      <div className="cp-stack">
        <TextField label="New PIN" hint="4 to 6 digits" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))} error={error} />
        <Button
          size="lg"
          block
          loading={busy}
          disabled={pin.length < 4}
          onClick={async () => {
            setBusy(true);
            const problem = await onSubmit(pin);
            setBusy(false);
            if (problem) setError(problem);
            else onClose();
          }}
        >
          Save PIN
        </Button>
      </div>
    </Sheet>
  );
}

/** Change your own PIN. Needs the current one, and signs your other devices out. */
export function ChangeMyPin({ onClose }: { onClose: () => void }) {
  const run = useRun();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  return (
    <Sheet open title="Change my PIN" onClose={onClose}>
      <div className="cp-stack">
        <TextField label="Current PIN" type="password" inputMode="numeric" autoComplete="off" value={current} onChange={(v) => setCurrent(digits(v))} />
        <TextField label="New PIN" hint="4 to 6 digits. Your other devices will be signed out." type="password" inputMode="numeric" autoComplete="off" value={next} onChange={(v) => setNext(digits(v))} />
        {error && <Note tone="danger">{error}</Note>}
        <Button
          size="lg"
          block
          loading={busy}
          disabled={current.length < 4 || next.length < 4}
          onClick={async () => {
            setBusy(true);
            const r = await run('auth/change_pin', { currentPin: current, newPin: next }, { inlineErrors: true });
            setBusy(false);
            if (r.ok) onClose();
            else setError(r.error.messages.join(' '));
          }}
        >
          Change PIN
        </Button>
      </div>
    </Sheet>
  );
}

export function Staff() {
  const list = useFeed('staff_list', {});
  const run = useRun();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<{ id: string; name: string } | null>(null);

  const add = async () => {
    setBusy(true);
    const r = await run('staff/create', { name, role, pin }, { inlineErrors: true });
    setBusy(false);
    if (r.ok) {
      setName('');
      setPin('');
      setError(null);
    } else setError(r.error.messages.join(' '));
  };

  return (
    <div className="cp-stack" style={{ gap: 'var(--cp-space-5)' }}>
      <h1 className="cp-display app-title" style={{ margin: 0 }}>
        Staff
      </h1>

      {list.error && <Note tone="danger">{list.error}</Note>}
      {list.data && list.data.length === 0 && <EmptyState title="No staff yet">Add the first person below.</EmptyState>}
      <ul className="app-plain cp-card cp-card--flush">
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="app-activity" style={{ gridTemplateColumns: '1fr auto' }}>
            <span>
              <strong>{s.name}</strong> <span className="cp-muted">{ROLES.find((r) => r.id === s.role)?.label}</span>
            </span>
            <span className="app-chips">
              {s.locked && <StatusChip label="Locked out" tone="danger" />}
              {!s.active && <StatusChip label="Switched off" tone="muted" />}
              <Button size="sm" variant="soft" onClick={() => setResetFor({ id: s.id, name: s.name })}>
                Reset PIN
              </Button>
              <Button size="sm" variant="ghost" onClick={() => run('staff/set_active', { userId: s.id, active: !s.active })}>
                {s.active ? 'Switch off' : 'Switch on'}
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <section className="cp-card cp-stack" aria-label="Add someone">
        <h2 className="cp-display" style={{ margin: 0, fontSize: 'var(--cp-text-lg)' }}>
          Add someone
        </h2>
        <TextField label="Name" value={name} onChange={setName} />
        <OptionChips label="Role" value={role} onChange={(id) => setRole(id as Role)} options={ROLES} />
        <TextField label="PIN" hint="4 to 6 digits" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))} />
        {error && <Note tone="danger">{error}</Note>}
        <Button loading={busy} disabled={!name.trim() || pin.length < 4} onClick={add}>
          Add person
        </Button>
      </section>

      {resetFor && (
        <PinSheet
          title={`Reset PIN for ${resetFor.name}`}
          onClose={() => setResetFor(null)}
          onSubmit={async (p) => {
            const r = await run('staff/set_pin', { userId: resetFor.id, pin: p }, { inlineErrors: true });
            return r.ok ? null : r.error.messages.join(' ');
          }}
        />
      )}
    </div>
  );
}
