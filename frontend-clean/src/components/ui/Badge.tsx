import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Badge — compact pill for status, plan tier, file-type, counts. Use `dot`
 * variant for a leading indicator (live/offline states).
 */

export const badgeVariants = cva(
  ['inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap'],
  {
    variants: {
      variant: {
        neutral: 'bg-surface-muted text-fg-muted',
        info: 'bg-primary/10 text-primary',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
        danger: 'bg-danger/10 text-danger',
        accent: 'bg-accent/10 text-accent',
        outline: 'border border-border text-fg-muted bg-transparent',
      },
      size: {
        sm: 'h-5 px-2 text-[0.6875rem]',
        md: 'h-6 px-2.5 text-caption',
        lg: 'h-7 px-3 text-body-sm',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'md' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Show a leading colored dot indicator. */
  dot?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant,
  size,
  dot,
  children,
  ...props
}) => (
  <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
    {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
    {children}
  </span>
);
