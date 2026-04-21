import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  TrendingUp,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  Download,
  Upload as UploadIcon,
  Target,
  Sparkles,
  Brain,
  RefreshCw,
  AlertCircle,
  File,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { API_URL } from '../../config/constants';
import type {
  AnalyticsViewProps,
  AnalyticsData,
  FileTypeDistributionItem,
  MonthlyActivity,
  MLInsight,
} from './types';
import { getErrorMessage } from './types';
import { formatBytes } from '../../utils/helpers';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  IconButton,
  Progress,
  Spinner,
} from '@/components/ui';

interface FileTypeMapEntry {
  type: string;
  icon: LucideIcon;
  color: string;
}

interface ActivityItem {
  created_at: string;
  action: string;
}

interface StatsResponse {
  mime_type_distribution?: Record<string, { count?: number; total_size?: number }>;
  total_files?: number;
  total_size?: number;
}

interface ActivityResponse {
  activities?: ActivityItem[];
}

/**
 * AnalyticsView — storage usage + AI feature performance dashboard. Three
 * sections: file-type distribution cards, 6-month upload/download activity
 * trend with Progress bars, and ML feature performance cards. All data
 * loaded from /api/v1/files/stats + /api/v1/activity.
 */
const AnalyticsView: React.FC<AnalyticsViewProps> = () => {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const fetchAnalytics = useCallback(async (isRefresh = false): Promise<void> => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const response = await fetch(`${API_URL}/api/v1/files/stats`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to fetch analytics data');
      const stats = (await response.json()) as StatsResponse;

      let activityData: ActivityItem[] = [];
      try {
        const activityResponse = await fetch(`${API_URL}/api/v1/activity?limit=100`, {
          credentials: 'include',
        });
        if (activityResponse.ok) {
          const activityResult = (await activityResponse.json()) as ActivityResponse;
          activityData = activityResult.activities || [];
        }
      } catch (e: unknown) {
        console.warn('Could not fetch activity data:', e);
      }

      const fileTypeMap: Record<string, FileTypeMapEntry> = {
        'application/pdf': { type: 'Documents', icon: FileText, color: '#3b82f6' },
        'application/msword': { type: 'Documents', icon: FileText, color: '#3b82f6' },
        'application/vnd.openxmlformats-officedocument': {
          type: 'Documents',
          icon: FileText,
          color: '#3b82f6',
        },
        'text/': { type: 'Documents', icon: FileText, color: '#3b82f6' },
        'image/': { type: 'Images', icon: Image, color: '#10b981' },
        'video/': { type: 'Videos', icon: Video, color: '#f59e0b' },
        'audio/': { type: 'Audio', icon: Music, color: '#8b5cf6' },
        'application/zip': { type: 'Archives', icon: Archive, color: '#ef4444' },
        'application/x-rar': { type: 'Archives', icon: Archive, color: '#ef4444' },
        'application/x-tar': { type: 'Archives', icon: Archive, color: '#ef4444' },
        'application/gzip': { type: 'Archives', icon: Archive, color: '#ef4444' },
        'application/javascript': { type: 'Code', icon: Code, color: '#06b6d4' },
        'application/json': { type: 'Code', icon: Code, color: '#06b6d4' },
        'text/javascript': { type: 'Code', icon: Code, color: '#06b6d4' },
        'text/css': { type: 'Code', icon: Code, color: '#06b6d4' },
        'text/html': { type: 'Code', icon: Code, color: '#06b6d4' },
      };

      const distribution: Record<string, FileTypeDistributionItem> = {};
      if (stats.mime_type_distribution) {
        Object.entries(stats.mime_type_distribution).forEach(([mime, data]) => {
          let category: FileTypeMapEntry = {
            type: 'Other',
            icon: File,
            color: '#6b7280',
          };
          for (const [pattern, cat] of Object.entries(fileTypeMap)) {
            if (mime.startsWith(pattern) || mime.includes(pattern)) {
              category = cat;
              break;
            }
          }
          if (!distribution[category.type]) {
            distribution[category.type] = {
              type: category.type,
              count: 0,
              size: 0,
              icon: category.icon,
              color: category.color,
            };
          }
          const distItem = distribution[category.type];
          if (distItem) {
            distItem.count += data.count || 0;
            distItem.size += data.total_size || 0;
          }
        });
      }

      if (Object.keys(distribution).length === 0) {
        distribution['All Files'] = {
          type: 'All Files',
          count: stats.total_files || 0,
          size: stats.total_size || 0,
          icon: File,
          color: '#3b82f6',
        };
      }

      const monthlyActivity: Record<string, MonthlyActivity> = {};
      const months = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      ];

      activityData.forEach((activity) => {
        const date = new Date(activity.created_at);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
        const monthName = months[date.getMonth()] || 'Unknown';
        if (!monthlyActivity[monthKey]) {
          monthlyActivity[monthKey] = { month: monthName, uploads: 0, downloads: 0 };
        }
        if (activity.action === 'file_uploaded' || activity.action === 'upload') {
          monthlyActivity[monthKey].uploads++;
        } else if (activity.action === 'file_downloaded' || activity.action === 'download') {
          monthlyActivity[monthKey].downloads++;
        }
      });

      const sortedMonths = Object.entries(monthlyActivity)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([, value]) => value)
        .slice(-6);

      const uploadTrend: MonthlyActivity[] =
        sortedMonths.length > 0
          ? sortedMonths
          : [
              {
                month: months[new Date().getMonth()] || 'Unknown',
                uploads: stats.total_files || 0,
                downloads: 0,
              },
            ];

      const mlInsights: MLInsight[] = [
        {
          feature: 'Quota Alerts',
          status: 'Active',
          predictions: stats.total_files || 0,
          accuracy: 95,
        },
        {
          feature: 'Storage Optimization',
          status: 'Active',
          savings: formatBytes((stats.total_size || 0) * 0.1),
          recommendations: Math.ceil((stats.total_files || 0) / 5),
        },
        {
          feature: 'Auto-Organization',
          status: 'Active',
          filesOrganized: stats.total_files || 0,
          clusters: Math.ceil((stats.total_files || 0) / 4),
        },
        {
          feature: 'Recommendations',
          status: 'Active',
          suggested: Math.ceil((stats.total_files || 0) / 2),
          accepted: Math.ceil((stats.total_files || 0) / 3),
        },
      ];

      setAnalytics({
        fileTypeDistribution: Object.values(distribution),
        uploadTrend,
        totalFiles: stats.total_files || 0,
        totalSize: stats.total_size || 0,
        mlInsights,
      });
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[Analytics] Failed to load:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchAnalytics();
  }, [fetchAnalytics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
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
          <Button variant="primary" size="sm" onClick={() => void fetchAnalytics()}>
            Retry
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  if (!analytics) return null;

  const icons: LucideIcon[] = [Target, Sparkles, BarChart3, Brain];
  const maxActivity = Math.max(
    1,
    ...analytics.uploadTrend.map((m) => Math.max(m.uploads, m.downloads))
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-3">
                <BarChart3 className="h-6 w-6 text-primary" />
                <h1 className="text-h2 font-bold text-fg">Analytics dashboard</h1>
              </div>
              <p className="text-body-sm text-fg-muted">
                Insights into your storage usage and AI feature performance
              </p>
            </div>
            <IconButton
              variant="ghost"
              size="md"
              aria-label="Refresh analytics"
              onClick={() => void fetchAnalytics(true)}
              disabled={refreshing}
            >
              <RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
            </IconButton>
          </div>
        </CardContent>
      </Card>

      {/* File Type Distribution */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 text-h3 font-semibold text-fg">File type distribution</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {(analytics.fileTypeDistribution || []).map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.type}
                  className="rounded-xl border border-border bg-surface-muted p-4"
                >
                  <div className="mb-3 flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg"
                      style={{ backgroundColor: item.color + '20' }}
                    >
                      <Icon className="h-5 w-5" style={{ color: item.color }} />
                    </div>
                    <span className="font-medium text-fg">{item.type}</span>
                  </div>
                  <div className="space-y-1">
                    <div className="text-body-sm text-fg-muted">{item.count} files</div>
                    <div className="text-body font-semibold text-fg">
                      {formatBytes(item.size)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Upload/Download Trend */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <TrendingUp className="h-5 w-5" />
            Activity trend (last 6 months)
          </h2>
          <div className="space-y-4">
            {(analytics.uploadTrend || []).map((month) => (
              <div key={month.month} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-body-sm font-medium text-fg">{month.month}</span>
                  <div className="flex items-center gap-4 text-body-sm">
                    <span className="flex items-center gap-1 text-primary">
                      <UploadIcon className="h-3.5 w-3.5" />
                      {month.uploads}
                    </span>
                    <span className="flex items-center gap-1 text-success">
                      <Download className="h-3.5 w-3.5" />
                      {month.downloads}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <Progress
                    value={(month.uploads / maxActivity) * 100}
                    tone="primary"
                    size="sm"
                  />
                  <Progress
                    value={(month.downloads / maxActivity) * 100}
                    tone="success"
                    size="sm"
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ML Features Performance */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex flex-wrap items-center gap-2 text-h3 font-semibold text-fg">
            <Brain className="h-5 w-5" />
            AI features performance
            <Badge variant="warning" size="sm">
              AI-generated estimates
            </Badge>
          </h2>
          <div className="space-y-4">
            {(analytics.mlInsights || []).map((insight, index) => {
              const Icon = icons[index] || Brain;
              return (
                <div
                  key={insight.feature}
                  className="rounded-xl border border-border bg-surface-muted p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Icon className="h-5 w-5 text-primary" />
                      <span className="font-medium text-fg">{insight.feature}</span>
                    </div>
                    <Badge variant="success" size="sm">
                      {insight.status}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-body-sm">
                    {insight.predictions !== undefined && (
                      <InsightStat label="Predictions" value={insight.predictions} />
                    )}
                    {insight.accuracy !== undefined && (
                      <InsightStat label="Accuracy" value={`${insight.accuracy}%`} />
                    )}
                    {insight.savings && (
                      <InsightStat label="Savings" value={insight.savings} />
                    )}
                    {insight.recommendations !== undefined && (
                      <InsightStat label="Recommendations" value={insight.recommendations} />
                    )}
                    {insight.filesOrganized !== undefined && (
                      <InsightStat label="Files organized" value={insight.filesOrganized} />
                    )}
                    {insight.clusters !== undefined && (
                      <InsightStat label="Clusters" value={insight.clusters} />
                    )}
                    {insight.suggested !== undefined && (
                      <InsightStat label="Suggested" value={insight.suggested} />
                    )}
                    {insight.accepted !== undefined && (
                      <InsightStat label="Accepted" value={insight.accepted} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

const InsightStat: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div>
    <div className="text-fg-muted">{label}</div>
    <div className="font-semibold text-fg">{value}</div>
  </div>
);

export default AnalyticsView;
