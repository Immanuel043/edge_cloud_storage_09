import React from 'react';
import { cn } from '@/lib/cn';

/**
 * Skeleton — loading placeholder. Three shapes; pick whichever matches the
 * underlying content so layout doesn't jump on swap.
 */

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  shape?: 'text' | 'rect' | 'circle';
  /** Width as tailwind class (e.g. 'w-32'), px number, or CSS length. */
  width?: string | number;
  /** Height as tailwind class, px number, or CSS length. */
  height?: string | number;
}

const pickDim = (v: string | number | undefined): { cls?: string; style?: string } => {
  if (v === undefined) return {};
  if (typeof v === 'number') return { style: `${v}px` };
  if (v.startsWith('w-') || v.startsWith('h-')) return { cls: v };
  return { style: v };
};

export const Skeleton: React.FC<SkeletonProps> = ({
  shape = 'rect',
  width,
  height,
  className,
  style,
  ...props
}) => {
  const w = pickDim(width);
  const h = pickDim(height);
  const shapeClass =
    shape === 'circle' ? 'rounded-full' : shape === 'text' ? 'rounded h-3' : 'rounded-md';
  return (
    <div
      aria-hidden
      className={cn(
        'animate-pulse bg-surface-muted',
        shapeClass,
        w.cls,
        h.cls,
        className
      )}
      style={{
        width: w.style,
        height: h.style,
        ...style,
      }}
      {...props}
    />
  );
};
