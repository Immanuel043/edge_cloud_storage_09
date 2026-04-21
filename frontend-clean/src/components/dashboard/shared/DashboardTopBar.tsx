import React from 'react';
import { Grid, List, Sun, Moon, Info, Lock, LogOut, Shield, Cloud } from 'lucide-react';
import { TopBar } from '@/components/layout';
import { IconButton, Badge } from '@/components/ui';
import type { SearchResults as SearchResultsType, FileItem, ViewMode } from '../types';

/**
 * DashboardTopBar — shared top bar for NormalDashboard and ZKDashboard.
 *
 * Built on the `TopBar` layout primitive; consumes `IconButton`s and tokens
 * so the two dashboards stay visually in sync without duplicating inline
 * ternaries. Only the wiring differs (ZK-mode flag, search files, lock button
 * visibility).
 */

export interface DashboardTopBarProps {
  /** Already-rendered SearchBar node (owns its own state). */
  search: React.ReactNode;
  viewMode: ViewMode;
  onViewModeChange: (next: ViewMode) => void;
  darkMode: boolean;
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
  /** When present, shows the lock button. */
  onLockSession?: (() => void) | undefined;
  username: string;
  onLogout: () => void;
  isZKMode: boolean;
}

export const DashboardTopBar: React.FC<DashboardTopBarProps> = ({
  search,
  viewMode,
  onViewModeChange,
  darkMode,
  onToggleTheme,
  onShowShortcuts,
  onLockSession,
  username,
  onLogout,
  isZKMode,
}) => {
  const toggledView = viewMode === 'grid' ? 'list' : 'grid';
  return (
    <TopBar
      center={search}
      trailing={
        <>
          <IconButton
            variant="secondary"
            size="sm"
            aria-label={`Switch to ${toggledView} view`}
            onClick={() => onViewModeChange(toggledView)}
            title={`Switch to ${toggledView} view`}
          >
            {viewMode === 'grid' ? <List /> : <Grid />}
          </IconButton>

          <IconButton
            variant="secondary"
            size="sm"
            aria-label="Toggle theme"
            onClick={onToggleTheme}
            title="Toggle theme"
          >
            {darkMode ? <Sun /> : <Moon />}
          </IconButton>

          <IconButton
            variant="secondary"
            size="sm"
            aria-label="Keyboard shortcuts"
            onClick={onShowShortcuts}
            title="Keyboard shortcuts (Shift+?)"
          >
            <Info />
          </IconButton>

          {onLockSession && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Lock encryption session"
              onClick={onLockSession}
              title="Lock encryption session"
              className="text-warning hover:bg-warning/10"
            >
              <Lock />
            </IconButton>
          )}

          <Badge
            variant={isZKMode ? 'success' : 'info'}
            size="md"
            className="hidden sm:inline-flex"
          >
            {isZKMode ? <Shield className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
            {isZKMode ? 'ZK Encrypted' : 'Standard Storage'}
          </Badge>

          <div className="hidden items-center gap-2 md:flex">
            <span className="max-w-[10rem] truncate text-body-sm text-fg-muted">
              {username}
            </span>
            <IconButton
              variant="secondary"
              size="sm"
              aria-label="Log out"
              onClick={onLogout}
              title="Log out"
            >
              <LogOut />
            </IconButton>
          </div>
        </>
      }
    />
  );
};

// Re-export supporting types so consumers don't need to reach across files
export type { SearchResultsType, FileItem };

export default DashboardTopBar;
