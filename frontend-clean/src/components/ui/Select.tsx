import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { useFormField } from './FormField';

export const selectVariants = cva(
  [
    'flex w-full rounded-lg bg-surface text-fg',
    'border transition-colors duration-fast appearance-none',
    'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-border-focus',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface-muted',
    // leave space for the chevron glyph on the right
    'pr-10',
  ],
  {
    variants: {
      invalid: {
        true: 'border-danger focus-visible:border-danger focus-visible:shadow-[0_0_0_3px_rgb(var(--danger)/0.25)]',
        false: 'border-border hover:border-border-strong',
      },
      size: {
        sm: 'h-8 pl-3 text-body-sm',
        md: 'h-10 pl-3.5 text-body',
        lg: 'h-12 pl-4 text-body-lg',
      },
    },
    defaultVariants: { invalid: false, size: 'md' },
  }
);

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    Pick<VariantProps<typeof selectVariants>, 'size'> {
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      className,
      size = 'md',
      invalid,
      disabled,
      id: idProp,
      'aria-describedby': ariaDescribedByProp,
      children,
      ...props
    },
    ref
  ) => {
    const field = useFormField();
    const id = idProp ?? field?.id;
    const effectiveInvalid = invalid ?? field?.invalid ?? false;
    const effectiveDisabled = disabled ?? field?.disabled ?? false;
    const describedBy =
      [ariaDescribedByProp, field?.hintId, field?.errorId].filter(Boolean).join(' ') || undefined;

    return (
      <div className="relative">
        <select
          ref={ref}
          id={id}
          disabled={effectiveDisabled}
          aria-invalid={effectiveInvalid || undefined}
          aria-describedby={describedBy}
          className={cn(selectVariants({ invalid: effectiveInvalid, size }), className)}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-subtle',
            size === 'sm' ? 'right-2.5 h-4 w-4' : size === 'lg' ? 'right-3.5 h-5 w-5' : 'right-3 h-4 w-4'
          )}
        />
      </div>
    );
  }
);
Select.displayName = 'Select';
