import { useState, useEffect, useCallback, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CreditCard,
  Receipt,
  Clock,
  Calendar,
  Crown,
  HardDrive,
  Gauge,
  CheckCircle,
  AlertCircle,
  XCircle,
  ExternalLink,
  RefreshCw,
  TrendingUp,
  Shield,
  Key,
  ChevronRight,
  FileText,
  ArrowUpCircle,
  ArrowDownCircle,
  RotateCcw,
  AlertTriangle,
  Ban,
  Zap,
  Download,
} from 'lucide-react';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useAuth } from '../../contexts/AuthContext';
import subscriptionService from '../../services/subscriptionService';
import type {
  UpcomingPayment,
  SubscriptionHistoryEntry,
  Invoice,
} from '../../services/subscriptionService';
import { isSubscriptionDisplay } from '../../types/subscription-components.types';
import type { SubscriptionDisplay } from '../../types/subscription-components.types';
import { cn } from '@/lib/cn';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  IconButton,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import type { BadgeProps } from '@/components/ui';

/**
 * PaymentPortal — the billing/payments hub (overview, history, methods,
 * invoices) reachable from the SubscriptionDashboard. Rebuilt on Signal
 * primitives (Card, Tabs, Banner, Badge, EmptyState, Spinner). Business
 * logic preserved: upcoming payment + history + invoice fetching, Razorpay
 * vs. Stripe branching, PDF invoice download, Stripe billing portal
 * redirect.
 */

type PortalTab = 'overview' | 'history' | 'methods' | 'invoices';

interface PaymentPortalProps {
  onBack: () => void;
}

export default function PaymentPortal({ onBack }: PaymentPortalProps): ReactElement {
  const navigate = useNavigate();
  const { subscription, loading: subLoading, refresh } = useSubscription();
  const { zkEnabled } = useAuth();

  const [activeTab, setActiveTab] = useState<PortalTab>('overview');
  const [upcomingPayment, setUpcomingPayment] = useState<UpcomingPayment | null>(null);
  const [history, setHistory] = useState<SubscriptionHistoryEntry[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loadingPayment, setLoadingPayment] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const subscriptionDisplay =
    subscription && isSubscriptionDisplay(subscription)
      ? (subscription as unknown as SubscriptionDisplay)
      : null;

  const isFree = subscriptionDisplay?.plan_code?.includes('free') ?? true;
  const isZK = zkEnabled;
  const serviceLabel = isZK ? 'Zero-Knowledge Encrypted' : 'Edge Storage';

  const fetchUpcomingPayment = useCallback(async () => {
    try {
      setLoadingPayment(true);
      const data = await subscriptionService.getUpcomingPayment();
      setUpcomingPayment(data);
    } catch {
      setUpcomingPayment(null);
    } finally {
      setLoadingPayment(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      setLoadingHistory(true);
      const data = await subscriptionService.getSubscriptionHistory();
      const entries = Array.isArray(data)
        ? data
        : (data as unknown as { history: SubscriptionHistoryEntry[] }).history ?? [];
      setHistory(entries);
    } catch {
      setHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try {
      setLoadingInvoices(true);
      const data = await subscriptionService.getInvoices();
      setInvoices(data.invoices ?? []);
    } catch {
      setInvoices([]);
    } finally {
      setLoadingInvoices(false);
    }
  }, []);

  useEffect(() => {
    void fetchUpcomingPayment();
    void fetchHistory();
    void fetchInvoices();
  }, [fetchUpcomingPayment, fetchHistory, fetchInvoices]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refresh(), fetchUpcomingPayment(), fetchHistory(), fetchInvoices()]);
    setRefreshing(false);
  }, [refresh, fetchUpcomingPayment, fetchHistory, fetchInvoices]);

  const handleOpenStripePortal = useCallback(async () => {
    try {
      setPortalLoading(true);
      const session = await subscriptionService.createBillingPortalSession();
      if (session.url) {
        window.open(session.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      console.error('Failed to open billing portal:', err);
    } finally {
      setPortalLoading(false);
    }
  }, []);

  if (subLoading) {
    return <PortalSkeleton />;
  }

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <IconButton variant="ghost" size="md" onClick={onBack} aria-label="Back to billing">
            <ArrowLeft className="h-5 w-5" />
          </IconButton>
          <div>
            <h1 className="text-h1 font-semibold text-fg">Payment portal</h1>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-body-sm text-fg-muted">
                Manage your payments and billing
              </span>
              <Badge variant={isZK ? 'accent' : 'info'} size="sm">
                {isZK ? <Shield className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                {serviceLabel}
              </Badge>
            </div>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          leftIcon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
        >
          Refresh
        </Button>
      </div>

      {/* Payment Status Banner */}
      <PaymentStatusBanner
        subscription={subscriptionDisplay}
        isFree={isFree}
        onUpgrade={() => navigate('/pricing')}
      />

      {/* Tabs */}
      <Tabs value={activeTab} onChange={(v) => setActiveTab(v as PortalTab)}>
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="overview">
            <CreditCard className="h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="history">
            <Clock className="h-4 w-4" />
            Payment history
          </TabsTrigger>
          <TabsTrigger value="methods">
            <CreditCard className="h-4 w-4" />
            Payment methods
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt className="h-4 w-4" />
            Invoices
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab
            subscription={subscriptionDisplay}
            upcomingPayment={upcomingPayment}
            loadingPayment={loadingPayment}
            history={history}
            loadingHistory={loadingHistory}
            isFree={isFree}
            isZK={isZK}
            onChangePlan={() => navigate('/pricing')}
            onSwitchTab={setActiveTab}
          />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab history={history} loading={loadingHistory} isZK={isZK} />
        </TabsContent>
        <TabsContent value="methods">
          <MethodsTab
            subscription={subscriptionDisplay}
            isFree={isFree}
            portalLoading={portalLoading}
            onOpenStripePortal={() => void handleOpenStripePortal()}
          />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTab invoices={invoices} loading={loadingInvoices} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Payment Status Banner ───────────────────────────────────────────────────

function PaymentStatusBanner({
  subscription,
  isFree,
  onUpgrade,
}: {
  subscription: SubscriptionDisplay | null;
  isFree: boolean;
  onUpgrade: () => void;
}): ReactElement | null {
  if (!subscription) return null;

  if (isFree) {
    return (
      <Banner
        variant="info"
        icon={<Crown />}
        title="You're on the Free plan"
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={onUpgrade}
            leftIcon={<TrendingUp className="h-4 w-4" />}
          >
            Upgrade now
          </Button>
        }
      >
        Upgrade to unlock more storage, bandwidth, and premium features.
      </Banner>
    );
  }

  const status = subscription.status;
  const configs: Record<
    string,
    {
      variant: 'info' | 'success' | 'warning' | 'danger';
      icon: ReactElement;
      title: string;
      message: string;
    }
  > = {
    active: {
      variant: 'success',
      icon: <CheckCircle />,
      title: 'Payment up to date',
      message: 'Your subscription is active and all payments are current.',
    },
    past_due: {
      variant: 'danger',
      icon: <AlertCircle />,
      title: 'Payment overdue',
      message:
        'Your payment is past due. Please update your payment method to avoid service interruption.',
    },
    cancelled: {
      variant: 'warning',
      icon: <XCircle />,
      title: 'Subscription cancelled',
      message: subscription.next_billing_date
        ? `Your access continues until ${new Date(subscription.next_billing_date).toLocaleDateString()}.`
        : 'Your subscription has been cancelled.',
    },
    expired: {
      variant: 'danger',
      icon: <AlertTriangle />,
      title: 'Subscription expired',
      message: 'Your subscription has expired. Renew to regain full access.',
    },
  };

  const config = configs[status] ?? configs['active']!;

  return (
    <Banner variant={config.variant} icon={config.icon} title={config.title}>
      {config.message}
    </Banner>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({
  subscription,
  upcomingPayment,
  loadingPayment,
  history,
  loadingHistory,
  isFree,
  isZK,
  onChangePlan,
  onSwitchTab,
}: {
  subscription: SubscriptionDisplay | null;
  upcomingPayment: UpcomingPayment | null;
  loadingPayment: boolean;
  history: SubscriptionHistoryEntry[];
  loadingHistory: boolean;
  isFree: boolean;
  isZK: boolean;
  onChangePlan: () => void;
  onSwitchTab: (tab: PortalTab) => void;
}): ReactElement {
  return (
    <div className="space-y-6">
      {/* Current Plan Card */}
      {subscription && (
        <Card variant="elevated" className="overflow-hidden">
          <div
            className={cn(
              'p-6',
              isZK
                ? 'bg-gradient-to-br from-accent/10 to-primary/5'
                : 'bg-gradient-to-br from-primary/10 to-accent/5'
            )}
          >
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div
                  aria-hidden
                  className={cn(
                    'flex h-12 w-12 items-center justify-center rounded-xl text-white',
                    isZK ? 'bg-accent' : 'bg-primary'
                  )}
                >
                  <Crown className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-h3 font-semibold text-fg">{subscription.plan_name}</h2>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={subscription.status} />
                    {subscription.billing_cycle && !isFree && (
                      <span className="text-caption text-fg-muted">
                        {subscription.billing_cycle === 'six_months'
                          ? '6-month'
                          : subscription.billing_cycle}{' '}
                        billing
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-left md:text-right">
                <p className="text-h2 font-bold text-fg">
                  {subscription.price_display || 'Free'}
                </p>
                {!isFree && subscription.billing_cycle && (
                  <p className="text-body-sm text-fg-muted">
                    per{' '}
                    {subscription.billing_cycle === 'six_months'
                      ? '6 months'
                      : subscription.billing_cycle}
                  </p>
                )}
              </div>
            </div>

            {/* Plan Features */}
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
              <FeatureChip
                icon={HardDrive}
                label="Storage"
                value={
                  subscription.storage_quota_gb >= 1024
                    ? `${(subscription.storage_quota_gb / 1024).toFixed(0)} TB`
                    : `${subscription.storage_quota_gb} GB`
                }
              />
              <FeatureChip
                icon={Gauge}
                label="Bandwidth"
                value={`${subscription.bandwidth_quota_mbps} Mbps`}
              />
              {isZK ? (
                <>
                  <FeatureChip icon={Shield} label="Encryption" value="Zero-Knowledge" />
                  <FeatureChip icon={Key} label="Security" value="WebAuthn" />
                </>
              ) : (
                <>
                  <FeatureChip
                    icon={Calendar}
                    label="Billing"
                    value={isFree ? 'Free' : 'Active'}
                  />
                  <FeatureChip
                    icon={Zap}
                    label="AI features"
                    value={isFree ? 'Disabled' : 'Enabled'}
                  />
                </>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Plan Renewal / Expiry Countdown */}
      {subscription && !isFree && subscription.current_period_end && (
        <RenewalCountdownCard subscription={subscription} />
      )}

      {/* Next Payment & Recent Activity */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card variant="bordered">
          <CardContent className="p-6">
            <h3 className="mb-4 flex items-center gap-2 text-body font-semibold text-fg">
              <Calendar className="h-5 w-5" />
              Next payment
            </h3>
            {loadingPayment ? (
              <div className="flex items-center justify-center py-6">
                <Spinner size="md" />
              </div>
            ) : isFree ? (
              <p className="py-4 text-center text-body-sm text-fg-muted">
                No upcoming payments on the Free plan.
              </p>
            ) : upcomingPayment ? (
              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-h2 font-bold text-fg">
                    ₹{upcomingPayment.amount_due}
                  </span>
                  <span className="text-body-sm text-fg-muted">
                    {upcomingPayment.billing_cycle === 'six_months'
                      ? '6-month'
                      : upcomingPayment.billing_cycle}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                  <Calendar className="h-4 w-4" />
                  Due{' '}
                  {new Date(upcomingPayment.payment_due_date).toLocaleDateString('en-IN', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </div>
                <DaysUntilPayment dueDate={upcomingPayment.payment_due_date} />
              </div>
            ) : subscription && !isFree ? (
              <div className="space-y-3">
                {subscription.next_invoice_amount != null && (
                  <div className="flex items-baseline justify-between">
                    <span className="text-h2 font-bold text-fg">
                      {subscription.next_invoice_currency === 'INR' ? '₹' : '$'}
                      {subscription.next_invoice_amount}
                    </span>
                    {subscription.billing_cycle && (
                      <span className="text-body-sm text-fg-muted">
                        {subscription.billing_cycle === 'six_months'
                          ? '6-month'
                          : subscription.billing_cycle}
                      </span>
                    )}
                  </div>
                )}
                {subscription.next_billing_date ? (
                  <>
                    <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                      <Calendar className="h-4 w-4" />
                      Due{' '}
                      {new Date(subscription.next_billing_date).toLocaleDateString('en-IN', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </div>
                    <DaysUntilPayment dueDate={subscription.next_billing_date} />
                  </>
                ) : (
                  <p className="text-body-sm text-fg-muted">
                    Payment details will appear here.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-body-sm text-fg-muted">No upcoming payments.</p>
            )}
          </CardContent>
        </Card>

        <RecentActivityCard
          history={history}
          loading={loadingHistory}
          isZK={isZK}
          onViewAll={() => onSwitchTab('history')}
        />
      </div>

      {/* Quick Actions */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <h3 className="mb-4 text-body font-semibold text-fg">Quick actions</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <QuickActionButton
              icon={<TrendingUp className="h-5 w-5 text-primary" />}
              title="Change plan"
              description="Upgrade or downgrade"
              onClick={onChangePlan}
            />
            <QuickActionButton
              icon={<FileText className="h-5 w-5 text-success" />}
              title="Contact support"
              description="Billing inquiries"
              onClick={() =>
                window.open('mailto:support@edgecloudstorage.com', '_blank')
              }
            />
            <QuickActionButton
              icon={<Receipt className="h-5 w-5 text-accent" />}
              title="View plans"
              description="Compare all plans"
              onClick={onChangePlan}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function QuickActionButton({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactElement;
  title: string;
  description: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left',
        'transition-colors duration-fast hover:bg-surface-muted',
        'focus-visible:outline-none focus-visible:shadow-focus'
      )}
    >
      <span className="flex-shrink-0">{icon}</span>
      <div>
        <p className="text-body-sm font-medium text-fg">{title}</p>
        <p className="text-caption text-fg-muted">{description}</p>
      </div>
      <ChevronRight className="ml-auto h-4 w-4 text-fg-muted" />
    </button>
  );
}

// ─── Recent Activity Card ────────────────────────────────────────────────────

function RecentActivityCard({
  history,
  loading,
  isZK,
  onViewAll,
}: {
  history: SubscriptionHistoryEntry[];
  loading: boolean;
  isZK: boolean;
  onViewAll: () => void;
}): ReactElement {
  const recentEntries = history.slice(0, 3);

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        <h3 className="mb-4 flex items-center gap-2 text-body font-semibold text-fg">
          <Clock className="h-5 w-5" />
          Recent activity
        </h3>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Spinner size="md" />
          </div>
        ) : recentEntries.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Clock />}
            title="No billing activity yet"
            description="Your recent payment events will appear here."
          />
        ) : (
          <div>
            {recentEntries.map((entry, index) => {
              const eventType = entry.event_type || 'created';
              const eventConfig = getEventConfig(eventType);
              const EventIcon = eventConfig.icon;
              const planLabel = entry.to_plan_code || entry.plan_code || 'Unknown';
              const displayPlan = formatPlanCode(planLabel, isZK);

              return (
                <div
                  key={entry.id || index}
                  className={cn(
                    'flex items-center gap-3 py-3',
                    index < recentEntries.length - 1 && 'border-b border-border'
                  )}
                >
                  <div
                    className={cn(
                      'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg',
                      eventConfig.chipBg
                    )}
                  >
                    <EventIcon className={cn('h-3.5 w-3.5', eventConfig.chipFg)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-body-sm font-medium text-fg">{eventConfig.label}</p>
                    <p className="text-caption text-fg-muted">{displayPlan}</p>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    {entry.amount_paid != null && entry.amount_paid > 0 && (
                      <p className="text-body-sm font-semibold text-fg">
                        ₹{entry.amount_paid}
                      </p>
                    )}
                    <p className="text-caption text-fg-muted">
                      {new Date(
                        entry.started_at || entry.created_at || ''
                      ).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!loading && recentEntries.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-4 w-full"
            onClick={onViewAll}
          >
            View full history →
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({
  history,
  loading,
  isZK,
}: {
  history: SubscriptionHistoryEntry[];
  loading: boolean;
  isZK: boolean;
}): ReactElement {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <Card variant="bordered">
        <EmptyState
          icon={<Clock />}
          title="No payment history"
          description="Your payment and subscription events will appear here."
        />
      </Card>
    );
  }

  return (
    <Card variant="bordered" className="overflow-hidden">
      <div className="divide-y divide-border">
        {history.map((entry, index) => (
          <HistoryRow key={entry.id || index} entry={entry} isZK={isZK} />
        ))}
      </div>
    </Card>
  );
}

function HistoryRow({
  entry,
  isZK,
}: {
  entry: SubscriptionHistoryEntry;
  isZK: boolean;
}): ReactElement {
  const eventType = entry.event_type || 'created';
  const eventConfig = getEventConfig(eventType);
  const EventIcon = eventConfig.icon;

  const planLabel = entry.to_plan_code || entry.plan_code || 'Unknown';
  const displayPlan = formatPlanCode(planLabel, isZK);

  return (
    <div className="flex items-center gap-4 px-6 py-4 transition-colors duration-fast hover:bg-surface-muted">
      <div
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
          eventConfig.chipBg
        )}
      >
        <EventIcon className={cn('h-4 w-4', eventConfig.chipFg)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-body-sm font-medium text-fg">{eventConfig.label}</p>
          <Badge variant={eventConfig.badgeVariant} size="sm">
            {eventType.replace(/_/g, ' ')}
          </Badge>
        </div>
        <p className="mt-0.5 text-caption text-fg-muted">
          {displayPlan}
          {entry.from_plan_code &&
            entry.to_plan_code &&
            entry.from_plan_code !== entry.to_plan_code && (
              <>
                {' '}
                — {formatPlanCode(entry.from_plan_code, isZK)} →{' '}
                {formatPlanCode(entry.to_plan_code, isZK)}
              </>
            )}
        </p>
      </div>
      <div className="flex-shrink-0 text-right">
        {entry.amount_paid != null && entry.amount_paid > 0 && (
          <p className="text-body-sm font-semibold text-fg">₹{entry.amount_paid}</p>
        )}
        <p className="text-caption text-fg-muted">
          {new Date(
            entry.started_at || entry.created_at || ''
          ).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}
        </p>
      </div>
    </div>
  );
}

// ─── Methods Tab ─────────────────────────────────────────────────────────────

function MethodsTab({
  subscription,
  isFree,
  portalLoading,
  onOpenStripePortal,
}: {
  subscription: SubscriptionDisplay | null;
  isFree: boolean;
  portalLoading: boolean;
  onOpenStripePortal: () => void;
}): ReactElement {
  const navigate = useNavigate();

  if (isFree) {
    return (
      <Card variant="bordered">
        <EmptyState
          icon={<CreditCard />}
          title="No payment method required"
          description="You're on the Free plan. A payment method will be required when you upgrade to a paid plan."
        />
      </Card>
    );
  }

  const isRazorpay = subscription?.payment_gateway === 'razorpay';
  const isStripe = subscription?.payment_gateway === 'stripe';

  return (
    <div className="space-y-6">
      {/* Payment Gateway Card */}
      <Card variant="bordered">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div
              aria-hidden
              className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"
            >
              <CreditCard className="h-6 w-6" />
            </div>
            <div className="flex-1">
              {isRazorpay ? (
                <>
                  <h3 className="text-body font-semibold text-fg">
                    Payment via Razorpay
                  </h3>
                  <p className="mt-1 text-body-sm text-fg-muted">
                    Your subscription is managed through Razorpay. Payment is collected
                    automatically at the start of each billing cycle. You can change your
                    plan or renew from the pricing page.
                  </p>
                  {subscription?.last_payment_at && (
                    <p className="mt-2 text-caption text-fg-muted">
                      Last payment:{' '}
                      {new Date(subscription.last_payment_at).toLocaleDateString('en-IN', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </p>
                  )}
                  <Button
                    variant="primary"
                    size="md"
                    className="mt-4"
                    leftIcon={<TrendingUp className="h-4 w-4" />}
                    onClick={() => navigate('/pricing')}
                  >
                    Change plan
                  </Button>
                </>
              ) : isStripe ? (
                <>
                  <h3 className="text-body font-semibold text-fg">
                    Manage payment methods
                  </h3>
                  <p className="mt-1 text-body-sm text-fg-muted">
                    Add, update, or remove payment methods through the secure Stripe
                    billing portal. You can also view and download invoices.
                  </p>
                  <Button
                    variant="primary"
                    size="md"
                    className="mt-4"
                    disabled={portalLoading}
                    loading={portalLoading}
                    leftIcon={portalLoading ? undefined : <ExternalLink className="h-4 w-4" />}
                    onClick={onOpenStripePortal}
                  >
                    Open Stripe portal
                  </Button>
                </>
              ) : (
                <>
                  <h3 className="text-body font-semibold text-fg">Payment information</h3>
                  <p className="mt-1 text-body-sm text-fg-muted">
                    Your subscription is active. You can manage your plan from the pricing
                    page.
                  </p>
                  <Button
                    variant="primary"
                    size="md"
                    className="mt-4"
                    leftIcon={<TrendingUp className="h-4 w-4" />}
                    onClick={() => navigate('/pricing')}
                  >
                    View plans
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Current Subscription Info */}
      {subscription && (
        <Card variant="bordered">
          <CardContent className="p-6">
            <h3 className="mb-4 text-body font-semibold text-fg">Subscription details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InfoRow label="Plan" value={subscription.plan_name} />
              <InfoRow label="Status" value={subscription.status} isStatus />
              <InfoRow
                label="Billing cycle"
                value={
                  subscription.billing_cycle
                    ? subscription.billing_cycle === 'six_months'
                      ? '6 months'
                      : subscription.billing_cycle.charAt(0).toUpperCase() +
                        subscription.billing_cycle.slice(1)
                    : 'N/A'
                }
              />
              <InfoRow
                label="Next billing"
                value={
                  subscription.next_billing_date
                    ? new Date(subscription.next_billing_date).toLocaleDateString('en-IN', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })
                    : 'N/A'
                }
              />
              <InfoRow
                label="Payment method"
                value={isRazorpay ? 'Razorpay' : isStripe ? 'Stripe' : 'N/A'}
              />
              {subscription.current_period_end && (
                <InfoRow
                  label="Current period ends"
                  value={new Date(subscription.current_period_end).toLocaleDateString(
                    'en-IN',
                    { year: 'numeric', month: 'long', day: 'numeric' }
                  )}
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Invoices Tab ────────────────────────────────────────────────────────────

function InvoicesTab({
  invoices,
  loading,
}: {
  invoices: Invoice[];
  loading: boolean;
}): ReactElement {
  const [downloading, setDownloading] = useState<string | null>(null);

  const handleDownload = async (inv: Invoice) => {
    try {
      setDownloading(inv.id);
      await subscriptionService.downloadInvoice(inv.id);
    } catch (err) {
      console.error('Download failed', err);
    } finally {
      setDownloading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <Card variant="bordered">
        <EmptyState
          icon={<Receipt />}
          title="No invoices yet"
          description="Invoices will appear here after your first payment."
        />
      </Card>
    );
  }

  return (
    <Card variant="bordered" className="overflow-hidden">
      <div className="hidden md:grid grid-cols-12 gap-4 border-b border-border bg-surface-muted px-6 py-3 text-caption font-semibold uppercase tracking-wide text-fg-muted">
        <div className="col-span-2">Invoice</div>
        <div className="col-span-2">Date</div>
        <div className="col-span-3">Plan</div>
        <div className="col-span-2">Amount</div>
        <div className="col-span-1">Status</div>
        <div className="col-span-2 text-right">Download</div>
      </div>
      <div className="divide-y divide-border">
        {invoices.map((inv) => {
          const isFailure = inv.status === 'failed';
          const isRefunded = inv.status === 'refunded';
          const currencySymbol = inv.currency === 'INR' ? '₹' : '$';
          const statusVariant: BadgeProps['variant'] = isFailure
            ? 'danger'
            : isRefunded
              ? 'warning'
              : 'success';
          const statusLabel = isFailure
            ? 'Failed'
            : isRefunded
              ? 'Refunded'
              : 'Paid';

          return (
            <div
              key={inv.id}
              className="grid grid-cols-2 md:grid-cols-12 gap-2 md:gap-4 px-6 py-4 items-center text-body-sm transition-colors duration-fast hover:bg-surface-muted"
            >
              <div className="col-span-2 md:col-span-2 font-mono text-caption text-fg-muted">
                {inv.invoice_number}
              </div>
              <div className="col-span-1 md:col-span-2 text-fg-muted">
                {new Date(inv.paid_at || inv.created_at).toLocaleDateString('en-IN', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </div>
              <div className="col-span-1 md:col-span-3 font-medium text-fg truncate">
                {inv.plan_name}
              </div>
              <div className="col-span-1 md:col-span-2 font-semibold text-fg">
                {currencySymbol}
                {Number(inv.amount).toLocaleString('en-IN', { minimumFractionDigits: 0 })}
              </div>
              <div className="col-span-1 md:col-span-1">
                <Badge variant={statusVariant} size="sm">
                  {statusLabel}
                </Badge>
              </div>
              <div className="col-span-2 md:col-span-2 md:text-right">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={downloading === inv.id}
                  loading={downloading === inv.id}
                  leftIcon={
                    downloading === inv.id ? undefined : <Download className="h-3.5 w-3.5" />
                  }
                  onClick={() => void handleDownload(inv)}
                >
                  PDF
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Renewal Countdown Card ──────────────────────────────────────────────────

function RenewalCountdownCard({
  subscription,
}: {
  subscription: SubscriptionDisplay;
}): ReactElement {
  const periodEnd = subscription.current_period_end;
  if (!periodEnd) return <></>;

  const days =
    subscription.days_until_renewal ??
    Math.max(
      0,
      Math.ceil((new Date(periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    );
  const isCancelled = subscription.status === 'cancelled';
  const label = isCancelled ? 'Expires' : 'Renews';

  const tone: 'success' | 'warning' | 'danger' =
    days > 14 ? 'success' : days > 7 ? 'warning' : 'danger';

  const toneClasses: Record<typeof tone, { bg: string; accent: string }> = {
    success: { bg: 'bg-success/10 border-success/30', accent: 'text-success' },
    warning: { bg: 'bg-warning/10 border-warning/30', accent: 'text-warning' },
    danger: { bg: 'bg-danger/10 border-danger/30', accent: 'text-danger' },
  };

  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-xl border p-5',
        toneClasses[tone].bg
      )}
    >
      <div className="flex items-center gap-3">
        <Clock className={cn('h-5 w-5', toneClasses[tone].accent)} />
        <div>
          <p className={cn('font-semibold', toneClasses[tone].accent)}>
            {label} in {days} day{days !== 1 ? 's' : ''}
          </p>
          <p className="text-body-sm text-fg-muted">
            {new Date(periodEnd).toLocaleDateString('en-IN', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Shared Sub-Components ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }): ReactElement {
  const variant: BadgeProps['variant'] =
    status === 'active'
      ? 'success'
      : status === 'past_due' || status === 'expired'
        ? 'danger'
        : 'neutral';
  return (
    <Badge variant={variant} size="sm" className="capitalize">
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

function FeatureChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface p-3 border border-border">
      <Icon className="h-4 w-4 flex-shrink-0 text-fg-muted" />
      <div className="min-w-0">
        <p className="text-caption text-fg-muted">{label}</p>
        <p className="truncate text-body-sm font-semibold text-fg">{value}</p>
      </div>
    </div>
  );
}

function DaysUntilPayment({ dueDate }: { dueDate: string }): ReactElement {
  const days = Math.max(
    0,
    Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  );
  const color = days <= 3 ? 'text-danger' : days <= 7 ? 'text-warning' : 'text-success';

  return (
    <p className={cn('text-body-sm font-medium', color)}>
      {days === 0 ? 'Due today' : `${days} day${days !== 1 ? 's' : ''} remaining`}
    </p>
  );
}

function InfoRow({
  label,
  value,
  isStatus,
}: {
  label: string;
  value: string;
  isStatus?: boolean;
}): ReactElement {
  return (
    <div className="rounded-lg bg-surface-muted p-3">
      <p className="text-caption text-fg-muted">{label}</p>
      {isStatus ? (
        <div className="mt-1">
          <StatusBadge status={value} />
        </div>
      ) : (
        <p className="mt-0.5 text-body-sm font-medium text-fg">{value}</p>
      )}
    </div>
  );
}

function PortalSkeleton(): ReactElement {
  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton shape="rect" className="h-10 w-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton shape="text" className="h-7 w-48" />
          <Skeleton shape="text" className="h-4 w-64" />
        </div>
      </div>
      <Skeleton shape="rect" className="h-20 rounded-xl" />
      <Skeleton shape="rect" className="h-10 w-96" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Skeleton shape="rect" className="h-48 rounded-xl" />
        <Skeleton shape="rect" className="h-48 rounded-xl" />
      </div>
      <Skeleton shape="rect" className="h-40 rounded-xl" />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPlanCode(code: string, _isZK?: boolean): string {
  if (!code) return 'Unknown';
  return code
    .replace(/^(normal_|zk_)/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getEventConfig(eventType: string): {
  icon: typeof ArrowUpCircle;
  label: string;
  chipBg: string;
  chipFg: string;
  badgeVariant: BadgeProps['variant'];
} {
  const configs: Record<
    string,
    {
      icon: typeof ArrowUpCircle;
      label: string;
      chipBg: string;
      chipFg: string;
      badgeVariant: BadgeProps['variant'];
    }
  > = {
    created: {
      icon: CheckCircle,
      label: 'Subscription created',
      chipBg: 'bg-success/15',
      chipFg: 'text-success',
      badgeVariant: 'success',
    },
    upgraded: {
      icon: ArrowUpCircle,
      label: 'Plan upgraded',
      chipBg: 'bg-primary/15',
      chipFg: 'text-primary',
      badgeVariant: 'info',
    },
    downgraded: {
      icon: ArrowDownCircle,
      label: 'Plan downgraded',
      chipBg: 'bg-warning/15',
      chipFg: 'text-warning',
      badgeVariant: 'warning',
    },
    renewed: {
      icon: RotateCcw,
      label: 'Subscription renewed',
      chipBg: 'bg-success/15',
      chipFg: 'text-success',
      badgeVariant: 'success',
    },
    cancelled: {
      icon: Ban,
      label: 'Subscription cancelled',
      chipBg: 'bg-surface-muted',
      chipFg: 'text-fg-muted',
      badgeVariant: 'neutral',
    },
    payment_failed: {
      icon: AlertTriangle,
      label: 'Payment failed',
      chipBg: 'bg-danger/15',
      chipFg: 'text-danger',
      badgeVariant: 'danger',
    },
  };

  return (
    configs[eventType] ?? {
      icon: Clock,
      label: eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      chipBg: 'bg-surface-muted',
      chipFg: 'text-fg-muted',
      badgeVariant: 'neutral',
    }
  );
}
