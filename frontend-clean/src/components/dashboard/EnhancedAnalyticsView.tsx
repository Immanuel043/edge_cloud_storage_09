import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  HardDrive,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  AlertTriangle,
  CheckCircle,
  Target,
  Sparkles,
  Brain,
  Clock,
  Zap,
  TrendingDown,
  AlertCircle,
  X,
  RefreshCw,
  Activity,
} from 'lucide-react';
import { analyticsService } from '../../services/analyticsService';
import { formatBytes, formatDate } from '../../utils/helpers';
import type { EnhancedAnalyticsViewProps, QuotaPrediction, QuotaAlert } from './types';
import { getErrorMessage } from './types';
import type { LucideIcon } from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  IconButton,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/cn';

interface AnalyticsData {
  prediction?: QuotaPrediction;
  history?: {
    history?: Array<{ timestamp: string; bytes_used: number }>;
  };
  alerts?: QuotaAlert[];
  analysis?: {
    file_type_distribution?: Record<string, { count: number; size: number }>;
  };
  suggestions?: Array<{
    id: string;
    title: string;
    description: string;
    impact: 'high' | 'medium' | 'low';
    potential_savings?: number;
  }>;
  summary?: {
    total_potential_savings?: number;
    active_suggestions?: number;
    applied_suggestions?: number;
    efficiency_score?: number;
  };
}

interface PredictionCardProps {
  title: string;
  predicted: number;
  quota: number;
  confidence: number;
}

interface FileTypeCardProps {
  type: string;
  count: number;
  size: number;
}

type SummaryTone = 'success' | 'primary' | 'accent' | 'warning';

interface SummaryCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone: SummaryTone;
}

const summaryToneClass: Record<SummaryTone, string> = {
  success: 'text-success',
  primary: 'text-primary',
  accent: 'text-accent',
  warning: 'text-warning',
};

/**
 * PredictionCard — single quota-prediction tile showing the projected usage
 * for a 7/14/30-day horizon and the model's confidence.
 */
const PredictionCard: React.FC<PredictionCardProps> = ({ title, predicted, quota, confidence }) => {
  const percentage = (predicted / quota) * 100;
  const isWarning = percentage > 80;

  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      <div className="text-center">
        <p className="mb-1 text-body-sm text-fg-muted">{title}</p>
        <p
          className={cn(
            'mb-1 text-h2 font-bold',
            isWarning ? 'text-warning' : 'text-fg'
          )}
        >
          {formatBytes(predicted)}
        </p>
        <p className="text-caption text-fg-subtle">{Math.round(percentage)}% of quota</p>
        <div className="mt-2 flex items-center justify-center">
          <Badge variant="neutral" size="sm">
            {Math.round(confidence * 100)}% confidence
          </Badge>
        </div>
      </div>
    </div>
  );
};

/**
 * FileTypeCard — per-type storage breakdown tile.
 */
const FileTypeCard: React.FC<FileTypeCardProps> = ({ type, count, size }) => {
  const icons: Record<string, LucideIcon> = {
    documents: FileText,
    images: Image,
    videos: Video,
    audio: Music,
    archives: Archive,
    code: Code,
  };

  const Icon = icons[type.toLowerCase()] || FileText;

  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      <div className="mb-2 flex items-center gap-3">
        <Icon size={20} className="text-primary" />
        <span className="font-medium capitalize text-fg">{type}</span>
      </div>
      <div className="text-body-sm text-fg-muted">
        <p>{count} files</p>
        <p className="font-semibold text-fg">{formatBytes(size)}</p>
      </div>
    </div>
  );
};

/**
 * SummaryCard — compact stat tile used in the optimization summary grid.
 */
const SummaryCard: React.FC<SummaryCardProps> = ({ icon: Icon, label, value, tone }) => {
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4 text-center">
      <Icon size={24} className={cn('mx-auto mb-2', summaryToneClass[tone])} />
      <p className="mb-1 text-h2 font-bold text-fg">{value}</p>
      <p className="text-caption text-fg-muted">{label}</p>
    </div>
  );
};

/**
 * EnhancedAnalyticsView — ML-powered analytics dashboard: quota predictions,
 * active quota alerts, optimization suggestions, storage breakdown, usage
 * history, and an optimization summary.
 */
const EnhancedAnalyticsView: React.FC<EnhancedAnalyticsViewProps> = () => {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const loadAnalytics = async (forceRefresh = false): Promise<void> => {
    try {
      setLoading(!forceRefresh);
      setRefreshing(forceRefresh);
      setError(null);

      const analyticsData = await analyticsService.getDashboardData();
      setData(analyticsData as unknown as AnalyticsData);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[Analytics] Failed to load:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAnalytics();
  }, []);

  const handleDismissAlert = async (alertId: string): Promise<void> => {
    try {
      await analyticsService.dismissAlert(alertId);
      const alerts = await analyticsService.getQuotaAlerts();
      setData((prev) => {
        if (!prev) return null;
        const newData: AnalyticsData = { ...prev };
        newData.alerts = alerts as unknown as QuotaAlert[];
        return newData;
      });
    } catch (err: unknown) {
      console.error('[Analytics] Failed to dismiss alert:', err);
    }
  };

  const handleDismissSuggestion = async (suggestionId: string): Promise<void> => {
    try {
      await analyticsService.dismissSuggestion(suggestionId);
      const suggestions = await analyticsService.getOptimizationSuggestions();
      setData((prev) => {
        if (!prev) return null;
        const typedSuggestions = suggestions as unknown as AnalyticsData['suggestions'];
        const newData: AnalyticsData = { ...prev };
        if (typedSuggestions !== undefined) {
          newData.suggestions = typedSuggestions;
        }
        return newData;
      });
    } catch (err: unknown) {
      console.error('[Analytics] Failed to dismiss suggestion:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <Spinner size="lg" />
        <p className="text-body-sm text-fg-muted">Loading analytics data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Card variant="bordered">
        <CardContent>
          <div className="mb-4 flex items-center gap-3 text-danger">
            <AlertCircle size={24} />
            <h2 className="text-h3 font-semibold">Failed to load analytics</h2>
          </div>
          <p className="mb-4 text-body-sm text-fg-muted">{error}</p>
          <Button variant="primary" size="sm" onClick={() => loadAnalytics(true)}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { prediction, history, alerts, analysis, suggestions, summary } = data || {};

  return (
    <div className="space-y-6">
      {/* Header with refresh */}
      <Card variant="bordered">
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BarChart3 size={24} className="text-primary" />
              <div>
                <h1 className="text-h1 font-bold text-fg">Analytics dashboard</h1>
                <p className="text-body-sm text-fg-muted">AI-powered insights and predictions</p>
              </div>
            </div>
            <IconButton
              variant="ghost"
              size="sm"
              onClick={() => loadAnalytics(true)}
              disabled={refreshing}
              aria-label="Refresh analytics"
              title="Refresh analytics"
            >
              <RefreshCw size={20} className={cn(refreshing && 'animate-spin')} />
            </IconButton>
          </div>
        </CardContent>
      </Card>

      {/* Quota prediction */}
      {prediction && (
        <Card variant="bordered">
          <CardContent>
            <div className="mb-4 flex items-center gap-3">
              <Brain size={20} className="text-accent" />
              <h2 className="text-h3 font-semibold text-fg">Quota prediction (ML-powered)</h2>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              {prediction.predicted_7d &&
                prediction.quota_bytes &&
                prediction.confidence_7d !== undefined && (
                  <PredictionCard
                    title="7 days"
                    predicted={prediction.predicted_7d}
                    quota={prediction.quota_bytes}
                    confidence={prediction.confidence_7d}
                  />
                )}
              {prediction.predicted_14d &&
                prediction.quota_bytes &&
                prediction.confidence_14d !== undefined && (
                  <PredictionCard
                    title="14 days"
                    predicted={prediction.predicted_14d}
                    quota={prediction.quota_bytes}
                    confidence={prediction.confidence_14d}
                  />
                )}
              {prediction.predicted_30d &&
                prediction.quota_bytes &&
                prediction.confidence_30d !== undefined && (
                  <PredictionCard
                    title="30 days"
                    predicted={prediction.predicted_30d}
                    quota={prediction.quota_bytes}
                    confidence={prediction.confidence_30d}
                  />
                )}
            </div>

            {prediction.days_until_full !== null &&
              prediction.days_until_full !== undefined && (
                <Banner
                  variant={
                    prediction.days_until_full <= 7
                      ? 'danger'
                      : prediction.days_until_full <= 14
                      ? 'warning'
                      : 'success'
                  }
                  icon={<Clock className="h-5 w-5" />}
                >
                  <p className="font-semibold text-fg">
                    {prediction.days_until_full} days until quota full
                  </p>
                </Banner>
              )}
          </CardContent>
        </Card>
      )}

      {/* Active alerts */}
      {alerts && alerts.length > 0 && (
        <Card variant="bordered">
          <CardContent>
            <div className="mb-4 flex items-center gap-3">
              <AlertTriangle size={20} className="text-warning" />
              <h2 className="text-h3 font-semibold text-fg">Active alerts ({alerts.length})</h2>
            </div>

            <div className="space-y-3">
              {alerts.map((alert) => {
                const alertVariant: 'danger' | 'warning' | 'info' =
                  alert.alert_type === '95_percent'
                    ? 'danger'
                    : alert.alert_type === '85_percent'
                    ? 'warning'
                    : 'info';

                return (
                  <div
                    key={alert.id}
                    className="flex items-start justify-between rounded-lg border border-border bg-surface-muted p-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <Badge variant={alertVariant} size="sm">
                          {alert.alert_type.replace('_', ' ').toUpperCase()}
                        </Badge>
                      </div>
                      <p className="text-body-sm text-fg-muted">{alert.message}</p>
                      <p className="mt-1 text-caption text-fg-subtle">
                        {formatDate(alert.created_at)}
                      </p>
                    </div>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDismissAlert(alert.id)}
                      aria-label="Dismiss alert"
                    >
                      <X size={16} />
                    </IconButton>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Optimization suggestions */}
      {suggestions && suggestions.length > 0 && (
        <Card variant="bordered">
          <CardContent>
            <div className="mb-4 flex items-center gap-3">
              <Sparkles size={20} className="text-primary" />
              <h2 className="text-h3 font-semibold text-fg">
                Optimization suggestions ({suggestions.length})
              </h2>
            </div>

            <div className="space-y-3">
              {suggestions.map((suggestion) => {
                const impactVariant: 'success' | 'warning' | 'info' =
                  suggestion.impact === 'high'
                    ? 'success'
                    : suggestion.impact === 'medium'
                    ? 'warning'
                    : 'info';

                return (
                  <div
                    key={suggestion.id}
                    className="rounded-lg border border-border bg-surface-muted p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex items-center gap-2">
                          <Badge variant={impactVariant} size="sm">
                            {suggestion.impact.toUpperCase()} IMPACT
                          </Badge>
                          {suggestion.potential_savings && (
                            <span className="text-body-sm font-semibold text-success">
                              Save {formatBytes(suggestion.potential_savings)}
                            </span>
                          )}
                        </div>
                        <p className="mb-1 text-body-sm font-medium text-fg">{suggestion.title}</p>
                        <p className="text-body-sm text-fg-muted">{suggestion.description}</p>
                      </div>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDismissSuggestion(suggestion.id)}
                        aria-label="Dismiss suggestion"
                      >
                        <X size={16} />
                      </IconButton>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Storage analysis */}
      {analysis?.file_type_distribution && (
        <Card variant="bordered">
          <CardContent>
            <div className="mb-4 flex items-center gap-3">
              <HardDrive size={20} className="text-primary" />
              <h2 className="text-h3 font-semibold text-fg">Storage breakdown</h2>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Object.entries(analysis.file_type_distribution).map(([type, dist]) => (
                <FileTypeCard key={type} type={type} count={dist.count} size={dist.size} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage history */}
      {history?.history && history.history.length > 0 && (
        <Card variant="bordered">
          <CardContent>
            <div className="mb-4 flex items-center gap-3">
              <Activity size={20} className="text-accent" />
              <h2 className="text-h3 font-semibold text-fg">Usage trend</h2>
            </div>

            <div className="space-y-2">
              {history.history.slice(-7).map((point, index) => {
                const points = history.history ?? [];
                const prevPoint = index > 0 ? points[index - 1] : undefined;
                const diff = prevPoint ? point.bytes_used - prevPoint.bytes_used : 0;

                return (
                  <div
                    key={index}
                    className="flex items-center justify-between rounded-lg bg-surface-muted p-3"
                  >
                    <span className="text-body-sm text-fg-muted">
                      {formatDate(point.timestamp)}
                    </span>
                    <span className="text-body-sm font-medium text-fg">
                      {formatBytes(point.bytes_used)}
                    </span>
                    {prevPoint && (
                      <span
                        className={cn(
                          'flex items-center gap-1 text-caption',
                          diff > 0 ? 'text-danger' : 'text-success'
                        )}
                      >
                        {diff > 0 ? (
                          <>
                            <TrendingUp size={12} />+{formatBytes(diff)}
                          </>
                        ) : (
                          <>
                            <TrendingDown size={12} />-{formatBytes(-diff)}
                          </>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Optimization summary */}
      {summary && (
        <Card variant="bordered">
          <CardContent>
            <h2 className="mb-4 text-h3 font-semibold text-fg">Optimization summary</h2>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <SummaryCard
                icon={Zap}
                label="Potential savings"
                value={formatBytes(summary.total_potential_savings || 0)}
                tone="success"
              />
              <SummaryCard
                icon={Target}
                label="Active suggestions"
                value={summary.active_suggestions || 0}
                tone="primary"
              />
              <SummaryCard
                icon={CheckCircle}
                label="Applied"
                value={summary.applied_suggestions || 0}
                tone="accent"
              />
              <SummaryCard
                icon={Activity}
                label="Efficiency score"
                value={`${Math.round((summary.efficiency_score || 0) * 100)}%`}
                tone="warning"
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default EnhancedAnalyticsView;
