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
  Loader2,
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
import type { UpcomingPayment, SubscriptionHistoryEntry, Invoice } from '../../services/subscriptionService';
import {
  isSubscriptionDisplay,
} from '../../types/subscription-components.types';
import type { SubscriptionDisplay } from '../../types/subscription-components.types';

type PortalTab = 'overview' | 'history' | 'methods' | 'invoices';

interface PaymentPortalProps {
  onBack: () => void;
  darkMode?: boolean;
}

export default function PaymentPortal({ onBack, darkMode = false }: PaymentPortalProps): ReactElement {
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

  const subscriptionDisplay = subscription && isSubscriptionDisplay(subscription)
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
      const entries = Array.isArray(data) ? data : (data as unknown as { history: SubscriptionHistoryEntry[] }).history ?? [];
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
    fetchUpcomingPayment();
    fetchHistory();
    fetchInvoices();
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

  const bg = darkMode ? 'bg-gray-900' : 'bg-gray-50';
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';

  const tabs: { id: PortalTab; label: string; icon: typeof CreditCard }[] = [
    { id: 'overview', label: 'Overview', icon: CreditCard },
    { id: 'history', label: 'Payment History', icon: Clock },
    { id: 'methods', label: 'Payment Methods', icon: CreditCard },
    { id: 'invoices', label: 'Invoices', icon: Receipt },
  ];

  if (subLoading) {
    return <PortalSkeleton darkMode={darkMode} />;
  }

  return (
    <div className={`max-w-7xl mx-auto p-4 md:p-6 space-y-6 ${bg} min-h-full`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-gray-800 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
            aria-label="Back to Billing"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className={`text-2xl md:text-3xl font-bold ${textPrimary}`}>Payment Portal</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-sm ${textSecondary}`}>Manage your payments and billing</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                isZK
                  ? darkMode ? 'bg-purple-900/50 text-purple-300' : 'bg-purple-100 text-purple-700'
                  : darkMode ? 'bg-blue-900/50 text-blue-300' : 'bg-blue-100 text-blue-700'
              }`}>
                {isZK ? <Shield className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
                {serviceLabel}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-sm font-medium ${
            darkMode ? 'bg-gray-800 border-gray-700 hover:bg-gray-700 text-gray-300' : 'bg-white border border-gray-300 hover:bg-gray-50 text-gray-700'
          } disabled:opacity-50`}
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Payment Status Banner */}
      <PaymentStatusBanner
        subscription={subscriptionDisplay}
        isFree={isFree}
        darkMode={darkMode}
        onUpgrade={() => navigate('/pricing')}
      />

      {/* Tabs */}
      <div className={`border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <nav className="flex gap-1 overflow-x-auto pb-px -mb-px" aria-label="Portal tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  isActive
                    ? `border-blue-600 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`
                    : `border-transparent ${darkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="min-h-[400px]">
        {activeTab === 'overview' && (
          <OverviewTab
            subscription={subscriptionDisplay}
            upcomingPayment={upcomingPayment}
            loadingPayment={loadingPayment}
            history={history}
            loadingHistory={loadingHistory}
            isFree={isFree}
            isZK={isZK}
            darkMode={darkMode}
            onChangePlan={() => navigate('/pricing')}
            onSwitchTab={setActiveTab}
          />
        )}
        {activeTab === 'history' && (
          <HistoryTab
            history={history}
            loading={loadingHistory}
            isZK={isZK}
            darkMode={darkMode}
          />
        )}
        {activeTab === 'methods' && (
          <MethodsTab
            subscription={subscriptionDisplay}
            isFree={isFree}
            darkMode={darkMode}
            portalLoading={portalLoading}
            onOpenStripePortal={() => void handleOpenStripePortal()}
          />
        )}
        {activeTab === 'invoices' && (
          <InvoicesTab
            invoices={invoices}
            loading={loadingInvoices}
            darkMode={darkMode}
          />
        )}
      </div>
    </div>
  );
}

// ─── Payment Status Banner ───────────────────────────────────────────────────

function PaymentStatusBanner({
  subscription,
  isFree,
  darkMode,
  onUpgrade,
}: {
  subscription: SubscriptionDisplay | null;
  isFree: boolean;
  darkMode: boolean;
  onUpgrade: () => void;
}): ReactElement | null {
  if (!subscription) return null;

  if (isFree) {
    return (
      <div className={`rounded-xl p-5 border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
        darkMode ? 'bg-blue-900/20 border-blue-800' : 'bg-blue-50 border-blue-200'
      }`}>
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg ${darkMode ? 'bg-blue-800' : 'bg-blue-100'}`}>
            <Crown className={`w-5 h-5 ${darkMode ? 'text-blue-300' : 'text-blue-600'}`} />
          </div>
          <div>
            <p className={`font-semibold ${darkMode ? 'text-blue-200' : 'text-blue-900'}`}>You&apos;re on the Free Plan</p>
            <p className={`text-sm mt-0.5 ${darkMode ? 'text-blue-300' : 'text-blue-700'}`}>
              Upgrade to unlock more storage, bandwidth, and premium features.
            </p>
          </div>
        </div>
        <button
          onClick={onUpgrade}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors text-sm whitespace-nowrap"
        >
          <TrendingUp className="w-4 h-4" />
          Upgrade Now
        </button>
      </div>
    );
  }

  const status = subscription.status;
  const configs: Record<string, { bg: string; border: string; icon: typeof CheckCircle; iconColor: string; titleColor: string; textColor: string; title: string; message: string }> = {
    active: {
      bg: darkMode ? 'bg-green-900/20' : 'bg-green-50',
      border: darkMode ? 'border-green-800' : 'border-green-200',
      icon: CheckCircle,
      iconColor: darkMode ? 'text-green-400' : 'text-green-600',
      titleColor: darkMode ? 'text-green-300' : 'text-green-800',
      textColor: darkMode ? 'text-green-400' : 'text-green-700',
      title: 'Payment Up to Date',
      message: 'Your subscription is active and all payments are current.',
    },
    past_due: {
      bg: darkMode ? 'bg-red-900/20' : 'bg-red-50',
      border: darkMode ? 'border-red-800' : 'border-red-200',
      icon: AlertCircle,
      iconColor: darkMode ? 'text-red-400' : 'text-red-600',
      titleColor: darkMode ? 'text-red-300' : 'text-red-800',
      textColor: darkMode ? 'text-red-400' : 'text-red-700',
      title: 'Payment Overdue',
      message: 'Your payment is past due. Please update your payment method to avoid service interruption.',
    },
    cancelled: {
      bg: darkMode ? 'bg-gray-800' : 'bg-gray-100',
      border: darkMode ? 'border-gray-700' : 'border-gray-300',
      icon: XCircle,
      iconColor: darkMode ? 'text-gray-400' : 'text-gray-500',
      titleColor: darkMode ? 'text-gray-300' : 'text-gray-700',
      textColor: darkMode ? 'text-gray-400' : 'text-gray-600',
      title: 'Subscription Cancelled',
      message: subscription.next_billing_date
        ? `Your access continues until ${new Date(subscription.next_billing_date).toLocaleDateString()}.`
        : 'Your subscription has been cancelled.',
    },
    expired: {
      bg: darkMode ? 'bg-red-900/20' : 'bg-red-50',
      border: darkMode ? 'border-red-800' : 'border-red-200',
      icon: AlertTriangle,
      iconColor: darkMode ? 'text-red-400' : 'text-red-600',
      titleColor: darkMode ? 'text-red-300' : 'text-red-800',
      textColor: darkMode ? 'text-red-400' : 'text-red-700',
      title: 'Subscription Expired',
      message: 'Your subscription has expired. Renew to regain full access.',
    },
  };

  const config = configs[status] ?? configs['active']!;
  const StatusIcon = config!.icon;

  return (
    <div className={`rounded-xl p-5 border flex items-start gap-3 ${config!.bg} ${config!.border}`}>
      <StatusIcon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${config!.iconColor}`} />
      <div>
        <p className={`font-semibold ${config!.titleColor}`}>{config!.title}</p>
        <p className={`text-sm mt-0.5 ${config!.textColor}`}>{config!.message}</p>
      </div>
    </div>
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
  darkMode,
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
  darkMode: boolean;
  onChangePlan: () => void;
  onSwitchTab: (tab: PortalTab) => void;
}): ReactElement {
  const cardBg = darkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorder = darkMode ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';

  return (
    <div className="space-y-6">
      {/* Current Plan Card */}
      {subscription && (
        <div className={`rounded-xl border overflow-hidden ${cardBorder}`}>
          <div className={`p-6 ${
            isZK
              ? darkMode ? 'bg-gradient-to-br from-purple-900/40 to-gray-800' : 'bg-gradient-to-br from-purple-50 to-indigo-50'
              : darkMode ? 'bg-gradient-to-br from-blue-900/40 to-gray-800' : 'bg-gradient-to-br from-blue-50 to-purple-50'
          }`}>
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${isZK ? 'bg-purple-600' : 'bg-blue-600'}`}>
                  <Crown className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h2 className={`text-xl font-bold ${textPrimary}`}>{subscription.plan_name}</h2>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={subscription.status} darkMode={darkMode} />
                    {subscription.billing_cycle && !isFree && (
                      <span className={`text-xs ${textSecondary}`}>
                        {subscription.billing_cycle === 'six_months' ? '6-month' : subscription.billing_cycle} billing
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-left md:text-right">
                <p className={`text-2xl font-bold ${textPrimary}`}>
                  {subscription.price_display || 'Free'}
                </p>
                {!isFree && subscription.billing_cycle && (
                  <p className={`text-sm ${textSecondary}`}>
                    per {subscription.billing_cycle === 'six_months' ? '6 months' : subscription.billing_cycle}
                  </p>
                )}
              </div>
            </div>

            {/* Plan Features */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
              <FeatureChip icon={HardDrive} label="Storage" value={`${subscription.storage_quota_gb >= 1024 ? `${(subscription.storage_quota_gb / 1024).toFixed(0)} TB` : `${subscription.storage_quota_gb} GB`}`} darkMode={darkMode} />
              <FeatureChip icon={Gauge} label="Bandwidth" value={`${subscription.bandwidth_quota_mbps} Mbps`} darkMode={darkMode} />
              {isZK && (
                <>
                  <FeatureChip icon={Shield} label="Encryption" value="Zero-Knowledge" darkMode={darkMode} />
                  <FeatureChip icon={Key} label="Security" value="WebAuthn" darkMode={darkMode} />
                </>
              )}
              {!isZK && (
                <>
                  <FeatureChip icon={Calendar} label="Billing" value={isFree ? 'Free' : 'Active'} darkMode={darkMode} />
                  <FeatureChip icon={Zap} label="AI Features" value={isFree ? 'Disabled' : 'Enabled'} darkMode={darkMode} />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Plan Renewal / Expiry Countdown */}
      {subscription && !isFree && subscription.current_period_end && (
        <RenewalCountdownCard subscription={subscription} darkMode={darkMode} />
      )}

      {/* Next Payment & Usage Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Next Payment */}
        <div className={`rounded-xl border p-6 ${cardBg} ${cardBorder}`}>
          <h3 className={`font-semibold mb-4 flex items-center gap-2 ${textPrimary}`}>
            <Calendar className="w-5 h-5" />
            Next Payment
          </h3>
          {loadingPayment ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className={`w-6 h-6 animate-spin ${textSecondary}`} />
            </div>
          ) : isFree ? (
            <div className={`text-center py-4 ${textSecondary}`}>
              <p className="text-sm">No upcoming payments on the Free plan.</p>
            </div>
          ) : upcomingPayment ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className={`text-3xl font-bold ${textPrimary}`}>
                  ₹{upcomingPayment.amount_due}
                </span>
                <span className={`text-sm ${textSecondary}`}>
                  {upcomingPayment.billing_cycle === 'six_months' ? '6-month' : upcomingPayment.billing_cycle}
                </span>
              </div>
              <div className={`flex items-center gap-2 text-sm ${textSecondary}`}>
                <Calendar className="w-4 h-4" />
                Due {new Date(upcomingPayment.payment_due_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
              <DaysUntilPayment dueDate={upcomingPayment.payment_due_date} darkMode={darkMode} />
            </div>
          ) : subscription && !isFree ? (
            <div className="space-y-3">
              {subscription.next_invoice_amount != null && (
                <div className="flex items-baseline justify-between">
                  <span className={`text-3xl font-bold ${textPrimary}`}>
                    {subscription.next_invoice_currency === 'INR' ? '₹' : '$'}{subscription.next_invoice_amount}
                  </span>
                  {subscription.billing_cycle && (
                    <span className={`text-sm ${textSecondary}`}>
                      {subscription.billing_cycle === 'six_months' ? '6-month' : subscription.billing_cycle}
                    </span>
                  )}
                </div>
              )}
              {subscription.next_billing_date ? (
                <>
                  <div className={`flex items-center gap-2 text-sm ${textSecondary}`}>
                    <Calendar className="w-4 h-4" />
                    Due {new Date(subscription.next_billing_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}
                  </div>
                  <DaysUntilPayment dueDate={subscription.next_billing_date} darkMode={darkMode} />
                </>
              ) : (
                <p className={`text-sm ${textSecondary}`}>Payment details will appear here.</p>
              )}
            </div>
          ) : (
            <p className={`text-sm ${textSecondary}`}>No upcoming payments.</p>
          )}
        </div>

        {/* Recent Activity */}
        <RecentActivityCard
          history={history}
          loading={loadingHistory}
          isZK={isZK}
          darkMode={darkMode}
          onViewAll={() => onSwitchTab('history')}
        />
      </div>

      {/* Quick Actions */}
      <div className={`rounded-xl border p-6 ${cardBg} ${cardBorder}`}>
        <h3 className={`font-semibold mb-4 ${textPrimary}`}>Quick Actions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            onClick={onChangePlan}
            className={`flex items-center gap-3 p-4 rounded-xl border transition-colors text-left ${
              darkMode ? 'border-gray-700 hover:bg-gray-700/50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <TrendingUp className={`w-5 h-5 flex-shrink-0 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
            <div>
              <p className={`font-medium text-sm ${textPrimary}`}>Change Plan</p>
              <p className={`text-xs ${textSecondary}`}>Upgrade or downgrade</p>
            </div>
            <ChevronRight className={`w-4 h-4 ml-auto ${textSecondary}`} />
          </button>
          <button
            onClick={() => window.open('mailto:support@edgecloudstorage.com', '_blank')}
            className={`flex items-center gap-3 p-4 rounded-xl border transition-colors text-left ${
              darkMode ? 'border-gray-700 hover:bg-gray-700/50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <FileText className={`w-5 h-5 flex-shrink-0 ${darkMode ? 'text-green-400' : 'text-green-600'}`} />
            <div>
              <p className={`font-medium text-sm ${textPrimary}`}>Contact Support</p>
              <p className={`text-xs ${textSecondary}`}>Billing inquiries</p>
            </div>
            <ChevronRight className={`w-4 h-4 ml-auto ${textSecondary}`} />
          </button>
          <button
            onClick={onChangePlan}
            className={`flex items-center gap-3 p-4 rounded-xl border transition-colors text-left ${
              darkMode ? 'border-gray-700 hover:bg-gray-700/50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <Receipt className={`w-5 h-5 flex-shrink-0 ${darkMode ? 'text-purple-400' : 'text-purple-600'}`} />
            <div>
              <p className={`font-medium text-sm ${textPrimary}`}>View Plans</p>
              <p className={`text-xs ${textSecondary}`}>Compare all plans</p>
            </div>
            <ChevronRight className={`w-4 h-4 ml-auto ${textSecondary}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Recent Activity Card ────────────────────────────────────────────────────

function RecentActivityCard({
  history,
  loading,
  isZK,
  darkMode,
  onViewAll,
}: {
  history: SubscriptionHistoryEntry[];
  loading: boolean;
  isZK: boolean;
  darkMode: boolean;
  onViewAll: () => void;
}): ReactElement {
  const cardBg = darkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorder = darkMode ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';

  const recentEntries = history.slice(0, 3);

  return (
    <div className={`rounded-xl border p-6 ${cardBg} ${cardBorder}`}>
      <h3 className={`font-semibold mb-4 flex items-center gap-2 ${textPrimary}`}>
        <Clock className="w-5 h-5" />
        Recent Activity
      </h3>
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className={`w-6 h-6 animate-spin ${textSecondary}`} />
        </div>
      ) : recentEntries.length === 0 ? (
        <div className={`text-center py-6 ${textSecondary}`}>
          <Clock className={`w-8 h-8 mx-auto mb-2 ${darkMode ? 'text-gray-600' : 'text-gray-300'}`} />
          <p className="text-sm">No billing activity yet.</p>
        </div>
      ) : (
        <div className="space-y-0">
          {recentEntries.map((entry, index) => {
            const eventType = entry.event_type || 'created';
            const eventConfig = getEventConfig(eventType, darkMode);
            const EventIcon = eventConfig.icon;
            const planLabel = entry.to_plan_code || entry.plan_code || 'Unknown';
            const displayPlan = formatPlanCode(planLabel, isZK);

            return (
              <div
                key={entry.id || index}
                className={`flex items-center gap-3 py-3 ${
                  index < recentEntries.length - 1
                    ? `border-b ${darkMode ? 'border-gray-700' : 'border-gray-100'}`
                    : ''
                }`}
              >
                <div className={`p-1.5 rounded-lg flex-shrink-0 ${eventConfig.bgColor}`}>
                  <EventIcon className={`w-3.5 h-3.5 ${eventConfig.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${textPrimary}`}>{eventConfig.label}</p>
                  <p className={`text-xs ${textSecondary}`}>{displayPlan}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  {entry.amount_paid != null && entry.amount_paid > 0 && (
                    <p className={`text-sm font-semibold ${textPrimary}`}>₹{entry.amount_paid}</p>
                  )}
                  <p className={`text-xs ${textSecondary}`}>
                    {new Date(entry.started_at || entry.created_at || '').toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!loading && recentEntries.length > 0 && (
        <button
          onClick={onViewAll}
          className={`mt-4 w-full text-center text-sm font-medium py-2 rounded-lg transition-colors ${
            darkMode
              ? 'text-blue-400 hover:bg-gray-700/50'
              : 'text-blue-600 hover:bg-blue-50'
          }`}
        >
          View Full History &rarr;
        </button>
      )}
    </div>
  );
}

// ─── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({
  history,
  loading,
  isZK,
  darkMode,
}: {
  history: SubscriptionHistoryEntry[];
  loading: boolean;
  isZK: boolean;
  darkMode: boolean;
}): ReactElement {
  const cardBg = darkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorder = darkMode ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className={`w-8 h-8 animate-spin ${textSecondary}`} />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className={`rounded-xl border p-12 text-center ${cardBg} ${cardBorder}`}>
        <Clock className={`w-12 h-12 mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-300'}`} />
        <h3 className={`text-lg font-semibold mb-2 ${textPrimary}`}>No Payment History</h3>
        <p className={`text-sm ${textSecondary}`}>
          Your payment and subscription events will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${cardBg} ${cardBorder}`}>
      <div className="divide-y ${darkMode ? 'divide-gray-700' : 'divide-gray-100'}">
        {history.map((entry, index) => (
          <HistoryRow key={entry.id || index} entry={entry} isZK={isZK} darkMode={darkMode} />
        ))}
      </div>
    </div>
  );
}

function HistoryRow({
  entry,
  isZK,
  darkMode,
}: {
  entry: SubscriptionHistoryEntry;
  isZK: boolean;
  darkMode: boolean;
}): ReactElement {
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';

  const eventType = entry.event_type || 'created';
  const eventConfig = getEventConfig(eventType, darkMode);
  const EventIcon = eventConfig.icon;

  const planLabel = entry.to_plan_code || entry.plan_code || 'Unknown';
  const displayPlan = formatPlanCode(planLabel, isZK);

  return (
    <div className={`flex items-center gap-4 px-6 py-4 ${darkMode ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'} transition-colors`}>
      <div className={`p-2 rounded-lg flex-shrink-0 ${eventConfig.bgColor}`}>
        <EventIcon className={`w-4 h-4 ${eventConfig.iconColor}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className={`font-medium text-sm ${textPrimary}`}>{eventConfig.label}</p>
          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${eventConfig.badgeBg} ${eventConfig.badgeText}`}>
            {eventType.replace(/_/g, ' ')}
          </span>
        </div>
        <p className={`text-xs mt-0.5 ${textSecondary}`}>
          {displayPlan}
          {entry.from_plan_code && entry.to_plan_code && entry.from_plan_code !== entry.to_plan_code && (
            <> &mdash; {formatPlanCode(entry.from_plan_code, isZK)} → {formatPlanCode(entry.to_plan_code, isZK)}</>
          )}
        </p>
      </div>
      <div className="text-right flex-shrink-0">
        {entry.amount_paid != null && entry.amount_paid > 0 && (
          <p className={`font-semibold text-sm ${textPrimary}`}>₹{entry.amount_paid}</p>
        )}
        <p className={`text-xs ${textSecondary}`}>
          {new Date(entry.started_at || entry.created_at || '').toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}
        </p>
      </div>
    </div>
  );
}

// ─── Methods Tab ─────────────────────────────────────────────────────────────

function MethodsTab({
  subscription,
  isFree,
  darkMode,
  portalLoading,
  onOpenStripePortal,
}: {
  subscription: SubscriptionDisplay | null;
  isFree: boolean;
  darkMode: boolean;
  portalLoading: boolean;
  onOpenStripePortal: () => void;
}): ReactElement {
  const navigate = useNavigate();
  const cardBg = darkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorder = darkMode ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';

  if (isFree) {
    return (
      <div className={`rounded-xl border p-12 text-center ${cardBg} ${cardBorder}`}>
        <CreditCard className={`w-12 h-12 mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-300'}`} />
        <h3 className={`text-lg font-semibold mb-2 ${textPrimary}`}>No Payment Method Required</h3>
        <p className={`text-sm ${textSecondary}`}>
          You&apos;re on the Free plan. A payment method will be required when you upgrade to a paid plan.
        </p>
      </div>
    );
  }

  const isRazorpay = subscription?.payment_gateway === 'razorpay';
  const isStripe = subscription?.payment_gateway === 'stripe';

  return (
    <div className="space-y-6">
      {/* Payment Gateway Card */}
      <div className={`rounded-xl border p-6 ${cardBg} ${cardBorder}`}>
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-xl ${darkMode ? 'bg-indigo-900/40' : 'bg-indigo-50'}`}>
            <CreditCard className={`w-6 h-6 ${darkMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
          </div>
          <div className="flex-1">
            {isRazorpay ? (
              <>
                <h3 className={`font-semibold text-lg ${textPrimary}`}>Payment via Razorpay</h3>
                <p className={`text-sm mt-1 ${textSecondary}`}>
                  Your subscription is managed through Razorpay. Payment is collected automatically
                  at the start of each billing cycle. You can change your plan or renew from the pricing page.
                </p>
                {subscription?.last_payment_at && (
                  <p className={`text-xs mt-2 ${textSecondary}`}>
                    Last payment: {new Date(subscription.last_payment_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}
                  </p>
                )}
                <button
                  onClick={() => navigate('/pricing')}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors text-sm"
                >
                  <TrendingUp className="w-4 h-4" />
                  Change Plan
                </button>
              </>
            ) : isStripe ? (
              <>
                <h3 className={`font-semibold text-lg ${textPrimary}`}>Manage Payment Methods</h3>
                <p className={`text-sm mt-1 ${textSecondary}`}>
                  Add, update, or remove payment methods through the secure Stripe billing portal.
                  You can also view and download invoices.
                </p>
                <button
                  onClick={onOpenStripePortal}
                  disabled={portalLoading}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors text-sm disabled:opacity-50"
                >
                  {portalLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ExternalLink className="w-4 h-4" />
                  )}
                  Open Stripe Portal
                </button>
              </>
            ) : (
              <>
                <h3 className={`font-semibold text-lg ${textPrimary}`}>Payment Information</h3>
                <p className={`text-sm mt-1 ${textSecondary}`}>
                  Your subscription is active. You can manage your plan from the pricing page.
                </p>
                <button
                  onClick={() => navigate('/pricing')}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors text-sm"
                >
                  <TrendingUp className="w-4 h-4" />
                  View Plans
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Current Subscription Info */}
      {subscription && (
        <div className={`rounded-xl border p-6 ${cardBg} ${cardBorder}`}>
          <h3 className={`font-semibold mb-4 ${textPrimary}`}>Subscription Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InfoRow label="Plan" value={subscription.plan_name} darkMode={darkMode} />
            <InfoRow label="Status" value={subscription.status} darkMode={darkMode} isStatus />
            <InfoRow
              label="Billing Cycle"
              value={subscription.billing_cycle ? (subscription.billing_cycle === 'six_months' ? '6 Months' : subscription.billing_cycle.charAt(0).toUpperCase() + subscription.billing_cycle.slice(1)) : 'N/A'}
              darkMode={darkMode}
            />
            <InfoRow
              label="Next Billing"
              value={subscription.next_billing_date ? new Date(subscription.next_billing_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'}
              darkMode={darkMode}
            />
            <InfoRow
              label="Payment Method"
              value={isRazorpay ? 'Razorpay' : isStripe ? 'Stripe' : 'N/A'}
              darkMode={darkMode}
            />
            {subscription.current_period_end && (
              <InfoRow
                label="Current Period Ends"
                value={new Date(subscription.current_period_end).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}
                darkMode={darkMode}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Invoices Tab ────────────────────────────────────────────────────────────

function InvoicesTab({
  invoices,
  loading,
  darkMode,
}: {
  invoices: Invoice[];
  loading: boolean;
  darkMode: boolean;
}): ReactElement {
  const cardBg = darkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorder = darkMode ? 'border-gray-700' : 'border-gray-200';
  const textPrimary = darkMode ? 'text-white' : 'text-gray-900';
  const textSecondary = darkMode ? 'text-gray-400' : 'text-gray-600';
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
        <Loader2 className={`w-8 h-8 animate-spin ${textSecondary}`} />
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className={`rounded-xl border p-12 text-center ${cardBg} ${cardBorder}`}>
        <Receipt className={`w-12 h-12 mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-300'}`} />
        <h3 className={`text-lg font-semibold mb-2 ${textPrimary}`}>No Invoices Yet</h3>
        <p className={`text-sm ${textSecondary}`}>
          Invoices will appear here after your first payment.
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${cardBg} ${cardBorder}`}>
      <div className={`grid grid-cols-12 gap-4 px-6 py-3 text-xs font-medium uppercase tracking-wider ${
        darkMode ? 'bg-gray-700/50 text-gray-400' : 'bg-gray-50 text-gray-500'
      }`}>
        <div className="col-span-2">Invoice</div>
        <div className="col-span-2">Date</div>
        <div className="col-span-3">Plan</div>
        <div className="col-span-2">Amount</div>
        <div className="col-span-1">Status</div>
        <div className="col-span-2 text-right">Download</div>
      </div>
      <div className={`divide-y ${darkMode ? 'divide-gray-700' : 'divide-gray-100'}`}>
        {invoices.map((inv) => {
          const isFailure = inv.status === 'failed';
          const currencySymbol = inv.currency === 'INR' ? '₹' : '$';
          return (
            <div
              key={inv.id}
              className={`grid grid-cols-12 gap-4 px-6 py-4 items-center text-sm ${
                darkMode ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'
              } transition-colors`}
            >
              <div className={`col-span-2 font-mono text-xs ${textSecondary}`}>
                {inv.invoice_number}
              </div>
              <div className={`col-span-2 ${textSecondary}`}>
                {new Date(inv.paid_at || inv.created_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}
              </div>
              <div className={`col-span-3 font-medium ${textPrimary}`}>
                {inv.plan_name}
              </div>
              <div className={`col-span-2 font-semibold ${textPrimary}`}>
                {currencySymbol}{Number(inv.amount).toLocaleString('en-IN', { minimumFractionDigits: 0 })}
              </div>
              <div className="col-span-1">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  isFailure
                    ? darkMode ? 'bg-red-900/40 text-red-400' : 'bg-red-100 text-red-700'
                    : darkMode ? 'bg-green-900/40 text-green-400' : 'bg-green-100 text-green-700'
                }`}>
                  {inv.status === 'paid' ? 'Paid' : inv.status === 'refunded' ? 'Refunded' : 'Failed'}
                </span>
              </div>
              <div className="col-span-2 text-right">
                <button
                  onClick={() => handleDownload(inv)}
                  disabled={downloading === inv.id}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    darkMode
                      ? 'bg-blue-900/40 text-blue-400 hover:bg-blue-900/60'
                      : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                  } disabled:opacity-50`}
                >
                  {downloading === inv.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Download className="w-3.5 h-3.5" />
                  }
                  PDF
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Renewal Countdown Card ──────────────────────────────────────────────────

function RenewalCountdownCard({
  subscription,
  darkMode,
}: {
  subscription: SubscriptionDisplay;
  darkMode: boolean;
}): ReactElement {
  const periodEnd = subscription.current_period_end;
  if (!periodEnd) return <></>;

  const days = subscription.days_until_renewal
    ?? Math.max(0, Math.ceil((new Date(periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  const isCancelled = subscription.status === 'cancelled';
  const label = isCancelled ? 'Expires' : 'Renews';

  const colorScheme = days > 14
    ? { bg: darkMode ? 'bg-green-900/20' : 'bg-green-50', border: darkMode ? 'border-green-800' : 'border-green-200', text: darkMode ? 'text-green-400' : 'text-green-700', accent: darkMode ? 'text-green-300' : 'text-green-600' }
    : days > 7
    ? { bg: darkMode ? 'bg-yellow-900/20' : 'bg-yellow-50', border: darkMode ? 'border-yellow-800' : 'border-yellow-200', text: darkMode ? 'text-yellow-400' : 'text-yellow-700', accent: darkMode ? 'text-yellow-300' : 'text-yellow-600' }
    : { bg: darkMode ? 'bg-red-900/20' : 'bg-red-50', border: darkMode ? 'border-red-800' : 'border-red-200', text: darkMode ? 'text-red-400' : 'text-red-700', accent: darkMode ? 'text-red-300' : 'text-red-600' };

  return (
    <div className={`rounded-xl border p-5 flex items-center justify-between ${colorScheme.bg} ${colorScheme.border}`}>
      <div className="flex items-center gap-3">
        <Clock className={`w-5 h-5 ${colorScheme.accent}`} />
        <div>
          <p className={`font-semibold ${colorScheme.accent}`}>
            {label} in {days} day{days !== 1 ? 's' : ''}
          </p>
          <p className={`text-sm ${colorScheme.text}`}>
            {new Date(periodEnd).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Shared Sub-Components ───────────────────────────────────────────────────

function StatusBadge({ status, darkMode }: { status: string; darkMode: boolean }): ReactElement {
  const configs: Record<string, { bg: string; text: string }> = {
    active: {
      bg: darkMode ? 'bg-green-900/40' : 'bg-green-100',
      text: darkMode ? 'text-green-400' : 'text-green-700',
    },
    past_due: {
      bg: darkMode ? 'bg-red-900/40' : 'bg-red-100',
      text: darkMode ? 'text-red-400' : 'text-red-700',
    },
    cancelled: {
      bg: darkMode ? 'bg-gray-700' : 'bg-gray-200',
      text: darkMode ? 'text-gray-300' : 'text-gray-700',
    },
    expired: {
      bg: darkMode ? 'bg-red-900/40' : 'bg-red-100',
      text: darkMode ? 'text-red-400' : 'text-red-700',
    },
  };
  const config = configs[status] ?? configs['active']!;
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${config!.bg} ${config!.text}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function FeatureChip({
  icon: Icon,
  label,
  value,
  darkMode,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
  darkMode: boolean;
}): ReactElement {
  return (
    <div className={`flex items-center gap-2 p-3 rounded-lg ${darkMode ? 'bg-gray-900/60' : 'bg-white/80'}`}>
      <Icon className={`w-4 h-4 flex-shrink-0 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
      <div className="min-w-0">
        <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>{label}</p>
        <p className={`text-sm font-semibold truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>{value}</p>
      </div>
    </div>
  );
}

function DaysUntilPayment({ dueDate, darkMode }: { dueDate: string; darkMode: boolean }): ReactElement {
  const days = Math.max(0, Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  const textColor = days <= 3
    ? darkMode ? 'text-red-400' : 'text-red-600'
    : days <= 7
    ? darkMode ? 'text-yellow-400' : 'text-yellow-600'
    : darkMode ? 'text-green-400' : 'text-green-600';

  return (
    <p className={`text-sm font-medium ${textColor}`}>
      {days === 0 ? 'Due today' : `${days} day${days !== 1 ? 's' : ''} remaining`}
    </p>
  );
}

function InfoRow({
  label,
  value,
  darkMode,
  isStatus,
}: {
  label: string;
  value: string;
  darkMode: boolean;
  isStatus?: boolean;
}): ReactElement {
  return (
    <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-900/60' : 'bg-gray-50'}`}>
      <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>{label}</p>
      {isStatus ? (
        <StatusBadge status={value} darkMode={darkMode} />
      ) : (
        <p className={`text-sm font-medium mt-0.5 ${darkMode ? 'text-white' : 'text-gray-900'}`}>{value}</p>
      )}
    </div>
  );
}

function PortalSkeleton({ darkMode }: { darkMode: boolean }): ReactElement {
  const pulse = darkMode ? 'bg-gray-700' : 'bg-gray-200';
  return (
    <div className="max-w-7xl mx-auto p-6 space-y-8 animate-pulse">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg ${pulse}`} />
        <div>
          <div className={`h-7 w-48 rounded ${pulse}`} />
          <div className={`h-4 w-64 rounded mt-2 ${pulse}`} />
        </div>
      </div>
      <div className={`h-20 rounded-xl ${pulse}`} />
      <div className={`h-10 rounded ${pulse} w-96`} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className={`h-48 rounded-xl ${pulse}`} />
        <div className={`h-48 rounded-xl ${pulse}`} />
      </div>
      <div className={`h-40 rounded-xl ${pulse}`} />
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

function getEventConfig(eventType: string, darkMode: boolean) {
  const configs: Record<string, {
    icon: typeof ArrowUpCircle;
    label: string;
    bgColor: string;
    iconColor: string;
    badgeBg: string;
    badgeText: string;
  }> = {
    created: {
      icon: CheckCircle,
      label: 'Subscription Created',
      bgColor: darkMode ? 'bg-green-900/40' : 'bg-green-100',
      iconColor: darkMode ? 'text-green-400' : 'text-green-600',
      badgeBg: darkMode ? 'bg-green-900/40' : 'bg-green-100',
      badgeText: darkMode ? 'text-green-400' : 'text-green-700',
    },
    upgraded: {
      icon: ArrowUpCircle,
      label: 'Plan Upgraded',
      bgColor: darkMode ? 'bg-blue-900/40' : 'bg-blue-100',
      iconColor: darkMode ? 'text-blue-400' : 'text-blue-600',
      badgeBg: darkMode ? 'bg-blue-900/40' : 'bg-blue-100',
      badgeText: darkMode ? 'text-blue-400' : 'text-blue-700',
    },
    downgraded: {
      icon: ArrowDownCircle,
      label: 'Plan Downgraded',
      bgColor: darkMode ? 'bg-orange-900/40' : 'bg-orange-100',
      iconColor: darkMode ? 'text-orange-400' : 'text-orange-600',
      badgeBg: darkMode ? 'bg-orange-900/40' : 'bg-orange-100',
      badgeText: darkMode ? 'text-orange-400' : 'text-orange-700',
    },
    renewed: {
      icon: RotateCcw,
      label: 'Subscription Renewed',
      bgColor: darkMode ? 'bg-green-900/40' : 'bg-green-100',
      iconColor: darkMode ? 'text-green-400' : 'text-green-600',
      badgeBg: darkMode ? 'bg-green-900/40' : 'bg-green-100',
      badgeText: darkMode ? 'text-green-400' : 'text-green-700',
    },
    cancelled: {
      icon: Ban,
      label: 'Subscription Cancelled',
      bgColor: darkMode ? 'bg-gray-700' : 'bg-gray-200',
      iconColor: darkMode ? 'text-gray-400' : 'text-gray-500',
      badgeBg: darkMode ? 'bg-gray-700' : 'bg-gray-200',
      badgeText: darkMode ? 'text-gray-400' : 'text-gray-600',
    },
    payment_failed: {
      icon: AlertTriangle,
      label: 'Payment Failed',
      bgColor: darkMode ? 'bg-red-900/40' : 'bg-red-100',
      iconColor: darkMode ? 'text-red-400' : 'text-red-600',
      badgeBg: darkMode ? 'bg-red-900/40' : 'bg-red-100',
      badgeText: darkMode ? 'text-red-400' : 'text-red-700',
    },
  };

  return configs[eventType] ?? {
    icon: Clock,
    label: eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    bgColor: darkMode ? 'bg-gray-700' : 'bg-gray-100',
    iconColor: darkMode ? 'text-gray-400' : 'text-gray-500',
    badgeBg: darkMode ? 'bg-gray-700' : 'bg-gray-200',
    badgeText: darkMode ? 'text-gray-400' : 'text-gray-600',
  };
}
