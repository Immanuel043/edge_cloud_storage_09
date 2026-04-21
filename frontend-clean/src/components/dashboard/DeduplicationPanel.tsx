import React from 'react';
import {
  Database,
  HardDrive,
  TrendingUp,
  RefreshCw,
  Info,
  Zap,
  Package,
  Trash2,
} from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { storageService } from '../../services/storageService';
import type { DeduplicationPanelProps } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  Card,
  CardContent,
  IconButton,
  Progress,
  Skeleton,
} from '@/components/ui';

/**
 * DeduplicationPanel — block-level dedup analytics. Summary cards for
 * logical/physical/saved/efficiency, Progress bar for savings percentage,
 * block-level stats (total blocks, avg references, compression), and a
 * gradient hero card showing total files + dedup ratio. Includes GC trigger.
 */
const DeduplicationPanel: React.FC<DeduplicationPanelProps> = ({
  stats,
  loading,
  onRefresh,
}) => {
  const analytics = stats?.analytics || null;
  const savings = stats?.savings || null;
  const error = stats?.error || null;

  const runGarbageCollection = async (): Promise<void> => {
    if (!window.confirm('Run garbage collection to clean up unused blocks?')) return;
    try {
      await storageService.runGarbageCollection('');
      if (onRefresh) onRefresh();
      alert('Garbage collection initiated successfully');
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('GC failed:', err);
      alert(`Failed to run garbage collection: ${errorMessage}`);
    }
  };

  if (loading) {
    return (
      <Card variant="bordered">
        <CardContent className="p-6">
          <Skeleton className="mb-4 h-6 w-1/3" />
          <div className="space-y-3">
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="bordered">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-6 w-6 text-accent" />
              <h2 className="text-h2 font-bold text-fg">Deduplication analytics</h2>
            </div>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Retry"
              onClick={onRefresh}
            >
              <RefreshCw className="h-4 w-4" />
            </IconButton>
          </div>
          <Banner
            variant="danger"
            action={
              <Button variant="primary" size="sm" onClick={onRefresh}>
                Try again
              </Button>
            }
          >
            {error}
          </Banner>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Zap className="h-6 w-6 text-accent" />
            <h2 className="text-h2 font-bold text-fg">Deduplication analytics</h2>
          </div>
          <div className="flex gap-2">
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Run garbage collection"
              onClick={() => void runGarbageCollection()}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Refresh"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </IconButton>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <SummaryStat
            icon={<Database className="h-4 w-4 text-primary" />}
            label="Logical"
            value={formatBytes(savings?.logical_size || 0)}
            valueClass="text-fg"
          />
          <SummaryStat
            icon={<HardDrive className="h-4 w-4 text-success" />}
            label="Physical"
            value={formatBytes(savings?.physical_size || 0)}
            valueClass="text-success"
          />
          <SummaryStat
            icon={<TrendingUp className="h-4 w-4 text-accent" />}
            label="Saved"
            value={formatBytes(savings?.saved_size || 0)}
            valueClass="text-accent"
          />
          <SummaryStat
            icon={<Info className="h-4 w-4 text-warning" />}
            label="Efficiency"
            value={`${savings?.storage_efficiency?.toFixed(2) ?? '—'}x`}
            valueClass="text-warning"
          />
        </div>

        {/* Progress */}
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex justify-between text-body-sm">
              <span className="text-fg-muted">Storage savings</span>
              <span className="font-medium text-fg">
                {savings?.savings_percentage?.toFixed(1) ?? '0'}%
              </span>
            </div>
            <Progress value={savings?.savings_percentage || 0} tone="primary" size="md" />
          </div>

          {/* Block Statistics */}
          {analytics?.blocks && (
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex items-center gap-2">
                <Package className="h-4 w-4 text-fg-muted" />
                <h4 className="text-body-sm font-medium text-fg">Block statistics</h4>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <BlockStat
                  value={analytics.blocks.total_blocks?.toLocaleString() || '0'}
                  label="Total blocks"
                  tone="accent"
                />
                <BlockStat
                  value={analytics.blocks.avg_references?.toFixed(1) || '0'}
                  label="Avg references"
                  tone="success"
                />
                <BlockStat
                  value={`${analytics.summary?.compression_ratio?.toFixed(2) || '1'}x`}
                  label="Compression"
                  tone="accent"
                />
              </div>
            </div>
          )}

          {/* Summary hero card */}
          {analytics?.summary && (
            <div className="mt-4 rounded-xl bg-gradient-to-r from-accent to-primary p-4 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-body-sm opacity-90">Total files processed</p>
                  <p className="text-h2 font-bold">{analytics.summary.total_files || 0}</p>
                </div>
                <div className="text-right">
                  <p className="text-body-sm opacity-90">Deduplication ratio</p>
                  <p className="text-h2 font-bold">
                    {analytics.summary.dedup_ratio?.toFixed(1) || 0}%
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

const SummaryStat: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass: string;
}> = ({ icon, label, value, valueClass }) => (
  <div className="rounded-lg bg-surface-muted p-4">
    <div className="mb-2 flex items-center justify-between">
      {icon}
      <span className="text-caption text-fg-muted">{label}</span>
    </div>
    <p className={`text-body font-semibold ${valueClass}`}>{value}</p>
  </div>
);

const BlockStat: React.FC<{
  value: string;
  label: string;
  tone: 'accent' | 'success' | 'primary';
}> = ({ value, label, tone }) => {
  const toneClass =
    tone === 'accent' ? 'text-accent' : tone === 'success' ? 'text-success' : 'text-primary';
  return (
    <div className="text-center">
      <p className={`text-h2 font-bold ${toneClass}`}>{value}</p>
      <p className="text-caption text-fg-muted">{label}</p>
    </div>
  );
};

export default DeduplicationPanel;
