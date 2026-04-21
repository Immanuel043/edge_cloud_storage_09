import React from 'react';
import { cn } from '@/lib/cn';

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  label?: string;
}

const sizeMap: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'h-3 w-3',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
};

/**
 * Token-aware loading spinner. Inherits `currentColor` so it tints with the
 * surrounding text color — primitives like Button pass it through unchanged.
 */
export const Spinner: React.FC<SpinnerProps> = ({ size = 'md', label = 'Loading', className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    role="status"
    aria-label={label}
    className={cn('animate-spin text-current', sizeMap[size], className)}
    {...props}
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
    <path
      d="M12 2a10 10 0 0 1 10 10"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      className="opacity-90"
    />
  </svg>
);
