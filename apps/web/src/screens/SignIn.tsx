import { useState } from 'react';
import { Button, Keypad, Note, OptionChips, PinDots, type KeypadKey } from '@cake-pos/design-system';
import { DEMO_STAFF } from '@cake-pos/panel';
import { useFeed, usePanelState } from '../lib/panel';

export function SignIn() {
  const { signIn } = usePanelState();
  const staff = useFeed('staff_signin', {});
  const [who, setWho] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const press = (k: KeypadKey) => {
    setError(null);
    setPin((p) => (k === 'back' ? p.slice(0, -1) : /\d/.test(k) && p.length < 6 ? p + k : p));
  };

  const submit = async () => {
    if (!who) return;
    setBusy(true);
    const problem = await signIn(who, pin);
    setBusy(false);
    if (problem) {
      setError(problem);
      setPin('');
    }
  };

  return (
    <div className="app-center">
      <div className="cp-card app-signin cp-stack">
        <h1 className="cp-display app-title">Who is working?</h1>
        <OptionChips
          label="Staff member"
          value={who}
          onChange={(id) => {
            setWho(id);
            setError(null);
          }}
          options={(staff.data ?? []).map((s) => ({ id: s.id, label: s.name }))}
        />
        <div className="cp-stack" style={{ opacity: who ? 1 : 0.5 }}>
          <PinDots length={pin.length} max={Math.max(4, pin.length)} />
          <Keypad mode="pin" onKey={press} disabled={!who || busy} />
        </div>
        {error && <Note tone="danger">{error}</Note>}
        <Button size="lg" block disabled={!who || pin.length < 4} loading={busy} onClick={submit}>
          Sign in
        </Button>
        <Note>
          Demo mode. PINs: {DEMO_STAFF.map((s) => `${s.role} ${s.pin}`).join(', ')}.
        </Note>
      </div>
    </div>
  );
}
