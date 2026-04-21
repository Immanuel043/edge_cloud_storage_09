import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

/**
 * IconButton — square button for a single icon. Requires `aria-label` or
 * `title`. Variants mirror Button minus `link` and `gradient` (gradient on a
 * 40px square would waste the seal — use a Button for gradient CTAs).
 */
export const iconButtonVariants = cva(
  [
    'inline-flex items-center justify-center shrink-0',
    'rounded-lg transition-colors duration-fast ease-out-expo',
    'focus-visible:outline-none focus-visible:shadow-focus',
    'disabled:opacity-50 disabled:pointer-events-none',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg hover:bg-primary-hover shadow-xs',
        secondary:
          'bg-surface text-fg border border-border hover:bg-surface-muted hover:border-border-strong shadow-xs',
        ghost: 'bg-transparent text-fg-muted hover:bg-surface-muted hover:text-fg',
        destructive: 'bg-transparent text-danger hover:bg-danger-soft',
      },
      size: {
        sm: 'h-8 w-8 [&>svg]:h-4 [&>svg]:w-4',
        md: 'h-10 w-10 [&>svg]:h-5 [&>svg]:w-5',
        lg: 'h-12 w-12 [&>svg]:h-6 [&>svg]:w-6',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  }
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  loading?: boolean;
  'aria-label': string; // required for a11y
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, loading, disabled, children, type, ...props }, ref) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? <Spinner size={size === 'sm' ? 'xs' : 'sm'} /> : children}
      </button>
    );
  }
);
IconButton.displayName = 'IconButton';
