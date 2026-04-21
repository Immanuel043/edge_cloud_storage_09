import React, { useState, useMemo } from 'react';
import {
  Cloud,
  Clock,
  Zap,
  Star,
  Users,
  Brain,
  BarChart3,
  Settings,
  ChevronDown,
  ChevronRight,
  Target,
  Sparkles,
  FolderCog,
  Lightbulb,
  HardDrive,
  Menu,
  Trash2,
  Shield,
  CreditCard,
  Link2,
  Activity,
} from 'lucide-react';
import type { SidebarProps, MenuItem as MenuItemType } from './types';
import { formatBytes } from '../../utils/helpers';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { cn } from '@/lib/cn';
import { IconButton, Progress, Drawer } from '@/components/ui';
import { NavItem, NavSection, SidebarBrand } from '@/components/layout';

/**
 * Sidebar — dashboard navigation rail. Internally rebuilt on Signal layout
 * primitives (`SidebarBrand`, `NavItem`, `NavSection`, `Progress`, `Drawer`),
 * but the external `SidebarProps` contract is preserved for both
 * NormalDashboard and ZKDashboard consumers (unchanged prop surface).
 *
 * Desktop: fixed `w-64` rail on the left.
 * Mobile: rendered inside a left-side `Drawer` via `isMobileOpen`.
 */

const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onViewChange,
  storageStats,
  isMobileOpen,
  onMobileToggle,
}) => {
  const { subscription, usage } = useSubscription();
  const [aiExpanded, setAiExpanded] = useState<boolean>(true);

  // Compute percentage consistently with StorageStats component
  const storagePercentage = useMemo(() => {
    if (usage && typeof (usage as Record<string, unknown>).storage_percent === 'number') {
      return (usage as Record<string, unknown>).storage_percent as number;
    }
    if (storageStats?.percentage_used != null) {
      return storageStats.percentage_used;
    }
    const quota = storageStats?.quota ?? 0;
    const used = storageStats?.used ?? 0;
    if (quota > 0) {
      return (used / quota) * 100;
    }
    return 0;
  }, [usage, storageStats]);

  // Use subscription quota for display if available
  const displayQuota = useMemo(() => {
    const storageQuotaGb =
      typeof subscription?.storage_quota_gb === 'number' ? subscription.storage_quota_gb : 0;
    if (storageQuotaGb > 0) return storageQuotaGb * 1024 * 1024 * 1024;
    return storageStats?.quota ?? 0;
  }, [subscription, storageStats]);

  const primaryItems: MenuItemType[] = [
    { id: 'cloud-drive', label: 'Cloud Drive', icon: Cloud, description: 'All your files' },
    { id: 'recents', label: 'Recents', icon: Clock, description: 'Recently accessed' },
    { id: 'shared-with-me', label: 'Shared with me', icon: Users, description: 'Files shared by others' },
    { id: 'my-share-links', label: 'My Share Links', icon: Link2, description: 'Manage your share links' },
    { id: 'share-analytics', label: 'Share Analytics', icon: Activity, description: 'Share access analytics' },
    { id: 'trash', label: 'Trash', icon: Trash2, description: 'Deleted files (30 days)' },
    { id: 'dedup', label: 'Dedup Dashboard', icon: Zap, description: 'Storage optimization' },
    { id: 'favorites', label: 'Favorites', icon: Star, description: 'Starred files' },
  ];

  const aiItems: MenuItemType[] = [
    { id: 'quota-alerts', label: 'Quota Alerts', icon: Target, description: 'Predictive warnings' },
    { id: 'storage-optimization', label: 'Storage Optimization', icon: Sparkles, description: 'Auto-optimize storage' },
    { id: 'auto-organize', label: 'Auto-Organize', icon: FolderCog, description: 'Smart file organization' },
    { id: 'security-alerts', label: 'Security Alerts', icon: Shield, description: 'Anomaly detection alerts' },
    { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, description: 'File suggestions' },
  ];

  const bottomItems: MenuItemType[] = [
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'billing', label: 'Billing & Plans', icon: CreditCard },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const handleClick = (id: string) => {
    onViewChange(id);
    if (isMobileOpen) onMobileToggle();
  };

  const renderNavItem = (item: MenuItemType, nested = false) => {
    const Icon = item.icon;
    return (
      <NavItem
        key={item.id}
        icon={<Icon />}
        label={item.label}
        {...(item.description ? { description: item.description } : {})}
        active={activeView === item.id}
        nested={nested}
        onClick={() => handleClick(item.id)}
      />
    );
  };

  const progressTone: 'primary' | 'warning' | 'danger' =
    storagePercentage > 90 ? 'danger' : storagePercentage > 70 ? 'warning' : 'primary';

  const sidebarContent = (
    <div className="flex h-full flex-col bg-surface">
      <SidebarBrand />

      <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1" aria-label="Primary">
        <NavSection>{primaryItems.map((item) => renderNavItem(item))}</NavSection>

        {/* AI Features — collapsible */}
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setAiExpanded((v) => !v)}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-body-sm font-medium',
              'transition-colors duration-fast',
              'text-fg-muted hover:bg-surface-muted hover:text-fg',
              'focus-visible:outline-none focus-visible:shadow-focus'
            )}
            aria-expanded={aiExpanded}
          >
            <span className="shrink-0 text-fg-subtle [&>svg]:h-5 [&>svg]:w-5">
              <Brain />
            </span>
            <span className="flex-1 text-left">AI Features</span>
            <span aria-hidden className="text-fg-subtle [&>svg]:h-4 [&>svg]:w-4">
              {aiExpanded ? <ChevronDown /> : <ChevronRight />}
            </span>
          </button>
          {aiExpanded && (
            <div className="mt-1 space-y-0.5">{aiItems.map((item) => renderNavItem(item, true))}</div>
          )}
        </div>

        <NavSection className="mt-2 border-t border-border pt-3">
          {bottomItems.map((item) => renderNavItem(item))}
        </NavSection>
      </nav>

      {storageStats && (
        <div className="shrink-0 border-t border-border bg-surface-muted px-4 py-3">
          <div className="flex items-center gap-2 text-fg-muted">
            <HardDrive className="h-4 w-4" />
            <span className="text-caption font-medium uppercase tracking-wide">Storage</span>
          </div>
          <div className="mt-2 text-body-sm font-semibold text-fg">
            {formatBytes(storageStats.used)} / {formatBytes(displayQuota)}
          </div>
          <Progress
            className="mt-2"
            size="sm"
            tone={progressTone}
            value={Math.min(100, Math.max(0, storagePercentage))}
            label="Storage usage"
          />
          <div className="mt-1 text-caption text-fg-subtle">
            {storagePercentage.toFixed(1)}% used
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside className="fixed top-0 left-0 z-40 hidden h-full w-64 border-r border-border lg:block">
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      <Drawer open={isMobileOpen} onClose={onMobileToggle} side="left" size="sm" hideCloseButton>
        <div className="-mx-6 -my-5 h-full">{sidebarContent}</div>
      </Drawer>

      {/* Mobile hamburger trigger (fixed; mirrors legacy position) */}
      <IconButton
        variant="secondary"
        size="md"
        aria-label="Open navigation"
        onClick={onMobileToggle}
        className="fixed top-3 left-3 z-30 lg:hidden shadow-md"
      >
        <Menu />
      </IconButton>
    </>
  );
};

export default Sidebar;
