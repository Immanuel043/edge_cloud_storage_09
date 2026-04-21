import React from 'react';
import { Cloud } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * SidebarBrand — the Edge Cloud lockup that sits at the top of the sidebar.
 * Uses the Signal gradient (per DESIGN_TOKENS.md §1) on the icon tile. When
 * `collapsed`, only the gradient tile is shown.
 */

export interface SidebarBrandProps {
  collapsed?: boolean | undefined;
  onClick?: (() => void) | undefined;
  className?: string | undefined;
}

export const SidebarBrand: React.FC<SidebarBrandProps> = ({
  collapsed,
  onClick,
  className,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'flex items-center gap-3 px-4 py-4 w-full',
      'focus-visible:outline-none focus-visible:shadow-focus rounded-lg',
      className
    )}
    aria-label="Edge Cloud home"
  >
    <span
      aria-hidden
      className="shrink-0 p-2 rounded-xl shadow-md"
      style={{ background: 'var(--signal-gradient)' }}
    >
      <Cloud className="h-6 w-6 text-white" strokeWidth={2.25} />
    </span>
    {!collapsed && (
      <span className="flex flex-col items-start min-w-0">
        <span className="text-body font-semibold text-fg leading-tight">Edge Cloud</span>
        <span className="text-caption text-fg-subtle leading-tight">Storage</span>
      </span>
    )}
  </button>
);
