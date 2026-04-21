import React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFormField } from './FormField';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Indeterminate visual (still controlled via `checked`). */
  indeterminate?: boolean;
  /** Optional label rendered inline to the right of the box. */
  label?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      className,
      indeterminate = false,
      label,
      disabled,
      id: idProp,
      'aria-describedby': ariaDescribedByProp,
      checked,
      defaultChecked,
      onChange,
      ...props
    },
    forwardedRef
  ) => {
    const field = useFormField();
    const localRef = React.useRef<HTMLInputElement | null>(null);
    const autoId = React.useId();

    const id = idProp ?? field?.id ?? autoId;
    const effectiveDisabled = disabled ?? field?.disabled ?? false;
    const describedBy =
      [ariaDescribedByProp, field?.hintId, field?.errorId].filter(Boolean).join(' ') || undefined;

    const setRef = (el: HTMLInputElement | null) => {
      localRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
    };

    React.useEffect(() => {
      if (localRef.current) localRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <span className={cn('inline-flex items-center gap-2', effectiveDisabled && 'opacity-50')}>
        <span className="relative inline-flex h-4 w-4 shrink-0">
          <input
            ref={setRef}
            id={id}
            type="checkbox"
            checked={checked}
            defaultChecked={defaultChecked}
            disabled={effectiveDisabled}
            aria-describedby={describedBy}
            onChange={onChange}
            className={cn(
              'peer h-4 w-4 cursor-pointer appearance-none rounded-sm border border-border bg-surface',
              'checked:bg-primary checked:border-primary indeterminate:bg-primary indeterminate:border-primary',
              'hover:border-border-strong',
              'focus-visible:outline-none focus-visible:shadow-focus',
              'disabled:cursor-not-allowed',
              'transition-colors duration-fast',
              className
            )}
            {...props}
          />
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center justify-center text-primary-fg',
              'opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100'
            )}
          >
            {indeterminate ? <Minus className="h-3 w-3" strokeWidth={3} /> : <Check className="h-3 w-3" strokeWidth={3} />}
          </span>
        </span>
        {label && (
          <label htmlFor={id} className="text-body cursor-pointer select-none">
            {label}
          </label>
        )}
      </span>
    );
  }
);
Checkbox.displayName = 'Checkbox';
