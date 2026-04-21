import React from 'react';
import { cn } from '@/lib/cn';

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

/**
 * Label — uses the `caption` type token from DESIGN_TOKENS.md. Pair with
 * FormField for auto-wired `htmlFor` / `id` / `aria-describedby`.
 */
export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, children, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 text-caption font-medium text-fg-muted',
        props['aria-disabled'] && 'opacity-50',
        className
      )}
      {...props}
    >
      {children}
      {required && (
        <span aria-hidden className="text-danger">
          *
        </span>
      )}
    </label>
  )
);
Label.displayName = 'Label';
