import React from 'react';
import { Cloud, HardDrive, FileText, Crown, Zap } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { useSubscription } from '../../contexts/SubscriptionContext';
import type { StorageStatsProps } from './types';
import { Button, Card, CardContent } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * StorageStats — compact storage summary card for non-ZK users. Desktop
 * shows a single horizontal row (usage, progress bar, tier breakdown, file
 * count); mobile stacks them. Shows an upgrade affordance when > 80% used.
 */
const StorageStats: React.FC<StorageStatsProps> = ({ stats, onUpgradeClick }) => {
  const { subscription, usage } = useSubscription();

  if (!stats) return null;

  const used = usage?.storage_used_bytes ?? stats.used ?? 0;
  const storageQuotaGb =
    typeof subscription?.storage_quota_gb === 'number' ? subscription.storage_quota_gb : 0;
  const total =
    storageQuotaGb > 0
      ? storageQuotaGb * 1024 * 1024 * 1024
      : stats.quota || 100 * 1024 * 1024 * 1024;

  const usageStoragePercent =
    usage && typeof (usage as Record<string, unknown>).storage_percent === 'number'
      ? ((usage as Record<string, unknown>).storage_percent as number)
      : null;
  const percentage: number =
    usageStoragePercent ?? stats.percentage_used ?? (total > 0 ? (used / total) * 100 : 0);
  const fileCount = stats.files_count ?? stats.fileCount ?? 0;

  const cacheSize = stats.distribution?.cache?.size ?? 0;
  const warmSize = stats.distribution?.warm?.size ?? 0;
  const coldSize = stats.distribution?.cold?.size ?? 0;

  const progressToneClass =
    percentage > 90 ? 'bg-danger' : percentage > 70 ? 'bg-warning' : 'bg-primary';

  const showUpgrade = percentage > 80;

  return (
    <Card variant="bordered" className="mb-3">
      {subscription && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Crown className="h-4 w-4 text-primary" />
            <span className="text-body-sm font-semibold text-primary">
              {typeof subscription.plan_name === 'string' ? subscription.plan_name : 'Unknown Plan'}
            </span>
          </div>
          {showUpgrade && onUpgradeClick && (
            <Button
              variant="primary"
              size="sm"
              onClick={onUpgradeClick}
              leftIcon={<Zap className="h-3 w-3" />}
            >
              Upgrade
            </Button>
          )}
        </div>
      )}

      <CardContent className="p-3">
        {/* Desktop: horizontal */}
        <div className="hidden items-center justify-between gap-4 sm:flex">
          <div className="flex items-center gap-3">
            <HardDrive size={18} className="text-primary" />
            <span className="text-body-sm font-medium text-fg">
              {formatBytes(used)} / {formatBytes(total)}
            </span>
          </div>

          <div className="flex max-w-xs flex-1 items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-surface-muted">
              <div
                className={cn('h-2 rounded-full transition-all duration-normal', progressToneClass)}
                style={{ width: `${Math.min(100, percentage)}%` }}
              />
            </div>
            <span className="text-caption text-fg-subtle">{percentage.toFixed(1)}%</span>
          </div>

          <div className="flex items-center gap-3">
            <TierBadge icon={<Cloud size={12} />} iconClass="text-primary" size={cacheSize} />
            <TierBadge icon={<HardDrive size={12} />} iconClass="text-success" size={warmSize} />
            <TierBadge icon={<HardDrive size={12} />} iconClass="text-fg-subtle" size={coldSize} />
          </div>

          <div className="flex items-center gap-2">
            <FileText size={14} className="text-fg-subtle" />
            <span className="text-body-sm text-fg-muted">
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </span>
          </div>
        </div>

        {/* Mobile: stacked */}
        <div className="space-y-3 sm:hidden">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-primary" />
              <span className="text-body-sm font-medium text-fg">
                {formatBytes(used)} / {formatBytes(total)}
              </span>
            </div>
            <span className="text-caption text-fg-subtle">{percentage.toFixed(1)}%</span>
          </div>

          <div className="h-2 w-full rounded-full bg-surface-muted">
            <div
              className={cn('h-2 rounded-full transition-all duration-normal', progressToneClass)}
              style={{ width: `${Math.min(100, percentage)}%` }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Cloud size={12} className="text-primary" />
              <span className="text-caption text-fg-subtle">Cache:</span>
              <span className="text-caption text-fg-muted">{formatBytes(cacheSize)}</span>
            </div>
            <div className="flex items-center gap-1">
              <HardDrive size={12} className="text-success" />
              <span className="text-caption text-fg-subtle">Warm:</span>
              <span className="text-caption text-fg-muted">{formatBytes(warmSize)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <FileText size={14} className="text-fg-subtle" />
            <span className="text-body-sm text-fg-muted">
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

interface TierBadgeProps {
  icon: React.ReactNode;
  iconClass: string;
  size: number;
}

const TierBadge: React.FC<TierBadgeProps> = ({ icon, iconClass, size }) => (
  <div className="flex items-center gap-1">
    <span className={iconClass}>{icon}</span>
    <span className="text-caption text-fg-muted">{formatBytes(size)}</span>
  </div>
);

export default StorageStats;
