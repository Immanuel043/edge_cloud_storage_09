import React from 'react';
import { cn } from '@/lib/cn';

/**
 * EmptyState — standardized "nothing here yet" presentation. Icon + title +
 * description + optional action slot. Use for Trash, Favorites, search with
 * zero results, unpopulated tabs.
 */

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Visual density. Default `md`. */
  size?: 'sm' | 'md' | 'lg';
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  size = 'md',
  className,
  ...props
}) => {
  const padding = size === 'sm' ? 'py-8' : size === 'lg' ? 'py-20' : 'py-12';
  const iconSize = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-14 w-14' : 'h-10 w-10';
  const titleClass = size === 'sm' ? 'text-body font-medium' : size === 'lg' ? 'text-h2' : 'text-h3';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6',
        padding,
        className
      )}
      {...props}
    >
      {icon && (
        <div
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-full bg-surface-muted text-fg-subtle mb-4',
            iconSize === 'h-8 w-8' ? 'p-2' : iconSize === 'h-14 w-14' ? 'p-4' : 'p-3'
          )}
        >
          <span className={cn('[&>svg]:w-full [&>svg]:h-full', iconSize)}>{icon}</span>
        </div>
      )}
      <p className={cn(titleClass, 'text-fg')}>{title}</p>
      {description && (
        <p className="mt-2 max-w-md text-body-sm text-fg-muted">{description}</p>
      )}
      {action && <div className="mt-6 flex items-center gap-2">{action}</div>}
    </div>
  );
};
