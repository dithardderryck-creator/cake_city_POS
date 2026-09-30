import { useRef, type KeyboardEvent } from 'react';

export type Tone = 'neutral' | 'attention' | 'ready' | 'done' | 'muted' | 'danger';

/** Read-only status. The label carries the meaning; colour only reinforces it. */
export function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <span className={`cp-status${tone === 'neutral' ? '' : ` cp-status--${tone}`}`}>{label}</span>;
}

export interface ChoiceOption {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface OptionChipsProps {
  /** Names the group for screen readers, for example "Size". */
  label: string;
  options: ChoiceOption[];
  value: string | null;
  onChange: (id: string) => void;
  variant?: 'chips' | 'segmented';
}

/** One choice out of a few. A radio group underneath, so arrow keys move the selection. */
export function OptionChips({ label, options, value, onChange, variant = 'chips' }: OptionChipsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((o) => !o.disabled);

  const onKey = (e: KeyboardEvent, index: number) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    for (let step = 1; step <= options.length; step++) {
      const next = (index + dir * step + options.length * step) % options.length;
      if (!options[next]!.disabled) {
        onChange(options[next]!.id);
        refs.current[next]?.focus();
        return;
      }
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className={variant === 'segmented' ? 'cp-segmented' : 'cp-chipset'}>
      {options.map((o, i) => {
        const checked = value === o.id;
        // Roving tabindex: only the selected (or first enabled) chip is in the tab order.
        const tabbable = checked || (value === null && enabled[0]?.id === o.id);
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={tabbable ? 0 : -1}
            disabled={o.disabled}
            className="cp-chip"
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
