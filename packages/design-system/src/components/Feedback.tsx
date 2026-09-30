import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}

/** Label, hint and error wired to their control so screen readers announce them together. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [hint && hintId, error && errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="cp-field" data-invalid={!!error || undefined}>
      <label className="cp-field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <span id={hintId} className="cp-field__hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={errId} className="cp-field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChange: (value: string) => void;
}

export function TextField({ label, hint, error, value, onChange, ...rest }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(a11y) => <input {...rest} {...a11y} className="cp-input" value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cp-empty">
      <h3 className="cp-empty__title">{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Note({ tone = 'attention', children }: { tone?: 'attention' | 'danger'; children: ReactNode }) {
  return (
    <div className={`cp-note${tone === 'danger' ? ' cp-note--danger' : ''}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export interface ToastItem {
  id: number;
  text: string;
  tone?: 'info' | 'warning' | 'error';
}

/** Polite live region. Toasts say what happened in the same words as the action that caused them. */
export function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="cp-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`cp-toast${t.tone && t.tone !== 'info' ? ` cp-toast--${t.tone}` : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
}

export function Tabs({ items, current, onChange, label }: { items: TabItem[]; current: string; onChange: (id: string) => void; label: string }) {
  return (
    <nav aria-label={label} className="cp-tabs">
      {items.map((t) => (
        <button key={t.id} type="button" className="cp-tab" aria-current={t.id === current ? 'page' : undefined} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
