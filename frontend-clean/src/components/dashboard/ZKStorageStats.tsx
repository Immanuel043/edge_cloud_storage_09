import React from 'react';
import { HardDrive, FileText, Shield, Crown, Zap } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { useSubscription } from '../../contexts/SubscriptionContext';
import type { ZKStorageStatsProps } from './types';
import { Badge, Button, Card, CardContent } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * ZKStorageStats — compact storage summary for zero-knowledge users.
 * Mirrors StorageStats but foregrounds the ZK badge and omits tier
 * breakdown (tier placement is server-opaque under ZK).
 */
const ZKStorageStats: React.FC<ZKStorageStatsProps> = ({ stats, onUpgradeClick }) => {
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
  const percentage: number = usageStoragePercent ?? (total > 0 ? (used / total) * 100 : 0);
  const fileCount = stats.files_count ?? stats.fileCount ?? 0;

  const progressToneClass =
    percentage > 90 ? 'bg-danger' : percentage > 70 ? 'bg-warning' : 'bg-success';

  const showUpgrade = percentage > 80;

  const planName =
    typeof subscription?.plan_name === 'string' ? subscription.plan_name : 'Unknown Plan';

  return (
    <Card variant="bordered" className="mb-3">
      {subscription && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Crown className="h-4 w-4 text-success" />
            <span className="text-body-sm font-semibold text-success">{planName}</span>
            <Badge variant="success" size="sm" className="flex items-center gap-1">
              <Shield className="h-2.5 w-2.5" />
              ZK
            </Badge>
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

          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-surface-muted">
              <div
                className={cn('h-2 rounded-full transition-all duration-normal', progressToneClass)}
                style={{ width: `${Math.min(100, percentage)}%` }}
              />
            </div>
            <span className="text-caption text-fg-subtle">{percentage.toFixed(1)}%</span>
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

export default ZKStorageStats;
