export interface ProductTileProps {
  name: string;
  meta?: string;
  priceLabel?: string | null;
  disabled?: boolean;
  /** Why it cannot be chosen, shown instead of the price and read out to screen readers. */
  disabledReason?: string | null;
  onClick?: () => void;
}

/** A catalogue product. The icing drip along the top is the shop's signature. */
export function ProductTile({ name, meta, priceLabel, disabled, disabledReason, onClick }: ProductTileProps) {
  return (
    <button
      type="button"
      className="cp-tile"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="cp-tile__name">{name}</span>
      {meta && <span className="cp-tile__meta">{meta}</span>}
      <span className="cp-tile__price">{disabled ? (disabledReason ?? 'Unavailable') : priceLabel ? `From ${priceLabel}` : 'No price yet'}</span>
    </button>
  );
}
