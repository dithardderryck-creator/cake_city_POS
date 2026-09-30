import type { ReactNode } from 'react';
import { StatusChip, type Tone } from './Choice';

export interface LineRowProps {
  title: string;
  options?: string;
  allergens?: string[];
  qty: number;
  unitPriceLabel: string;
  totalLabel: string;
  statusLabel?: string;
  statusTone?: Tone;
  cancelled?: boolean;
  /** Buttons for the next steps. The panel decides which exist; this row only shows them. */
  actions?: ReactNode;
}

export function LineRow({ title, options, allergens, qty, unitPriceLabel, totalLabel, statusLabel, statusTone, cancelled, actions }: LineRowProps) {
  return (
    <li className="cp-line" data-cancelled={cancelled || undefined} style={{ listStyle: 'none' }}>
      <div>
        <div className="cp-line__title">{title}</div>
        {options && <div className="cp-muted">{options}</div>}
        {allergens && allergens.length > 0 && <div className="cp-muted">Contains {allergens.join(', ')}</div>}
        <div className="cp-muted">
          {qty} × {unitPriceLabel}
        </div>
      </div>
      <div className="cp-line__amount">{totalLabel}</div>
      {(statusLabel || actions) && (
        <div className="cp-line__actions">
          {statusLabel && <StatusChip label={statusLabel} tone={statusTone} />}
          {actions}
        </div>
      )}
    </li>
  );
}
