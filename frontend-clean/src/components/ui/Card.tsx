import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Card — container surface with three elevation options. Use in combination
 * with CardHeader / CardContent / CardFooter for layout.
 */

export const cardVariants = cva(
  ['rounded-xl border transition-colors duration-fast'],
  {
    variants: {
      variant: {
        bordered: 'border-border bg-surface',
        elevated: 'border-border bg-surface-elevated shadow-md',
        ghost: 'border-transparent bg-transparent',
      },
      interactive: {
        true: 'hover:border-border-strong hover:shadow-md cursor-pointer',
        false: '',
      },
    },
    defaultVariants: { variant: 'bordered', interactive: false },
  }
);

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof cardVariants> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, interactive, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant, interactive }), className)} {...props} />
  )
);
Card.displayName = 'Card';

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('flex flex-col gap-1 px-6 py-4 border-b border-border', className)} {...props} />;

export const CardTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({
  className,
  ...props
}) => <h3 className={cn('text-h3 text-fg', className)} {...props} />;

export const CardDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  className,
  ...props
}) => <p className={cn('text-body-sm text-fg-muted', className)} {...props} />;

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('px-6 py-5', className)} {...props} />;

export const CardFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div
    className={cn('flex items-center justify-end gap-2 px-6 py-3 border-t border-border', className)}
    {...props}
  />
);
