import React, { createContext, useContext, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Radio — two-part API:
 *
 *   <RadioGroup name="plan" value={plan} onChange={setPlan}>
 *     <Radio value="free" label="Free" />
 *     <Radio value="pro"  label="Pro"  />
 *   </RadioGroup>
 *
 * Radios can also be used standalone with raw input props, but RadioGroup is
 * the ergonomic path.
 */

interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  onChange: ((next: string) => void) | undefined;
  disabled: boolean | undefined;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps {
  name?: string;
  value?: string;
  onChange?: (next: string) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const RadioGroup: React.FC<RadioGroupProps> = ({
  name: nameProp,
  value,
  onChange,
  disabled,
  className,
  children,
}) => {
  const fallbackName = useId();
  const name = nameProp ?? fallbackName;
  return (
    <RadioGroupContext.Provider value={{ name, value, onChange, disabled }}>
      <div role="radiogroup" className={cn('flex flex-col gap-2', className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
};

export interface RadioProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'onChange' | 'value'> {
  value: string;
  label?: React.ReactNode;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(
  ({ value, label, className, disabled, id: idProp, checked: checkedProp, ...props }, ref) => {
    const group = useContext(RadioGroupContext);
    const autoId = useId();
    const id = idProp ?? autoId;

    const checked = group ? group.value === value : checkedProp;
    const isDisabled = disabled ?? group?.disabled ?? false;

    return (
      <span className={cn('inline-flex items-center gap-2', isDisabled && 'opacity-50')}>
        <span className="relative inline-flex h-4 w-4 shrink-0">
          <input
            ref={ref}
            id={id}
            type="radio"
            name={group?.name ?? props.name}
            value={value}
            checked={checked}
            disabled={isDisabled}
            onChange={() => group?.onChange?.(value)}
            className={cn(
              'peer h-4 w-4 cursor-pointer appearance-none rounded-full border border-border bg-surface',
              'checked:border-primary',
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
            className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 peer-checked:opacity-100 transition-opacity duration-fast"
          >
            <span className="h-2 w-2 rounded-full bg-primary" />
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
Radio.displayName = 'Radio';
