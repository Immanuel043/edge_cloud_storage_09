import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import type { BillingCycle } from '../../types/pricing.types';

/**
 * BillingCycleToggle — compact monthly / 6-month / yearly segmented
 * control shown inside a PricingCard. Hides cycles that the plan doesn't
 * offer. Visual: pill tabs over `bg-surface-muted` with active `bg-primary`.
 */

export interface BillingCycleToggleProps {
  value: BillingCycle;
  onChange: (value: BillingCycle) => void;
  hasMonthly: boolean;
  hasSixMonths: boolean;
  hasYearly: boolean;
  className?: string;
}

const cycleOptions: { value: BillingCycle; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'six_months', label: '6 months' },
  { value: 'yearly', label: 'Yearly' },
];

export function BillingCycleToggle({
  value,
  onChange,
  hasMonthly,
  hasSixMonths,
  hasYearly,
  className,
}: BillingCycleToggleProps): ReactElement {
  const available = cycleOptions.filter((opt) => {
    if (opt.value === 'monthly') return hasMonthly;
    if (opt.value === 'six_months') return hasSixMonths;
    if (opt.value === 'yearly') return hasYearly;
    return false;
  });

  if (available.length <= 1) return <></>;

  return (
    <div
      role="radiogroup"
      aria-label="Billing cycle"
      className={cn('inline-flex gap-1 rounded-lg bg-surface-muted p-1', className)}
    >
      {available.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-caption font-medium transition-colors duration-fast',
              'focus-visible:outline-none focus-visible:shadow-focus',
              isActive
                ? 'bg-primary text-white shadow-sm'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default BillingCycleToggle;
