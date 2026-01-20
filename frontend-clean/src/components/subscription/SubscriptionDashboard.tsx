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
  ExternalLink
} from 'lucide-react';
import type {
  PlanDisplay,
  SubscriptionDisplay,
  UsageDisplay,
  SubscriptionWarning,
  SubscriptionRecommendation,
  FeatureObject,
} from '../../types/subscription-components.types';
import { isPlanDisplay, isSubscriptionDisplay, isUsageDisplay } from '../../types/subscription-components.types';

/**
 * SubscriptionDashboard
 *
 * Complete subscription management page showing:
 * - Current plan details
 * - Usage statistics with progress bars
 * - Available plans grid
 * - Upgrade recommendations
 * - Subscription history
 */
export default function SubscriptionDashboard(): ReactElement {
  const navigate = useNavigate();
  const {
    subscription,
    availablePlans,
    usage,
    warnings,
    recommendations,
    loading,
    error,
    refresh
  } = useSubscription();

  const [selectedPlan, setSelectedPlan] = useState<PlanDisplay | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const handlePlanSelect = useCallback((planCode: string): void => {
    const plan = availablePlans.find((p) => {
      // Handle both camelCase and snake_case
      const planCodeMatch = (p as { planCode?: string; plan_code?: string }).planCode === planCode ||
                            (p as { planCode?: string; plan_code?: string }).plan_code === planCode;
      return planCodeMatch;
    });
    
    if (plan) {
      // Convert to PlanDisplay format
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
      
      const currentPlanCode = (subscription as { plan_code?: string; planCode?: string })?.plan_code ||
                              (subscription as { plan_code?: string; planCode?: string })?.planCode;
      
      if (planDisplay.plan_code !== currentPlanCode) {
        setSelectedPlan(planDisplay);
        setModalOpen(true);
      }
    }
  }, [availablePlans, subscription]);

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
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0" />
            <div>
              <h3 className="text-lg font-semibold text-red-900">Error Loading Subscription</h3>
              <p className="text-sm text-red-700 mt-1">{error}</p>
              <button
                onClick={() => void handleRefresh()}
                className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Type-safe subscription and usage
  const subscriptionDisplay = subscription && isSubscriptionDisplay(subscription) ? subscription : null;
  const usageDisplay = usage && isUsageDisplay(usage) ? usage : null;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Subscription & Billing</h1>
          <p className="text-gray-600 mt-1">Manage your plan and usage</p>
        </div>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Warnings */}
      {warnings && warnings.length > 0 && (
        <div className="space-y-3">
          {warnings.map((warning, index) => {
            const warningDisplay = warning as SubscriptionWarning;
            return (
              <div
                key={index}
                className={`
                  border-l-4 rounded-lg p-4
                  ${warningDisplay.severity === 'critical'
                    ? 'bg-red-50 border-red-500'
                    : 'bg-yellow-50 border-yellow-500'
                  }
                `}
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                    warningDisplay.severity === 'critical' ? 'text-red-600' : 'text-yellow-600'
                  }`} />
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${
                      warningDisplay.severity === 'critical' ? 'text-red-900' : 'text-yellow-900'
                    }`}>
                      {warningDisplay.message}
                    </p>
                    {warningDisplay.action_label && (
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent('openUpgradeModal'))}
                        className={`mt-2 text-sm font-medium ${
                          warningDisplay.severity === 'critical' ? 'text-red-700 hover:text-red-800' : 'text-yellow-700 hover:text-yellow-800'
                        }`}
                      >
                        {warningDisplay.action_label} →
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Current Plan Card */}
      {subscriptionDisplay && (
        <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-xl p-6 border border-blue-200">
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-600 rounded-lg">
                <Crown className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">{subscriptionDisplay.plan_name}</h2>
                <p className="text-sm text-gray-600 mt-0.5">
                  Status: <span className={`font-semibold ${
                    subscriptionDisplay.status === 'active' ? 'text-green-600' :
                    subscriptionDisplay.status === 'past_due' ? 'text-red-600' :
                    'text-yellow-600'
                  }`}>
                    {subscriptionDisplay.status}
                  </span>
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold text-gray-900">
                {subscriptionDisplay.price_display || 'Free'}
              </p>
              {!subscriptionDisplay.plan_code.includes('free') && subscriptionDisplay.billing_cycle && (
                <p className="text-sm text-gray-600">
                  per {subscriptionDisplay.billing_cycle === 'six_months' ? '6 months' : subscriptionDisplay.billing_cycle.replace('_', ' ')}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Storage Quota */}
            <div className="bg-white rounded-lg p-4">
              <div className="flex items-center gap-2 text-gray-600 mb-2">
                <HardDrive className="w-4 h-4" />
                <span className="text-sm font-medium">Storage Quota</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{subscriptionDisplay.storage_quota_gb} GB</p>
            </div>

            {/* Bandwidth Limit */}
            <div className="bg-white rounded-lg p-4">
              <div className="flex items-center gap-2 text-gray-600 mb-2">
                <Gauge className="w-4 h-4" />
                <span className="text-sm font-medium">Bandwidth Limit</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{subscriptionDisplay.bandwidth_quota_mbps} Mbps</p>
            </div>

            {/* Next Billing Date */}
            {subscriptionDisplay.next_billing_date && (
              <div className="bg-white rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-600 mb-2">
                  <Calendar className="w-4 h-4" />
                  <span className="text-sm font-medium">Next Billing</span>
                </div>
                <p className="text-lg font-bold text-gray-900">
                  {new Date(subscriptionDisplay.next_billing_date).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Usage Section */}
      {usageDisplay && (
        <div className="bg-white rounded-xl p-6 border border-gray-200">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Current Usage</h2>

          {/* Storage Usage */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-blue-600" />
                <span className="font-medium text-gray-900">Storage</span>
              </div>
              <span className="text-sm text-gray-600">
                {usageDisplay.storage_used_display} / {usageDisplay.storage_quota_display}
              </span>
            </div>
            <div className="relative w-full h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${
                  usageDisplay.storage_percent >= 95 ? 'bg-red-500' :
                  usageDisplay.storage_percent >= 80 ? 'bg-yellow-500' :
                  'bg-blue-500'
                }`}
                style={{ width: `${Math.min(usageDisplay.storage_percent, 100)}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 mt-1">
              {usageDisplay.storage_percent.toFixed(1)}% used
            </p>
          </div>

          {/* Bandwidth Usage (if available) */}
          {usageDisplay.bandwidth_used_display && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Gauge className="w-5 h-5 text-green-600" />
                  <span className="font-medium text-gray-900">Bandwidth</span>
                </div>
                <span className="text-sm text-gray-600">
                  Current: {usageDisplay.bandwidth_used_display}
                </span>
              </div>
              {usageDisplay.bandwidth_quota_display && (
                <p className="text-sm text-gray-600">
                  Limit: {usageDisplay.bandwidth_quota_display}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Recommendations */}
      {recommendations && recommendations.length > 0 && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-purple-600" />
            <h2 className="text-xl font-bold text-gray-900">Recommended for You</h2>
          </div>
          <div className="space-y-3">
            {recommendations.map((rec, index) => {
              const recDisplay = rec as SubscriptionRecommendation;
              return (
                <div key={index} className="bg-white rounded-lg p-4">
                  <p className="text-sm text-gray-900 font-medium">
                    {recDisplay.message || recDisplay.reason || 'Recommended plan'}
                  </p>
                  {recDisplay.plan_code && (
                    <button
                      onClick={() => handlePlanSelect(recDisplay.plan_code!)}
                      className="mt-2 text-sm font-medium text-purple-600 hover:text-purple-700"
                    >
                      View {recDisplay.plan_name || recDisplay.plan_code} →
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Upgrade Plans Button */}
      <div className="bg-white rounded-xl p-6 border border-gray-200">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Upgrade Your Plan</h2>
        <p className="text-gray-600 mb-6">
          Explore our range of plans and upgrade to get more storage, bandwidth, and premium features.
        </p>
        <button
          onClick={() => navigate('/pricing')}
          className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white rounded-lg font-semibold transition-all shadow-sm"
        >
          <TrendingUp size={20} />
          View All Plans
        </button>
      </div>

      {/* Billing Portal Link (for Stripe customers) */}
      {subscriptionDisplay && !subscriptionDisplay.plan_code.includes('free') && (
        <div className="bg-gray-50 rounded-xl p-6 border border-gray-200">
          <h3 className="font-semibold text-gray-900 mb-3">Payment & Invoices</h3>
          <p className="text-sm text-gray-600 mb-4">
            Manage your payment methods and view past invoices in the Stripe billing portal.
          </p>
          <a
            href="/api/v1/billing/portal"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Open Billing Portal
          </a>
        </div>
      )}

      {/* Plan Change Modal */}
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
 * Loading skeleton for SubscriptionDashboard
 */
function SubscriptionDashboardSkeleton(): ReactElement {
  return (
    <div className="max-w-7xl mx-auto p-6 space-y-8 animate-pulse">
      <div className="h-10 bg-gray-200 rounded w-64"></div>
      <div className="h-48 bg-gray-200 rounded-xl"></div>
      <div className="h-40 bg-gray-200 rounded-xl"></div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <PlanCardSkeleton />
        <PlanCardSkeleton />
        <PlanCardSkeleton />
        <PlanCardSkeleton />
      </div>
    </div>
  );
}

/**
 * PlanCardSkeleton component (imported from PlanCard)
 */
function PlanCardSkeleton(): ReactElement {
  return (
    <div className="border-2 border-gray-200 rounded-xl p-6 bg-white animate-pulse">
      <div className="text-center mb-4">
        <div className="h-6 bg-gray-200 rounded w-32 mx-auto mb-2"></div>
        <div className="h-4 bg-gray-200 rounded w-24 mx-auto mb-3"></div>
        <div className="h-8 bg-gray-200 rounded w-20 mx-auto"></div>
      </div>

      <div className="space-y-2 mb-4 pb-4 border-b border-gray-200">
        <div className="h-5 bg-gray-200 rounded"></div>
        <div className="h-5 bg-gray-200 rounded"></div>
      </div>

      <div className="space-y-2 mb-6">
        <div className="h-4 bg-gray-200 rounded"></div>
        <div className="h-4 bg-gray-200 rounded"></div>
        <div className="h-4 bg-gray-200 rounded"></div>
      </div>

      <div className="h-12 bg-gray-200 rounded-lg"></div>
    </div>
  );
}
