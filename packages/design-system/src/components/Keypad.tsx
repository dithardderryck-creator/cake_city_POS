export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back';

export interface KeypadProps {
  /** "pin" hides the decimal key. "amount" shows it. */
  mode: 'pin' | 'amount';
  onKey: (key: KeypadKey) => void;
  disabled?: boolean;
}

export function Keypad({ mode, onKey, disabled }: KeypadProps) {
  const digit = (d: string) => (
    <button key={d} type="button" className="cp-key" disabled={disabled} onClick={() => onKey(d as KeypadKey)}>
      {d}
    </button>
  );
  return (
    <div className="cp-keypad" role="group" aria-label={mode === 'pin' ? 'PIN keypad' : 'Amount keypad'}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit)}
      {mode === 'amount' ? (
        <button type="button" className="cp-key" disabled={disabled} onClick={() => onKey('.')} aria-label="Decimal point">
          .
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
      {digit('0')}
      <button type="button" className="cp-key" disabled={disabled} onClick={() => onKey('back')} aria-label="Delete last digit">
        ⌫
      </button>
    </div>
  );
}

/** Dots that fill as the PIN is typed. Announced as a count, never as the digits. */
export function PinDots({ length, max = 4 }: { length: number; max?: number }) {
  return (
    <div className="cp-pin-dots" role="img" aria-label={`${length} of ${max} digits entered`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className="cp-pin-dot" data-filled={i < length} />
      ))}
    </div>
  );
}
