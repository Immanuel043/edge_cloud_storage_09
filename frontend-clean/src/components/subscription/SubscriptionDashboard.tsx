import { useState, useCallback, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSubscription } from '../../contexts/SubscriptionContext';
import PlanChangeModal from './PlanChangeModal';
import {
  Crown,
  Calendar,
  HardDrive,
  Gauge,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import type {
  PlanDisplay,
  SubscriptionWarning,
  SubscriptionRecommendation,
  FeatureObject,
} from '../../types/subscription-components.types';
import {
  isSubscriptionDisplay,
  isUsageDisplay,
} from '../../types/subscription-components.types';
import { cn } from '@/lib/cn';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  Progress,
  Skeleton,
} from '@/components/ui';

/**
 * SubscriptionDashboard — current plan, usage, recommendations, and entry
 * points to the full pricing page + payment portal.
 *
 * Rebuilt on Signal primitives: Card for each section, Progress for usage
 * meters, Banner for warnings, Button for CTAs. Business logic (plan
 * matching, modal open/close, warning dispatch) is preserved.
 */
interface SubscriptionDashboardProps {
  onOpenPaymentPortal?: () => void;
}

export default function SubscriptionDashboard({
  onOpenPaymentPortal,
}: SubscriptionDashboardProps = {}): ReactElement {
  const navigate = useNavigate();
  const {
    subscription,
    availablePlans,
    usage,
    warnings,
    recommendations,
    loading,
    error,
    refresh,
  } = useSubscription();

  const [selectedPlan, setSelectedPlan] = useState<PlanDisplay | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const handlePlanSelect = useCallback(
    (planCode: string): void => {
      const plan = availablePlans.find((p) => {
        const planCodeMatch =
          (p as { planCode?: string; plan_code?: string }).planCode === planCode ||
          (p as { planCode?: string; plan_code?: string }).plan_code === planCode;
        return planCodeMatch;
      });

      if (plan) {
        const planData = plan as {
          planCode?: string;
          plan_code?: string;
          displayName?: string;
          display_name?: string;
          priceMonthly?: number;
          price_monthly?: number;
          priceYearly?: number;
          price_yearly?: number;
          storageGb?: number;
          storage_gb?: number;
          bandwidthMbps?: number;
          bandwidth_mbps?: number;
          features?: unknown;
          tier?: number;
          [key: string]: unknown;
        };

        const planDisplay: PlanDisplay = {
          plan_code: planData.plan_code || planData.planCode || planCode,
          display_name: planData.display_name || planData.displayName || planCode,
          description: '',
          price_monthly: planData.price_monthly ?? planData.priceMonthly ?? null,
          price_six_months: null,
          price_yearly: planData.price_yearly ?? planData.priceYearly ?? null,
          storage_gb: planData.storage_gb ?? planData.storageGb ?? 0,
          bandwidth_mbps: planData.bandwidth_mbps ?? planData.bandwidthMbps ?? 0,
          max_concurrent_streams: 5,
          features: Array.isArray(planData.features)
            ? (planData.features as (string | FeatureObject)[])
            : [],
          tier: planData.tier,
        };

        const currentPlanCode =
          (subscription as { plan_code?: string; planCode?: string })?.plan_code ||
          (subscription as { plan_code?: string; planCode?: string })?.planCode;

        if (planDisplay.plan_code !== currentPlanCode) {
          setSelectedPlan(planDisplay);
          setModalOpen(true);
        }
      }
    },
    [availablePlans, subscription]
  );

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const handleCloseModal = useCallback((): void => {
    setModalOpen(false);
    setSelectedPlan(null);
  }, []);

  if (loading) {
    return <SubscriptionDashboardSkeleton />;
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto p-6">
        <Banner
          variant="danger"
          title="Error loading subscription"
          action={
            <Button variant="primary" size="sm" onClick={() => void handleRefresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </Banner>
      </div>
    );
  }

  const subscriptionDisplay =
    subscription && isSubscriptionDisplay(subscription)
      ? (subscription as unknown as import('../../types/subscription-components.types').SubscriptionDisplay)
      : null;
  const usageDisplay =
    usage && isUsageDisplay(usage)
      ? (usage as unknown as import('../../types/subscription-components.types').UsageDisplay)
      : null;

  const statusBadgeVariant = (status: string) =>
    status === 'active' ? 'success' : status === 'past_due' ? 'danger' : 'warning';

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-h1 font-semibold text-fg">Subscription & billing</h1>
          <p className="text-body text-fg-muted mt-1">Manage your plan and usage</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          leftIcon={
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          }
        >
          Refresh
        </Button>
      </div>

      {/* Warnings */}
      {warnings && warnings.length > 0 && (
        <div className="space-y-3">
          {warnings.map((warning, index) => {
            const w = warning as SubscriptionWarning;
            return (
              <Banner
                key={index}
                variant={w.severity === 'critical' ? 'danger' : 'warning'}
                icon={<AlertCircle />}
                {...(w.action_label
                  ? {
                      action: (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            window.dispatchEvent(new CustomEvent('openUpgradeModal'))
                          }
                        >
                          {w.action_label}
                        </Button>
                      ),
                    }
                  : {})}
              >
                {w.message}
              </Banner>
            );
          })}
        </div>
      )}

      {/* Current plan card */}
      {subscriptionDisplay && (
        <Card variant="elevated" className="bg-gradient-to-br from-primary/5 to-accent/5 border-primary/20">
          <CardContent className="p-6">
            <div className="flex items-start justify-between mb-6 gap-4">
              <div className="flex items-center gap-3">
                <div
                  aria-hidden
                  className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-white"
                >
                  <Crown className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-h3 font-semibold text-fg">
                    {subscriptionDisplay.plan_name}
                  </h2>
                  <div className="mt-1 flex items-center gap-2 text-body-sm">
                    <span className="text-fg-muted">Status:</span>
                    <Badge
                      variant={statusBadgeVariant(subscriptionDisplay.status)}
                      size="sm"
                    >
                      {subscriptionDisplay.status}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-h2 font-bold text-fg">
                  {subscriptionDisplay.price_display || 'Free'}
                </p>
                {!subscriptionDisplay.plan_code.includes('free') &&
                  subscriptionDisplay.billing_cycle && (
                    <p className="text-body-sm text-fg-muted">
                      per{' '}
                      {subscriptionDisplay.billing_cycle === 'six_months'
                        ? '6 months'
                        : subscriptionDisplay.billing_cycle.replace('_', ' ')}
                    </p>
                  )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-lg bg-surface p-4 border border-border">
                <div className="flex items-center gap-2 text-fg-muted mb-2">
                  <HardDrive className="h-4 w-4" />
                  <span className="text-body-sm font-medium">Storage quota</span>
                </div>
                <p className="text-h2 font-bold text-fg">
                  {subscriptionDisplay.storage_quota_gb} GB
                </p>
              </div>

              <div className="rounded-lg bg-surface p-4 border border-border">
                <div className="flex items-center gap-2 text-fg-muted mb-2">
                  <Gauge className="h-4 w-4" />
                  <span className="text-body-sm font-medium">Bandwidth limit</span>
                </div>
                <p className="text-h2 font-bold text-fg">
                  {subscriptionDisplay.bandwidth_quota_mbps} Mbps
                </p>
              </div>

              {subscriptionDisplay.next_billing_date && (
                <div className="rounded-lg bg-surface p-4 border border-border">
                  <div className="flex items-center gap-2 text-fg-muted mb-2">
                    <Calendar className="h-4 w-4" />
                    <span className="text-body-sm font-medium">Next billing</span>
                  </div>
                  <p className="text-body font-semibold text-fg">
                    {new Date(subscriptionDisplay.next_billing_date).toLocaleDateString()}
                  </p>
                  {subscriptionDisplay.days_until_renewal != null && (
                    <p
                      className={cn(
                        'text-body-sm font-medium mt-1',
                        subscriptionDisplay.days_until_renewal > 14
                          ? 'text-success'
                          : subscriptionDisplay.days_until_renewal > 7
                            ? 'text-warning'
                            : 'text-danger'
                      )}
                    >
                      {subscriptionDisplay.days_until_renewal} day
                      {subscriptionDisplay.days_until_renewal !== 1 ? 's' : ''} remaining
                    </p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage */}
      {usageDisplay && (
        <Card variant="bordered">
          <CardContent className="p-6">
            <h2 className="text-h3 font-semibold text-fg mb-4">Current usage</h2>

            {/* Storage */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-primary" />
                  <span className="font-medium text-fg">Storage</span>
                </div>
                <span className="text-body-sm text-fg-muted">
                  {usageDisplay.storage_used_display} /{' '}
                  {usageDisplay.storage_quota_display}
                </span>
              </div>
              <Progress
                value={Math.min(usageDisplay.storage_percent, 100)}
                tone={
                  usageDisplay.storage_percent >= 95
                    ? 'danger'
                    : usageDisplay.storage_percent >= 80
                      ? 'warning'
                      : 'primary'
                }
              />
              <div className="flex items-center justify-between mt-1">
                <p className="text-body-sm text-fg-muted">
                  {usageDisplay.storage_percent.toFixed(1)}% used
                </p>
                {usageDisplay.storage_remaining_display && (
                  <p
                    className={cn(
                      'text-body-sm font-medium',
                      usageDisplay.storage_percent >= 95
                        ? 'text-danger'
                        : usageDisplay.storage_percent >= 80
                          ? 'text-warning'
                          : 'text-success'
                    )}
                  >
                    {usageDisplay.storage_remaining_display}
                  </p>
                )}
              </div>
            </div>

            {/* Bandwidth */}
            {usageDisplay.bandwidth_used_display && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Gauge className="h-5 w-5 text-success" />
                    <span className="font-medium text-fg">Bandwidth</span>
                  </div>
                  <span className="text-body-sm text-fg-muted">
                    Current: {usageDisplay.bandwidth_used_display}
                  </span>
                </div>
                {usageDisplay.bandwidth_quota_display && (
                  <p className="text-body-sm text-fg-muted">
                    Limit: {usageDisplay.bandwidth_quota_display}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      {recommendations && recommendations.length > 0 && (
        <Card variant="bordered" className="bg-accent/5 border-accent/20">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="h-5 w-5 text-accent" />
              <h2 className="text-h3 font-semibold text-fg">Recommended for you</h2>
            </div>
            <div className="space-y-3">
              {recommendations.map((rec, index) => {
                const r = rec as SubscriptionRecommendation;
                return (
                  <div
                    key={index}
                    className="rounded-lg bg-surface p-4 border border-border"
                  >
                    <p className="text-body-sm font-medium text-fg">
                      {r.message || r.reason || 'Recommended plan'}
                    </p>
                    {r.plan_code && (
                      <button
                        type="button"
                        onClick={() => handlePlanSelect(r.plan_code!)}
                        className="mt-2 text-body-sm font-medium text-accent hover:text-accent/80 transition-colors"
                      >
                        View {r.plan_name || r.plan_code} →
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upgrade CTA */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h2 className="text-h2 font-semibold text-fg mb-3">Upgrade your plan</h2>
          <p className="text-body text-fg-muted mb-5">
            Explore our range of plans and upgrade to get more storage, bandwidth, and
            premium features.
          </p>
          <Button
            variant="primary"
            size="lg"
            leftIcon={<TrendingUp className="h-5 w-5" />}
            onClick={() => navigate('/pricing')}
          >
            View all plans
          </Button>
        </CardContent>
      </Card>

      {/* Payment portal */}
      <Card variant="bordered" className="bg-surface-muted">
        <CardContent className="p-6">
          <h3 className="text-h3 font-semibold text-fg mb-2">Payment & invoices</h3>
          <p className="text-body-sm text-fg-muted mb-4">
            View payment history, manage payment methods, and track your invoices.
          </p>
          <Button
            variant="primary"
            size="md"
            leftIcon={<ExternalLink className="h-4 w-4" />}
            onClick={onOpenPaymentPortal}
          >
            Open payment portal
          </Button>
        </CardContent>
      </Card>

      {/* Plan change modal */}
      {selectedPlan && (
        <PlanChangeModal
          isOpen={modalOpen}
          onClose={handleCloseModal}
          targetPlan={selectedPlan}
        />
      )}
    </div>
  );
}

/**
 * Loading skeleton
 */
function SubscriptionDashboardSkeleton(): ReactElement {
  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <Skeleton shape="text" className="h-10 w-64" />
      <Skeleton shape="rect" className="h-48 rounded-xl" />
      <Skeleton shape="rect" className="h-40 rounded-xl" />
    </div>
  );
}
