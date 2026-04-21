import React from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  size?: 'sm' | 'md';
}

/**
 * Switch — accessible toggle built on a native button with role="switch".
 * Use this for binary settings ("Enable 2FA"). For form inputs that submit
 * with the form, prefer Checkbox.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onChange, size = 'md', className, disabled, ...props }, ref) => {
    const dims =
      size === 'sm'
        ? { track: 'h-4 w-7', thumb: 'h-3 w-3', on: 'translate-x-3', off: 'translate-x-0.5' }
        : { track: 'h-6 w-10', thumb: 'h-4 w-4', on: 'translate-x-5', off: 'translate-x-1' };

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex items-center rounded-full transition-colors duration-fast ease-out-expo',
          'focus-visible:outline-none focus-visible:shadow-focus',
          'disabled:opacity-50 disabled:pointer-events-none',
          dims.track,
          checked ? 'bg-primary' : 'bg-surface-sunken border border-border',
          className
        )}
        {...props}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block rounded-full bg-white shadow-sm transition-transform duration-fast ease-out-expo',
            dims.thumb,
            checked ? dims.on : dims.off
          )}
        />
      </button>
    );
  }
);
Switch.displayName = 'Switch';
