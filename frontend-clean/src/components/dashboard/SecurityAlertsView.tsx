import React, { useState, useEffect, useCallback } from 'react';
import { Shield, AlertTriangle, XCircle, CheckCircle, RefreshCw } from 'lucide-react';
import {
  getAlerts,
  dismissAlert,
  getAlertsSummary,
  type SecurityAlert,
  type AlertsSummary,
} from '../../services/securityService';
import { cn } from '@/lib/cn';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  IconButton,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';

/**
 * SecurityAlertsView — surface account-level security events (new-device
 * login, suspicious downloads, etc.). Filter tabs switch between open /
 * resolved / all. Each alert renders as a Banner variant mapped from
 * severity. Built on Signal primitives; dark-mode ternaries removed in
 * favor of token classes.
 */

interface SecurityAlertsViewProps {
  darkMode?: boolean;
}

type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_VARIANT: Record<Severity, 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
};

const SEVERITY_ICON: Record<Severity, React.ComponentType<{ className?: string }>> = {
  critical: XCircle,
  high: AlertTriangle,
  medium: AlertTriangle,
  low: Shield,
};

const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-danger',
  high: 'bg-warning',
  medium: 'bg-warning/70',
  low: 'bg-primary',
};

const toSeverity = (s: string): Severity =>
  (['critical', 'high', 'medium', 'low'] as const).includes(s as Severity)
    ? (s as Severity)
    : 'low';

const SecurityAlertsView: React.FC<SecurityAlertsViewProps> = () => {
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [summary, setSummary] = useState<AlertsSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('open');

  const loadData = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const statusParam =
        filter === 'all' ? undefined : filter === 'resolved' ? 'resolved' : 'open';
      const [alertsRes, summaryRes] = await Promise.all([
        getAlerts({ ...(statusParam ? { status: statusParam } : {}), limit: 50 }),
        getAlertsSummary(),
      ]);
      setAlerts(alertsRes.alerts);
      setSummary(summaryRes);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleDismiss = async (alertId: string): Promise<void> => {
    try {
      await dismissAlert(alertId);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
      setSummary((prev) =>
        prev ? { ...prev, total: Math.max(0, prev.total - 1) } : prev
      );
    } catch {
      // Ignore
    }
  };

  const emptyTitle =
    filter === 'open'
      ? 'No open alerts'
      : filter === 'resolved'
        ? 'No resolved alerts'
        : 'No alerts';

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-6 w-6 text-primary" />
            <h2 className="text-h3 font-semibold text-fg">Security alerts</h2>
            {summary && summary.total > 0 && (
              <Badge variant="danger" size="sm">
                {summary.total} open
              </Badge>
            )}
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Refresh alerts"
            onClick={() => void loadData()}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </IconButton>
        </div>

        {/* Summary bar */}
        {summary && summary.total > 0 && (
          <div className="mb-6 flex flex-wrap gap-4 rounded-lg border border-border bg-surface-muted p-3">
            {Object.entries(summary.by_severity).map(([sev, count]) => {
              const key = toSeverity(sev);
              return (
                <div key={sev} className="flex items-center gap-2 text-body-sm text-fg">
                  <span className={cn('h-2 w-2 rounded-full', SEVERITY_DOT[key])} />
                  <span>
                    {count} {sev}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Filter tabs */}
        <Tabs
          value={filter}
          onChange={(v) => setFilter(v as 'all' | 'open' | 'resolved')}
          variant="pill"
          className="mb-4"
        >
          <TabsList>
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="resolved">Resolved</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Alerts list */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : alerts.length === 0 ? (
          <EmptyState
            icon={<CheckCircle className="text-success" />}
            title={emptyTitle}
            description="Your account activity looks normal."
          />
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => {
              const sev = toSeverity(alert.severity);
              const Icon = SEVERITY_ICON[sev];
              return (
                <Banner
                  key={alert.id}
                  variant={SEVERITY_VARIANT[sev]}
                  icon={<Icon className="h-5 w-5" />}
                  title={alert.title}
                  action={
                    alert.status === 'open' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleDismiss(alert.id)}
                      >
                        Dismiss
                      </Button>
                    ) : undefined
                  }
                >
                  {alert.description && (
                    <p className="text-body-sm text-fg-muted">{alert.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-caption text-fg-subtle">
                    <span>{alert.alert_type.replace('_', ' ')}</span>
                    {alert.detected_at && (
                      <span>{new Date(alert.detected_at).toLocaleString()}</span>
                    )}
                    <span>Risk: {alert.risk_score}/100</span>
                  </div>
                </Banner>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default SecurityAlertsView;
