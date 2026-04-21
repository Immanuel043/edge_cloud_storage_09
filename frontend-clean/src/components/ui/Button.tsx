import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

/**
 * Button — Signal workhorse.
 *
 * Variants:
 *  - primary:     solid indigo, default CTA
 *  - secondary:   surface + border, neutral action
 *  - ghost:       transparent, low-emphasis
 *  - destructive: solid danger red, delete/remove
 *  - link:        inline text link
 *  - gradient:    signal-gradient SEAL — reserved for identity/upgrade/success
 *                 per DESIGN_TOKENS.md §1. Do NOT use as a default.
 */
export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 font-medium select-none whitespace-nowrap',
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
        ghost: 'bg-transparent text-fg hover:bg-surface-muted',
        destructive: 'bg-danger text-white hover:opacity-90 shadow-xs',
        link: 'bg-transparent text-primary underline-offset-4 hover:underline px-0 py-0 h-auto shadow-none',
        gradient:
          'bg-signal-gradient text-white shadow-md hover:shadow-glow transition-shadow duration-base',
      },
      size: {
        sm: 'h-8 px-3 text-body-sm',
        md: 'h-10 px-4 text-body',
        lg: 'h-12 px-5 text-body-lg',
      },
      fullWidth: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, fullWidth, loading, leftIcon, rightIcon, disabled, children, type, ...props },
    ref
  ) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        {...props}
      >
        {loading ? (
          <Spinner size={size === 'sm' ? 'xs' : 'sm'} />
        ) : (
          leftIcon && <span className="shrink-0" aria-hidden>{leftIcon}</span>
        )}
        {children != null && <span>{children}</span>}
        {!loading && rightIcon && (
          <span className="shrink-0" aria-hidden>{rightIcon}</span>
        )}
      </button>
    );
  }
);
Button.displayName = 'Button';
