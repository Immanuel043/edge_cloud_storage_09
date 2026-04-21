import React, { useState, useEffect } from 'react';
import {
  Target,
  AlertTriangle,
  AlertCircle,
  Bell,
  TrendingUp,
  Calendar,
  HardDrive,
  RefreshCw,
  Check,
  X,
  Info,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import type { QuotaAlertsViewProps, QuotaPrediction, QuotaAlert } from './types';
import { getErrorMessage } from './types';
import { formatBytes } from '../../utils/helpers';
import { useTheme } from '../../contexts/ThemeContext';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  IconButton,
  Progress,
  Spinner,
} from '@/components/ui';

type BannerVariant = 'danger' | 'warning' | 'info';

/**
 * QuotaAlertsView — storage quota monitoring. Shows current usage with a
 * color-coded Progress, ML-based 7/14/30-day predictions, a forecast SVG
 * chart with quota-line overlay, and a list of active alerts rendered via
 * Banner primitives. Dismissible alerts POST to /api/v1/quota/alerts/dismiss.
 */
const QuotaAlertsView: React.FC<QuotaAlertsViewProps> = ({ storageStats }) => {
  const { darkMode } = useTheme();
  const [prediction, setPrediction] = useState<QuotaPrediction | null>(null);
  const [alerts, setAlerts] = useState<QuotaAlert[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [dismissing, setDismissing] = useState<string | null>(null);

  const fetchData = async (isRefresh = false): Promise<void> => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const [predictionRes, alertsRes] = await Promise.allSettled([
        fetch(`${API_URL}/api/v1/quota/prediction`, { credentials: 'include' }),
        fetch(`${API_URL}/api/v1/quota/alerts`, { credentials: 'include' }),
      ]);

      if (predictionRes.status === 'fulfilled' && predictionRes.value.ok) {
        const predData = (await predictionRes.value.json()) as QuotaPrediction;
        setPrediction(predData);
      }

      if (alertsRes.status === 'fulfilled' && alertsRes.value.ok) {
        const alertsData = (await alertsRes.value.json()) as
          | QuotaAlert[]
          | { alerts?: QuotaAlert[] };
        const alertsArray = Array.isArray(alertsData)
          ? alertsData
          : (alertsData as { alerts?: QuotaAlert[] }).alerts || [];
        setAlerts(alertsArray);
      }
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[QuotaAlerts] Failed to load:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  const dismissAlert = async (alertId: string): Promise<void> => {
    try {
      setDismissing(alertId);
      const response = await fetch(`${API_URL}/api/v1/quota/alerts/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ alert_id: alertId }),
      });
      if (response.ok) {
        setAlerts((prev) => prev.filter((a) => a.id !== alertId));
      }
    } catch (err: unknown) {
      console.error('Failed to dismiss alert:', err);
    } finally {
      setDismissing(null);
    }
  };

  const getAlertIcon = (alertType: string): React.ReactElement => {
    switch (alertType) {
      case '95_percent':
        return <AlertTriangle />;
      case '85_percent':
        return <AlertCircle />;
      case '70_percent':
        return <Bell />;
      case 'predicted_full':
        return <TrendingUp />;
      default:
        return <Info />;
    }
  };

  const getAlertVariant = (alertType: string): BannerVariant => {
    switch (alertType) {
      case '95_percent':
      case '85_percent':
        return 'danger';
      case '70_percent':
      case 'predicted_full':
        return 'warning';
      default:
        return 'info';
    }
  };

  const getAlertSeverityText = (alertType: string): string => {
    switch (alertType) {
      case '95_percent':
        return 'Critical';
      case '85_percent':
        return 'Warning';
      case '70_percent':
        return 'Notice';
      case 'predicted_full':
        return 'Prediction';
      default:
        return 'Info';
    }
  };

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
        title="Failed to load quota alerts"
        action={
          <Button variant="primary" size="sm" onClick={() => void fetchData()}>
            Retry
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  const usagePercent =
    storageStats?.percentage_used ||
    (prediction?.usage_percent ? prediction.usage_percent * 100 : 0) ||
    0;

  const usageTone: 'primary' | 'warning' | 'danger' =
    usagePercent > 90 ? 'danger' : usagePercent > 70 ? 'warning' : 'primary';

  const statusVariant: 'success' | 'warning' | 'danger' =
    usagePercent > 90 ? 'danger' : usagePercent > 70 ? 'warning' : 'success';

  const statusText = usagePercent > 90 ? 'Critical' : usagePercent > 70 ? 'Warning' : 'Healthy';

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-3">
                <Target className="h-6 w-6 text-primary" />
                <h1 className="text-h2 font-bold text-fg">Quota alerts</h1>
              </div>
              <p className="text-body-sm text-fg-muted">
                Monitor your storage usage and predictive warnings
              </p>
            </div>
            <IconButton
              variant="ghost"
              size="md"
              aria-label="Refresh"
              onClick={() => void fetchData(true)}
              disabled={refreshing}
            >
              <RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
            </IconButton>
          </div>
        </CardContent>
      </Card>

      {/* Current Usage */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <HardDrive className="h-5 w-5 text-primary" />
            Current storage usage
          </h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="md:col-span-2">
              <div className="mb-2 flex justify-between text-body-sm">
                <span className="text-fg">
                  {formatBytes(storageStats?.used || prediction?.current_usage_bytes || 0)}
                </span>
                <span className="text-fg-muted">
                  {formatBytes(storageStats?.quota || prediction?.quota_bytes || 0)}
                </span>
              </div>
              <Progress value={Math.min(usagePercent, 100)} tone={usageTone} size="lg" />
              <p className="mt-2 text-body-sm text-fg-muted">
                {usagePercent.toFixed(1)}% of your storage quota used
              </p>
            </div>
            <div className="flex items-center justify-center">
              <Badge variant={statusVariant} size="md">
                {statusText}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Predictions */}
      {prediction && (
        <Card variant="bordered">
          <CardContent className="p-6">
            <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
              <TrendingUp className="h-5 w-5 text-accent" />
              ML-based predictions
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <PredictionCard
                label="Days until full"
                icon={<Calendar className="h-4 w-4 text-primary" />}
                value={prediction.days_until_full !== null ? prediction.days_until_full : 'N/A'}
                footnote={
                  prediction.will_exceed_quota
                    ? 'Will exceed quota within 30 days'
                    : undefined
                }
                footnoteTone={prediction.will_exceed_quota ? 'danger' : undefined}
              />
              <PredictionCard
                label="7-day forecast"
                value={formatBytes(prediction.predicted_7d || 0)}
                confidence={prediction.confidence_7d}
              />
              <PredictionCard
                label="14-day forecast"
                value={formatBytes(prediction.predicted_14d || 0)}
                confidence={prediction.confidence_14d}
              />
              <PredictionCard
                label="30-day forecast"
                value={formatBytes(prediction.predicted_30d || 0)}
                confidence={prediction.confidence_30d}
              />
            </div>
            {prediction.model_type && (
              <p className="mt-4 text-caption text-fg-muted">
                Prediction model: {prediction.model_type} · Last updated:{' '}
                {prediction.prediction_date
                  ? new Date(prediction.prediction_date).toLocaleString()
                  : 'N/A'}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Prediction Chart */}
      {prediction &&
        (prediction.predicted_7d || prediction.predicted_14d || prediction.predicted_30d) &&
        (() => {
          const currentBytes = storageStats?.used || prediction.current_usage_bytes || 0;
          const quotaBytes = storageStats?.quota || prediction.quota_bytes || 1;
          const points = [
            { day: 0, bytes: currentBytes, label: 'Now' },
            { day: 7, bytes: prediction.predicted_7d || currentBytes, label: '7d' },
            { day: 14, bytes: prediction.predicted_14d || currentBytes, label: '14d' },
            { day: 30, bytes: prediction.predicted_30d || currentBytes, label: '30d' },
          ];
          const maxBytes = Math.max(quotaBytes * 1.1, ...points.map((p) => p.bytes));
          const W = 600,
            H = 200,
            PL = 70,
            PR = 20,
            PT = 20,
            PB = 40;
          const cw = W - PL - PR,
            ch = H - PT - PB;
          const x = (d: number) => PL + (d / 30) * cw;
          const y = (b: number) => PT + ch - (b / maxBytes) * ch;
          const quotaY = y(quotaBytes);
          const pathD = points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p.bytes).toFixed(1)}`)
            .join(' ');
          const areaD =
            pathD +
            ` L${x(30).toFixed(1)},${(PT + ch).toFixed(1)} L${x(0).toFixed(1)},${(PT + ch).toFixed(1)} Z`;
          const gridStroke = darkMode ? '#374151' : '#e5e7eb';
          const axisFill = darkMode ? '#9ca3af' : '#6b7280';
          const pointFill = darkMode ? '#1f2937' : '#fff';
          const labelFill = darkMode ? '#d1d5db' : '#374151';

          return (
            <Card variant="bordered">
              <CardContent className="p-6">
                <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
                  <TrendingUp className="h-5 w-5 text-accent" />
                  Usage forecast
                </h2>
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }}>
                  {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                    const yPos = PT + ch - f * ch;
                    return (
                      <g key={f}>
                        <line
                          x1={PL}
                          y1={yPos}
                          x2={W - PR}
                          y2={yPos}
                          stroke={gridStroke}
                          strokeWidth={1}
                        />
                        <text
                          x={PL - 8}
                          y={yPos + 4}
                          textAnchor="end"
                          fontSize={10}
                          fill={axisFill}
                        >
                          {formatBytes(f * maxBytes)}
                        </text>
                      </g>
                    );
                  })}
                  <line
                    x1={PL}
                    y1={quotaY}
                    x2={W - PR}
                    y2={quotaY}
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                  />
                  <text x={W - PR + 2} y={quotaY + 4} fontSize={9} fill="#ef4444">
                    Quota
                  </text>
                  <path
                    d={areaD}
                    fill={darkMode ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.1)'}
                  />
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#6366f1"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {points.map((p) => (
                    <g key={p.day}>
                      <circle
                        cx={x(p.day)}
                        cy={y(p.bytes)}
                        r={4}
                        fill="#6366f1"
                        stroke={pointFill}
                        strokeWidth={2}
                      />
                      <text
                        x={x(p.day)}
                        y={PT + ch + 16}
                        textAnchor="middle"
                        fontSize={10}
                        fill={axisFill}
                      >
                        {p.label}
                      </text>
                      <text
                        x={x(p.day)}
                        y={y(p.bytes) - 10}
                        textAnchor="middle"
                        fontSize={9}
                        fill={labelFill}
                      >
                        {formatBytes(p.bytes)}
                      </text>
                    </g>
                  ))}
                </svg>
              </CardContent>
            </Card>
          );
        })()}

      {/* Active Alerts */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <Bell className="h-5 w-5 text-warning" />
            Active alerts
            {alerts.length > 0 && (
              <Badge variant="danger" size="sm">
                {alerts.length}
              </Badge>
            )}
          </h2>
          {alerts.length === 0 ? (
            <EmptyState
              icon={<Check />}
              title="No active alerts"
              description="Your storage usage is within healthy limits."
              size="md"
            />
          ) : (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <Banner
                  key={alert.id}
                  variant={getAlertVariant(alert.alert_type)}
                  icon={getAlertIcon(alert.alert_type)}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {alert.message}
                      <Badge variant="neutral" size="sm">
                        {getAlertSeverityText(alert.alert_type)}
                      </Badge>
                    </span>
                  }
                  action={
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Dismiss alert"
                      onClick={() => void dismissAlert(alert.id)}
                      disabled={dismissing === alert.id}
                      loading={dismissing === alert.id}
                    >
                      <X className="h-4 w-4" />
                    </IconButton>
                  }
                >
                  <p className="text-body-sm">
                    Current usage: {formatBytes(alert.current_usage_bytes)} /{' '}
                    {formatBytes(alert.quota_bytes)} ({alert.usage_percent?.toFixed(1)}%)
                  </p>
                  <p className="mt-1 text-caption text-fg-muted">
                    {new Date(alert.created_at).toLocaleString()}
                  </p>
                </Banner>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tips */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-h3 font-semibold text-fg">
            <Info className="h-5 w-5 text-primary" />
            Storage tips
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TipCard
              title="Delete unused files"
              description="Check your Trash and remove files you no longer need."
            />
            <TipCard
              title="Use deduplication"
              description="Our smart dedup can save up to 60% storage by removing duplicate content."
            />
            <TipCard
              title="Archive old files"
              description="Move rarely accessed files to cold storage tier."
            />
            <TipCard
              title="Upgrade your plan"
              description="Need more space? Consider upgrading to Business or Enterprise."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

const PredictionCard: React.FC<{
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  confidence?: number | undefined;
  footnote?: string | undefined;
  footnoteTone?: 'danger' | undefined;
}> = ({ label, value, icon, confidence, footnote, footnoteTone }) => (
  <div className="rounded-xl border border-border bg-surface-muted p-4">
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-body-sm text-fg-muted">
        {icon}
        {label}
      </span>
      {confidence !== undefined && (
        <span className="text-caption text-success">{((confidence || 0) * 100).toFixed(0)}% conf</span>
      )}
    </div>
    <p className="text-h3 font-bold text-fg">{value}</p>
    {footnote && (
      <p
        className={`mt-1 text-caption ${
          footnoteTone === 'danger' ? 'text-danger' : 'text-fg-muted'
        }`}
      >
        {footnote}
      </p>
    )}
  </div>
);

const TipCard: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <div className="rounded-lg bg-surface-muted p-3">
    <p className="text-body-sm text-fg">
      <strong className="text-fg">{title}:</strong> {description}
    </p>
  </div>
);

export default QuotaAlertsView;
