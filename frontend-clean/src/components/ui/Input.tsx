import React, { useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFormField } from './FormField';

export const inputVariants = cva(
  [
    'flex w-full rounded-lg bg-surface text-fg placeholder:text-fg-subtle',
    'border transition-colors duration-fast',
    'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-border-focus',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface-muted',
  ],
  {
    variants: {
      invalid: {
        true: 'border-danger focus-visible:border-danger focus-visible:shadow-[0_0_0_3px_rgb(var(--danger)/0.25)]',
        false: 'border-border hover:border-border-strong',
      },
      size: {
        sm: 'h-8 text-body-sm',
        md: 'h-10 text-body',
        lg: 'h-12 text-body-lg',
      },
    },
    defaultVariants: { invalid: false, size: 'md' },
  }
);

type InputSize = NonNullable<VariantProps<typeof inputVariants>['size']>;

// Per-size horizontal padding depending on which addon slots are occupied.
const paddingByAddons = (
  size: InputSize,
  hasLeft: boolean,
  hasRight: boolean
): string => {
  const base = { sm: ['pl-3', 'pr-3'], md: ['pl-3.5', 'pr-3.5'], lg: ['pl-4', 'pr-4'] }[size];
  return cn(hasLeft ? { sm: 'pl-9', md: 'pl-10', lg: 'pl-12' }[size] : base[0], hasRight ? { sm: 'pr-9', md: 'pr-10', lg: 'pr-12' }[size] : base[1]);
};

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    Pick<VariantProps<typeof inputVariants>, 'size'> {
  /** Content rendered inside the left addon slot (icon or short text). */
  leftAddon?: React.ReactNode;
  /** Content rendered inside the right addon slot. Hidden when `passwordReveal` is used. */
  rightAddon?: React.ReactNode;
  /** If true, renders an eye toggle that flips type between password and text. */
  passwordReveal?: boolean;
  /** Override invalid state (otherwise inherited from FormField). */
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      size = 'md',
      type = 'text',
      leftAddon,
      rightAddon,
      passwordReveal,
      invalid,
      disabled,
      id: idProp,
      'aria-describedby': ariaDescribedByProp,
      ...props
    },
    ref
  ) => {
    const field = useFormField();
    const [showPassword, setShowPassword] = useState(false);

    const effectiveSize: InputSize = size ?? 'md';
    const id = idProp ?? field?.id;
    const effectiveInvalid = invalid ?? field?.invalid ?? false;
    const effectiveDisabled = disabled ?? field?.disabled ?? false;
    const describedBy =
      [ariaDescribedByProp, field?.hintId, field?.errorId].filter(Boolean).join(' ') || undefined;

    const effectiveType = passwordReveal ? (showPassword ? 'text' : 'password') : type;

    const hasLeft = Boolean(leftAddon);
    const hasRight = Boolean(rightAddon) || Boolean(passwordReveal);

    const iconPadClass =
      effectiveSize === 'sm'
        ? { left: 'left-2.5', right: 'right-2.5' }
        : effectiveSize === 'lg'
        ? { left: 'left-3.5', right: 'right-3.5' }
        : { left: 'left-3', right: 'right-3' };

    return (
      <div className="relative">
        {hasLeft && (
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-subtle',
              iconPadClass.left,
              '[&>svg]:h-4 [&>svg]:w-4'
            )}
            aria-hidden
          >
            {leftAddon}
          </span>
        )}
        <input
          ref={ref}
          id={id}
          type={effectiveType}
          disabled={effectiveDisabled}
          aria-invalid={effectiveInvalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            inputVariants({ invalid: effectiveInvalid, size: effectiveSize }),
            paddingByAddons(effectiveSize, hasLeft, hasRight),
            className
          )}
          {...props}
        />
        {passwordReveal ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword((s) => !s)}
            className={cn(
              'absolute top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-focus rounded-sm transition-colors',
              iconPadClass.right,
              '[&>svg]:h-4 [&>svg]:w-4'
            )}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff /> : <Eye />}
          </button>
        ) : rightAddon ? (
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-subtle',
              iconPadClass.right,
              '[&>svg]:h-4 [&>svg]:w-4'
            )}
            aria-hidden
          >
            {rightAddon}
          </span>
        ) : null}
      </div>
    );
  }
);
Input.displayName = 'Input';
