import React from 'react';
import { cn } from '@/lib/cn';
import { Drawer } from '@/components/ui';
import { SidebarBrand } from './SidebarBrand';

/**
 * Sidebar — structural layout container. Composes a branded header, a
 * scrollable nav area, and an optional footer (e.g. quota widget). Actual
 * NavItem list lives in the consuming page (Phase 4.1 wiring) — this file
 * only provides the frame.
 *
 * Desktop: fixed-width rail on the left. Collapsible (optional) to a narrow
 * icon-only rail.
 * Mobile: rendered inside a Drawer via AppShell.
 */

export interface SidebarProps {
  /** Nav tree rendered between header and footer. */
  children: React.ReactNode;
  /** Optional footer slot (quota widget, upgrade CTA). */
  footer?: React.ReactNode;
  /** Collapse to icon-only rail on desktop. */
  collapsed?: boolean | undefined;
  /** Called when the brand lockup is clicked (e.g. return to home). */
  onBrandClick?: (() => void) | undefined;
  /** Hide the brand lockup (useful for test fixtures). */
  hideBrand?: boolean | undefined;
  className?: string | undefined;
}

export const Sidebar: React.FC<SidebarProps> = ({
  children,
  footer,
  collapsed,
  onBrandClick,
  hideBrand,
  className,
}) => (
  <aside
    className={cn(
      'flex flex-col h-full bg-surface border-r border-border',
      collapsed ? 'w-16' : 'w-64',
      'transition-[width] duration-base ease-out-expo',
      className
    )}
  >
    {!hideBrand && <SidebarBrand collapsed={collapsed} onClick={onBrandClick} />}
    <nav
      className={cn('flex-1 min-h-0 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}
      aria-label="Primary"
    >
      {children}
    </nav>
    {footer && (
      <div
        className={cn(
          'shrink-0 border-t border-border',
          collapsed ? 'p-2' : 'p-4'
        )}
      >
        {footer}
      </div>
    )}
  </aside>
);

export interface MobileSidebarProps extends Omit<SidebarProps, 'collapsed'> {
  open: boolean;
  onClose: () => void;
}

/**
 * MobileSidebar — renders the Sidebar inside a left-side Drawer for
 * narrow viewports. AppShell wires this automatically.
 */
export const MobileSidebar: React.FC<MobileSidebarProps> = ({
  open,
  onClose,
  children,
  footer,
  onBrandClick,
  hideBrand,
}) => (
  <Drawer open={open} onClose={onClose} side="left" size="sm" hideCloseButton>
    <div className="-mx-6 -my-5 h-full">
      <Sidebar
        onBrandClick={onBrandClick}
        {...(hideBrand ? { hideBrand: true } : {})}
        {...(footer ? { footer } : {})}
      >
        {children}
      </Sidebar>
    </div>
  </Drawer>
);
