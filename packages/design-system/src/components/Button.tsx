import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'soft' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', block, loading, className, disabled, children, ...rest }: ButtonProps) {
  const cls = [
    'cp-btn',
    variant !== 'primary' && `cp-btn--${variant}`,
    size !== 'md' && `cp-btn--${size}`,
    block && 'cp-btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      {...rest}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
    >
      {children}
    </button>
  );
}
