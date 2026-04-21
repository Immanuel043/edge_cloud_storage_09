import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Progress — horizontal bar. Pass `value` / `max` for determinate, omit
 * `value` for indeterminate (continuously animated). Uses `role="progressbar"`.
 */

export const progressVariants = cva(['w-full overflow-hidden rounded-full bg-surface-muted'], {
  variants: {
    size: {
      sm: 'h-1',
      md: 'h-2',
      lg: 'h-3',
    },
    tone: {
      primary: '',
      success: '',
      warning: '',
      danger: '',
    },
  },
  defaultVariants: { size: 'md', tone: 'primary' },
});

const toneBar: Record<NonNullable<VariantProps<typeof progressVariants>['tone']>, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface ProgressProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>,
    VariantProps<typeof progressVariants> {
  value?: number;
  max?: number;
  /** Accessible label (falls back to aria-label). */
  label?: string;
}

export const Progress: React.FC<ProgressProps> = ({
  value,
  max = 100,
  size,
  tone,
  label,
  className,
  ...props
}) => {
  const indeterminate = value === undefined;
  const clamped = indeterminate ? 0 : Math.min(max, Math.max(0, value));
  const pct = indeterminate ? 30 : (clamped / max) * 100;
  const bar = toneBar[tone ?? 'primary'];

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : clamped}
      className={cn(progressVariants({ size, tone }), className)}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-base ease-out-expo',
          bar,
          indeterminate && 'animate-[progress-indeterminate_1.2s_ease-in-out_infinite]'
        )}
        style={{
          width: `${pct}%`,
          ...(indeterminate && { animationName: 'progress-indeterminate' }),
        }}
      />
      {indeterminate && (
        <style>{`@keyframes progress-indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }`}</style>
      )}
    </div>
  );
};
