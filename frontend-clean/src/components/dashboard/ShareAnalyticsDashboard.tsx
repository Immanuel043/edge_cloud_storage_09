import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  Eye,
  Download,
  Users,
  Globe,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  FileIcon,
  FolderIcon,
  Package,
} from 'lucide-react';
import { storageService } from '../../services/storageService';
import { getFileIcon } from '../../utils/helpers';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  IconButton,
  Select,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/cn';

interface AnalyticsSummary {
  total_shares: number;
  active_shares: number;
  total_views: number;
  total_downloads: number;
  total_unique_ips: number;
  most_viewed_share?: { id: string; name: string; type: string; views: number };
  most_downloaded_share?: { id: string; name: string; type: string; downloads: number };
}

interface DailyStats {
  date: string;
  views: number;
  downloads: number;
}

interface TrendsData {
  daily: DailyStats[];
  period_days: number;
}

interface TopItem {
  id: string;
  name: string;
  share_type: string;
  item_type: string;
  views: number;
  downloads: number;
  unique_ips: number;
  is_active: boolean;
  created_at: string;
  last_accessed?: string;
}

interface TopItemsData {
  items: TopItem[];
  total: number;
}

interface ShareAnalyticsDashboardProps {
  darkMode?: boolean;
}

/**
 * ShareAnalyticsDashboard — aggregate analytics for user's outgoing shares.
 * Summary metrics row, highlight cards (most viewed/downloaded), configurable
 * access-trend SVG bar chart, and a top-shares ranked list sortable by views
 * or downloads. Empty state when no shares exist.
 */
const ShareAnalyticsDashboard: React.FC<ShareAnalyticsDashboardProps> = () => {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [trends, setTrends] = useState<TrendsData | null>(null);
  const [topItems, setTopItems] = useState<TopItemsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState(30);
  const [sortBy, setSortBy] = useState<'views' | 'downloads'>('views');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, trendsData, topData] = await Promise.all([
        storageService.getShareAnalyticsSummary(),
        storageService.getShareAnalyticsTrends(trendDays),
        storageService.getShareAnalyticsTop(sortBy),
      ]);
      setSummary(summaryData as AnalyticsSummary);
      setTrends(trendsData as TrendsData);
      setTopItems(topData as TopItemsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [trendDays, sortBy]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const trendMax = useMemo(() => {
    if (!trends) return 1;
    return Math.max(1, ...trends.daily.map((d) => Math.max(d.views, d.downloads)));
  }, [trends]);

  const trendTotals = useMemo(() => {
    if (!trends) return { views: 0, downloads: 0 };
    return trends.daily.reduce(
      (acc, d) => ({ views: acc.views + d.views, downloads: acc.downloads + d.downloads }),
      { views: 0, downloads: 0 },
    );
  }, [trends]);

  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const itemIcon = (type: string, name?: string) => {
    switch (type) {
      case 'folder':
        return <FolderIcon size={16} className="text-primary" />;
      case 'bundle':
        return <Package size={16} className="text-accent" />;
      default:
        return name ? getFileIcon(name, 16) : <FileIcon size={16} className="text-fg-subtle" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <Banner
        variant="danger"
        icon={<AlertCircle />}
        title="Failed to load analytics"
        action={
          <Button variant="primary" size="sm" onClick={() => void fetchAll()}>
            Try again
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Activity className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-h2 font-bold text-fg">Share analytics</h2>
                <p className="text-body-sm text-fg-muted">
                  Access insights for your shared content
                </p>
              </div>
            </div>
            <IconButton
              variant="ghost"
              size="md"
              aria-label="Refresh"
              onClick={() => void fetchAll()}
            >
              <RefreshCw className="h-5 w-5" />
            </IconButton>
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <MetricCard
            icon={<Activity className="h-4 w-4 text-primary" />}
            label="Total shares"
            value={summary.total_shares}
            sub={`${summary.active_shares} active`}
          />
          <MetricCard
            icon={<Eye className="h-4 w-4 text-success" />}
            label="Total views"
            value={summary.total_views}
          />
          <MetricCard
            icon={<Download className="h-4 w-4 text-accent" />}
            label="Total downloads"
            value={summary.total_downloads}
          />
          <MetricCard
            icon={<Globe className="h-4 w-4 text-warning" />}
            label="Unique visitors"
            value={summary.total_unique_ips}
          />
          <MetricCard
            icon={<TrendingUp className="h-4 w-4 text-primary" />}
            label="Active shares"
            value={summary.active_shares}
          />
        </div>
      )}

      {/* Highlight Cards */}
      {summary && (summary.most_viewed_share || summary.most_downloaded_share) && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {summary.most_viewed_share && (
            <div className="rounded-xl border border-success/30 bg-success/10 p-4">
              <p className="mb-1 text-caption font-medium text-success">Most viewed</p>
              <div className="flex items-center gap-2">
                {itemIcon(summary.most_viewed_share.type, summary.most_viewed_share.name)}
                <p className="truncate font-medium text-fg">{summary.most_viewed_share.name}</p>
              </div>
              <p className="mt-1 text-body-sm text-success">
                {summary.most_viewed_share.views.toLocaleString()} views
              </p>
            </div>
          )}
          {summary.most_downloaded_share && (
            <div className="rounded-xl border border-accent/30 bg-accent/10 p-4">
              <p className="mb-1 text-caption font-medium text-accent">Most downloaded</p>
              <div className="flex items-center gap-2">
                {itemIcon(summary.most_downloaded_share.type, summary.most_downloaded_share.name)}
                <p className="truncate font-medium text-fg">
                  {summary.most_downloaded_share.name}
                </p>
              </div>
              <p className="mt-1 text-body-sm text-accent">
                {summary.most_downloaded_share.downloads.toLocaleString()} downloads
              </p>
            </div>
          )}
        </div>
      )}

      {/* Trends Chart */}
      {trends && (
        <Card variant="bordered">
          <CardContent className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-h3 font-semibold text-fg">Access trends</h3>
                <p className="text-caption text-fg-muted">
                  {trendTotals.views} views, {trendTotals.downloads} downloads in {trendDays} days
                </p>
              </div>
              <Select
                value={trendDays}
                size="sm"
                onChange={(e) => setTrendDays(Number(e.target.value))}
                className="w-auto"
              >
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </Select>
            </div>

            {/* Legend */}
            <div className="mb-3 flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded-full bg-primary" />
                <span className="text-caption text-fg-muted">Views</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded-full bg-accent" />
                <span className="text-caption text-fg-muted">Downloads</span>
              </div>
            </div>

            {/* Bar Chart */}
            <div className="flex h-40 items-end gap-[2px]">
              {trends.daily.map((day, i) => {
                const viewH = (day.views / trendMax) * 100;
                const dlH = (day.downloads / trendMax) * 100;
                const showLabel =
                  trends.daily.length <= 14 || i % Math.ceil(trends.daily.length / 14) === 0;
                return (
                  <div
                    key={day.date}
                    className="flex min-w-0 flex-1 flex-col items-center gap-0"
                    title={`${formatDate(day.date)}: ${day.views} views, ${day.downloads} downloads`}
                  >
                    <div className="flex w-full items-end gap-[1px]" style={{ height: '140px' }}>
                      <div
                        className="flex-1 rounded-t-sm bg-primary transition-all"
                        style={{ height: `${Math.max(viewH, day.views > 0 ? 2 : 0)}%` }}
                      />
                      <div
                        className="flex-1 rounded-t-sm bg-accent transition-all"
                        style={{ height: `${Math.max(dlH, day.downloads > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    {showLabel && (
                      <span className="mt-1 w-full truncate text-center text-[9px] text-fg-subtle">
                        {formatDate(day.date)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top Shares */}
      {topItems && topItems.items.length > 0 && (
        <Card variant="bordered">
          <CardContent className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-h3 font-semibold text-fg">Top shares</h3>
              <div className="flex items-center gap-2">
                <span className="text-caption text-fg-muted">Sort by</span>
                <Select
                  value={sortBy}
                  size="sm"
                  onChange={(e) => setSortBy(e.target.value as 'views' | 'downloads')}
                  className="w-auto"
                >
                  <option value="views">Views</option>
                  <option value="downloads">Downloads</option>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              {topItems.items.map((item, idx) => {
                const maxVal = Math.max(1, topItems.items[0]?.[sortBy] ?? 1);
                const barWidth = (item[sortBy] / maxVal) * 100;
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-surface-muted"
                  >
                    <span className="w-5 text-right font-mono text-caption text-fg-subtle">
                      {idx + 1}
                    </span>
                    {itemIcon(item.item_type, item.name)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-body-sm font-medium text-fg">{item.name}</p>
                        {!item.is_active && (
                          <Badge variant="danger" size="sm">
                            inactive
                          </Badge>
                        )}
                        <span className="flex-shrink-0 text-caption text-fg-subtle">
                          {item.share_type}
                        </span>
                      </div>
                      {/* Mini bar */}
                      <div className="mt-1.5 h-1.5 rounded-full bg-surface-muted">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            sortBy === 'views' ? 'bg-primary' : 'bg-accent'
                          )}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-4 text-caption">
                      <span className="flex items-center gap-1 text-fg">
                        <Eye className="h-3 w-3" /> {item.views.toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1 text-fg">
                        <Download className="h-3 w-3" /> {item.downloads.toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1 text-fg-muted">
                        <Users className="h-3 w-3" /> {item.unique_ips}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {summary && summary.total_shares === 0 && (
        <Card variant="bordered">
          <CardContent className="p-6">
            <EmptyState
              icon={<Activity />}
              title="No sharing activity yet"
              description="Share files, folders, or bundles to start seeing access analytics here."
              size="lg"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
};

const MetricCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  sub?: string;
}> = ({ icon, label, value, sub }) => (
  <Card variant="bordered">
    <CardContent className="p-4">
      <div className="mb-2 flex items-center justify-between">
        {icon}
        <span className="text-caption text-fg-muted">{label}</span>
      </div>
      <p className="text-h2 font-bold text-fg">{value.toLocaleString()}</p>
      {sub && <p className="mt-1 text-caption text-fg-subtle">{sub}</p>}
    </CardContent>
  </Card>
);

export default ShareAnalyticsDashboard;
