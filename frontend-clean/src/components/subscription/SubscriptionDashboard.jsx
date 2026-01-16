import React, { useState } from 'react';
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
export default function SubscriptionDashboard() {
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

  const [selectedPlan, setSelectedPlan] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handlePlanSelect = (planCode) => {
    const plan = availablePlans.find(p => p.plan_code === planCode);
    if (plan && plan.plan_code !== subscription?.plan_code) {
      setSelectedPlan(plan);
      setModalOpen(true);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

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
                onClick={handleRefresh}
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

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Subscription & Billing</h1>
          <p className="text-gray-600 mt-1">Manage your plan and usage</p>
        </div>
        <button
          onClick={handleRefresh}
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
          {warnings.map((warning, index) => (
            <div
              key={index}
              className={`
                border-l-4 rounded-lg p-4
                ${warning.severity === 'critical'
                  ? 'bg-red-50 border-red-500'
                  : 'bg-yellow-50 border-yellow-500'
                }
              `}
            >
              <div className="flex items-start gap-3">
                <AlertCircle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                  warning.severity === 'critical' ? 'text-red-600' : 'text-yellow-600'
                }`} />
                <div className="flex-1">
                  <p className={`text-sm font-medium ${
                    warning.severity === 'critical' ? 'text-red-900' : 'text-yellow-900'
                  }`}>
                    {warning.message}
                  </p>
                  {warning.action_label && (
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent('openUpgradeModal'))}
                      className={`mt-2 text-sm font-medium ${
                        warning.severity === 'critical' ? 'text-red-700 hover:text-red-800' : 'text-yellow-700 hover:text-yellow-800'
                      }`}
                    >
                      {warning.action_label} →
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Current Plan Card */}
      {subscription && (
        <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-xl p-6 border border-blue-200">
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-600 rounded-lg">
                <Crown className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">{subscription.plan_name}</h2>
                <p className="text-sm text-gray-600 mt-0.5">
                  Status: <span className={`font-semibold ${
                    subscription.status === 'active' ? 'text-green-600' :
                    subscription.status === 'past_due' ? 'text-red-600' :
                    'text-yellow-600'
                  }`}>
                    {subscription.status}
                  </span>
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold text-gray-900">
                {subscription.price_display || 'Free'}
              </p>
              {!subscription.plan_code.includes('free') && subscription.billing_cycle && (
                <p className="text-sm text-gray-600">
                  per {subscription.billing_cycle === 'six_months' ? '6 months' : subscription.billing_cycle.replace('_', ' ')}
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
              <p className="text-2xl font-bold text-gray-900">{subscription.storage_quota_gb} GB</p>
            </div>

            {/* Bandwidth Limit */}
            <div className="bg-white rounded-lg p-4">
              <div className="flex items-center gap-2 text-gray-600 mb-2">
                <Gauge className="w-4 h-4" />
                <span className="text-sm font-medium">Bandwidth Limit</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{subscription.bandwidth_quota_mbps} Mbps</p>
            </div>

            {/* Next Billing Date */}
            {subscription.next_billing_date && (
              <div className="bg-white rounded-lg p-4">
                <div className="flex items-center gap-2 text-gray-600 mb-2">
                  <Calendar className="w-4 h-4" />
                  <span className="text-sm font-medium">Next Billing</span>
                </div>
                <p className="text-lg font-bold text-gray-900">
                  {new Date(subscription.next_billing_date).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Usage Section */}
      {usage && (
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
                {usage.storage_used_display} / {usage.storage_quota_display}
              </span>
            </div>
            <div className="relative w-full h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${
                  usage.storage_percent >= 95 ? 'bg-red-500' :
                  usage.storage_percent >= 80 ? 'bg-yellow-500' :
                  'bg-blue-500'
                }`}
                style={{ width: `${Math.min(usage.storage_percent, 100)}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 mt-1">
              {usage.storage_percent.toFixed(1)}% used
            </p>
          </div>

          {/* Bandwidth Usage (if available) */}
          {usage.bandwidth_used_display && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Gauge className="w-5 h-5 text-green-600" />
                  <span className="font-medium text-gray-900">Bandwidth</span>
                </div>
                <span className="text-sm text-gray-600">
                  Current: {usage.bandwidth_used_display}
                </span>
              </div>
              <p className="text-sm text-gray-600">
                Limit: {usage.bandwidth_quota_display}
              </p>
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
            {recommendations.map((rec, index) => (
              <div key={index} className="bg-white rounded-lg p-4">
                <p className="text-sm text-gray-900 font-medium">{rec.message}</p>
                {rec.plan_code && (
                  <button
                    onClick={() => handlePlanSelect(rec.plan_code)}
                    className="mt-2 text-sm font-medium text-purple-600 hover:text-purple-700"
                  >
                    View {rec.plan_name} →
                  </button>
                )}
              </div>
            ))}
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
      {subscription && !subscription.plan_code.includes('free') && (
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
      <PlanChangeModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        targetPlan={selectedPlan}
      />
    </div>
  );
}

/**
 * Loading skeleton for SubscriptionDashboard
 */
function SubscriptionDashboardSkeleton() {
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
