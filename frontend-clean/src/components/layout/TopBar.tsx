import React from 'react';
import { cn } from '@/lib/cn';

/**
 * TopBar — sticky page header row. Structural only: all content comes from
 * slots so every page can compose its own mix of search/actions/user menu.
 *
 *   <TopBar
 *     leading={<MobileMenuButton />}
 *     center={<SearchBar />}
 *     trailing={[<ViewToggle />, <ThemeToggle />, <UserMenu />]}
 *   />
 */

export interface TopBarProps extends React.HTMLAttributes<HTMLElement> {
  /** Left side — typically a mobile menu button or brand lockup. */
  leading?: React.ReactNode;
  /** Center region — usually the search bar. Grows to fill space. */
  center?: React.ReactNode;
  /** Right side — action icons, user menu, etc. Rendered with gap-2. */
  trailing?: React.ReactNode;
  /** Disable the sticky position (use for modals/print views). */
  nonSticky?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  leading,
  center,
  trailing,
  nonSticky,
  className,
  ...props
}) => (
  <header
    className={cn(
      'z-30 border-b border-border bg-surface/80 backdrop-blur-md',
      !nonSticky && 'sticky top-0',
      className
    )}
    {...props}
  >
    <div className="flex items-center gap-3 px-4 h-14 lg:px-6">
      {leading && <div className="shrink-0 flex items-center gap-2">{leading}</div>}
      {center && <div className="flex-1 min-w-0 max-w-2xl">{center}</div>}
      {!center && <div className="flex-1" />}
      {trailing && <div className="shrink-0 flex items-center gap-2">{trailing}</div>}
    </div>
  </header>
);
