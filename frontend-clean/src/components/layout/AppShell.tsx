import React, { createContext, useCallback, useContext, useState } from 'react';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui';

/**
 * AppShell — page-level frame composed of:
 *
 *   ┌─────────────────────────────────────┐
 *   │ Sidebar │ TopBar                     │
 *   │         ├────────────────────────────┤
 *   │         │ Content                    │
 *   │         │                            │
 *   └─────────────────────────────────────┘
 *
 * Sidebar is pinned on desktop and drawer-driven on mobile. Use
 * `AppShell.Sidebar`, `AppShell.TopBar`, `AppShell.Content` as slots.
 *
 * Mobile drawer state is owned by the shell and exposed via `useAppShell()`
 * so a TopBar can render the hamburger without prop-drilling.
 */

interface AppShellContextValue {
  mobileOpen: boolean;
  toggleMobile: () => void;
  closeMobile: () => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export const useAppShell = (): AppShellContextValue => {
  const ctx = useContext(AppShellContext);
  if (!ctx) throw new Error('useAppShell must be used inside <AppShell>');
  return ctx;
};

export interface AppShellProps {
  /** Desktop sidebar node. Hidden on < lg breakpoints — consume `mobileOpen`
   *  from context to render a `<MobileSidebar>` copy if needed. */
  sidebar: React.ReactNode;
  /** Mobile drawer sidebar node. Typically `<MobileSidebar open={...} ... />`. */
  mobileSidebar?: React.ReactNode;
  /** Top bar node — rendered above content on every breakpoint. */
  topBar?: React.ReactNode;
  /** Main page content. */
  children: React.ReactNode;
  className?: string;
}

const AppShellRoot: React.FC<AppShellProps> = ({
  sidebar,
  mobileSidebar,
  topBar,
  children,
  className,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleMobile = useCallback(() => setMobileOpen((v) => !v), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <AppShellContext.Provider value={{ mobileOpen, toggleMobile, closeMobile }}>
      <div className={cn('flex min-h-screen bg-bg text-fg', className)}>
        {/* Desktop sidebar — hidden on narrow viewports. */}
        <div className="hidden lg:flex shrink-0">{sidebar}</div>

        {/* Mobile drawer sidebar. */}
        {mobileSidebar}

        {/* Main column: top bar + scrollable content. */}
        <div className="flex-1 min-w-0 flex flex-col">
          {topBar}
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </div>
    </AppShellContext.Provider>
  );
};

/** Hamburger button that opens the mobile sidebar drawer. Hidden ≥ lg. */
export const MobileMenuButton: React.FC<{ className?: string }> = ({ className }) => {
  const { toggleMobile } = useAppShell();
  return (
    <IconButton
      variant="ghost"
      size="sm"
      aria-label="Open navigation menu"
      onClick={toggleMobile}
      className={cn('lg:hidden', className)}
    >
      <Menu />
    </IconButton>
  );
};

/** A standard content wrapper — applies horizontal padding + max-width. */
export const ContentContainer: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('px-4 py-6 lg:px-6', className)} {...props}>
    {children}
  </div>
);

export const AppShell = AppShellRoot;
