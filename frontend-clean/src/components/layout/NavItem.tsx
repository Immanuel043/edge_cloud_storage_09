import React from 'react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui';

/**
 * NavItem — sidebar nav entry (or any vertical nav list).
 * Pass `active` for the selected state; otherwise a hover + focus ring applies.
 *
 *   <NavItem icon={<Cloud />} label="Cloud Drive" active={view === 'cloud'} onClick={...} />
 */

export interface NavItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: React.ReactNode;
  label: React.ReactNode;
  /** Hint rendered as a native title tooltip on hover. */
  description?: string;
  active?: boolean;
  /** Optional trailing badge (count, NEW flag, etc.). */
  badge?: React.ReactNode;
  /** Indent (for sub-items in an expanded section). */
  nested?: boolean;
  /** Collapsed variant: only icon + tooltip visible (rail). */
  collapsed?: boolean;
}

export const NavItem = React.forwardRef<HTMLButtonElement, NavItemProps>(
  (
    { icon, label, description, active, badge, nested, collapsed, className, ...props },
    ref
  ) => (
    <button
      ref={ref}
      type="button"
      title={description ?? (typeof label === 'string' ? label : undefined)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg text-body-sm font-medium w-full',
        'transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:shadow-focus',
        collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2',
        nested && !collapsed && 'pl-10',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-fg-muted hover:bg-surface-muted hover:text-fg',
        className
      )}
      {...props}
    >
      {/* Active edge marker (left of item) */}
      {active && !collapsed && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
        />
      )}
      {icon && (
        <span
          aria-hidden
          className={cn(
            'shrink-0 flex items-center justify-center',
            '[&>svg]:h-5 [&>svg]:w-5',
            active ? 'text-primary' : 'text-fg-subtle group-hover:text-fg-muted'
          )}
        >
          {icon}
        </span>
      )}
      {!collapsed && <span className="flex-1 truncate text-left">{label}</span>}
      {!collapsed && badge != null && (
        <span className="shrink-0">
          {typeof badge === 'string' || typeof badge === 'number' ? (
            <Badge size="sm" variant={active ? 'info' : 'neutral'}>
              {badge}
            </Badge>
          ) : (
            badge
          )}
        </span>
      )}
    </button>
  )
);
NavItem.displayName = 'NavItem';

/** Wraps a group of NavItems with a section label (top-of-group caption). */
export interface NavSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  collapsed?: boolean;
}

export const NavSection: React.FC<NavSectionProps> = ({
  label,
  collapsed,
  className,
  children,
  ...props
}) => (
  <div className={cn('flex flex-col gap-0.5', className)} {...props}>
    {label && !collapsed && (
      <div className="px-3 pt-4 pb-1 text-caption font-semibold text-fg-subtle uppercase tracking-wide">
        {label}
      </div>
    )}
    {children}
  </div>
);
