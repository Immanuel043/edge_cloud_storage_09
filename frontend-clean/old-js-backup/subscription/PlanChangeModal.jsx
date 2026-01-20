import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ArrowRight, HardDrive, Gauge, Check, AlertCircle, CreditCard } from 'lucide-react';
import { useSubscription } from '../../contexts/SubscriptionContext';
import subscriptionService from '../../services/subscriptionService';

/**
 * PlanChangeModal
 *
 * Confirmation modal for upgrading or downgrading subscription plans.
 *
 * Features:
 * - Shows before/after comparison
 * - Displays storage and bandwidth differences
 * - Shows pricing changes
 * - Handles Stripe redirect for paid plans
 * - Preview API call before confirmation
 *
 * Props:
 * - isOpen: Whether modal is visible
 * - onClose: Close handler
 * - targetPlan: Plan object to change to
 */
export default function PlanChangeModal({ isOpen, onClose, targetPlan }) {
  const navigate = useNavigate();
  const { subscription, upgrade, downgrade, previewChange, isUpgrade } = useSubscription();

  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [paymentGateways, setPaymentGateways] = useState([]);
  const [selectedGateway, setSelectedGateway] = useState('');
  const [selectedBillingCycle, setSelectedBillingCycle] = useState('monthly');
  const [loadingGateways, setLoadingGateways] = useState(false);

  // Load preview and payment gateways when modal opens
  useEffect(() => {
    if (isOpen && targetPlan) {
      loadPreview();
      loadPaymentGateways();
    }
  }, [isOpen, targetPlan]);

  const loadPreview = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await previewChange(targetPlan.plan_code);
      setPreview(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadPaymentGateways = async () => {
    try {
      setLoadingGateways(true);
      const data = await subscriptionService.getAvailablePaymentGateways();
      setPaymentGateways(data.gateways || []);
      if (data.gateways && data.gateways.length > 0) {
        setSelectedGateway(data.gateways[0].id);
      }
    } catch (err) {
      console.error('Failed to load payment gateways:', err);
    } finally {
      setLoadingGateways(false);
    }
  };

  const handleConfirm = async () => {
    try {
      setConfirming(true);
      setError(null);

      const isUpgrading = isUpgrade(targetPlan.plan_code);
      const planPrice = targetPlan.price_monthly || targetPlan.price_yearly || 0;

      // Check if plan is paid
      if (isUpgrading && planPrice > 0) {
        // Paid plan - use payment gateway
        if (!selectedGateway) {
          setError('Please select a payment gateway');
          setConfirming(false);
          return;
        }

        try {
          const paymentResult = await subscriptionService.createPayment(
            targetPlan.plan_code,
            selectedBillingCycle,
            selectedGateway
          );

          // If free plan upgrade, close modal and redirect to dashboard
          if (paymentResult.free_plan) {
            onClose();
            setTimeout(() => {
              navigate('/');
            }, 500);
            return;
          }

          // For Razorpay, we might need to handle payment differently
          // For Stripe, redirect happens automatically
          if (paymentResult.payment_url) {
            // Redirect will happen automatically
            return;
          }
        } catch (paymentErr) {
          setError(paymentErr.message);
          setConfirming(false);
          return;
        }
      } else {
        // Free plan or downgrade - use direct upgrade/downgrade
        if (isUpgrading) {
          await upgrade(targetPlan.plan_code);
        } else {
          await downgrade(targetPlan.plan_code);
        }
        onClose();
        // Redirect to dashboard after successful upgrade/downgrade
        setTimeout(() => {
          navigate('/');
        }, 500);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  if (!isOpen || !targetPlan || !subscription) return null;

  const isUpgrading = isUpgrade(targetPlan.plan_code);
  const changeType = isUpgrading ? 'Upgrade' : 'Downgrade';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {changeType} Plan
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-gray-600 mt-4">Loading preview...</p>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-900">Error</p>
                  <p className="text-sm text-red-700 mt-1">{error}</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Plan Comparison */}
              <div className="bg-gray-50 rounded-lg p-6 mb-6">
                <div className="grid grid-cols-3 gap-4 items-center">
                  {/* Current Plan */}
                  <div className="text-center">
                    <p className="text-sm text-gray-600 mb-2">Current Plan</p>
                    <p className="text-lg font-bold text-gray-900">{subscription.plan_name}</p>
                    <p className="text-sm text-gray-600 mt-1">{subscription.price_display || 'Free'}</p>
                  </div>

                  {/* Arrow */}
                  <div className="flex justify-center">
                    <ArrowRight className="w-6 h-6 text-gray-400" />
                  </div>

                  {/* New Plan */}
                  <div className="text-center">
                    <p className="text-sm text-gray-600 mb-2">New Plan</p>
                    <p className="text-lg font-bold text-blue-600">{targetPlan.display_name}</p>
                    <p className="text-sm text-gray-600 mt-1">{targetPlan.price_display}</p>
                  </div>
                </div>
              </div>

              {/* Changes Summary */}
              <div className="space-y-4 mb-6">
                <h3 className="font-semibold text-gray-900 text-lg">What's changing:</h3>

                {/* Storage Change */}
                <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-lg">
                  <HardDrive className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">Storage</p>
                    <p className="text-sm text-gray-600 mt-1">
                      {subscription.storage_quota_gb} GB → {targetPlan.storage_gb} GB
                      <span className={`ml-2 font-semibold ${isUpgrading ? 'text-green-600' : 'text-orange-600'}`}>
                        ({isUpgrading ? '+' : ''}{targetPlan.storage_gb - subscription.storage_quota_gb} GB)
                      </span>
                    </p>
                  </div>
                </div>

                {/* Bandwidth Change */}
                <div className="flex items-start gap-3 p-4 bg-green-50 rounded-lg">
                  <Gauge className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">Bandwidth</p>
                    <p className="text-sm text-gray-600 mt-1">
                      {subscription.bandwidth_quota_mbps} Mbps → {targetPlan.bandwidth_mbps} Mbps
                      <span className={`ml-2 font-semibold ${isUpgrading ? 'text-green-600' : 'text-orange-600'}`}>
                        ({isUpgrading ? '+' : ''}{targetPlan.bandwidth_mbps - subscription.bandwidth_quota_mbps} Mbps)
                      </span>
                    </p>
                  </div>
                </div>

                {/* Features */}
                {targetPlan.features && targetPlan.features.length > 0 && (
                  <div className="p-4 bg-purple-50 rounded-lg">
                    <p className="font-medium text-gray-900 mb-2">Features included:</p>
                    <div className="space-y-1">
                      {targetPlan.features.map((feature, index) => {
                        // Handle both string features and object features
                        const featureText = typeof feature === 'string'
                          ? feature
                          : (feature?.description || feature?.name || 'Feature');
                        const isAvailable = typeof feature === 'string' || feature?.available !== false;

                        return (
                          <div key={index} className="flex items-start gap-2">
                            <Check className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isAvailable ? 'text-purple-600' : 'text-gray-400'}`} />
                            <span className={`text-sm ${isAvailable ? 'text-gray-700' : 'text-gray-400'}`}>
                              {featureText}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Payment Gateway Selection (for paid upgrades) */}
              {isUpgrading && targetPlan.price_monthly > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
                  <h3 className="font-semibold text-gray-900 text-lg mb-4 flex items-center gap-2">
                    <CreditCard className="w-5 h-5" />
                    Payment Details
                  </h3>
                  
                  {/* Billing Cycle Selection */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Billing Cycle
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {['monthly', 'six_months', 'yearly'].map((cycle) => {
                        const priceKey = cycle === 'six_months' ? 'price_six_months' : `price_${cycle}`;
                        const price = targetPlan[priceKey] || 0;
                        return (
                          <button
                            key={cycle}
                            onClick={() => setSelectedBillingCycle(cycle)}
                            className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                              selectedBillingCycle === cycle
                                ? 'border-blue-600 bg-blue-50 text-blue-900'
                                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                            }`}
                          >
                            <div className="text-sm font-medium capitalize">{cycle.replace('_', '-')}</div>
                            <div className="text-xs text-gray-600 mt-1">
                              ${price.toFixed(2)}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Payment Gateway Selection */}
                  {loadingGateways ? (
                    <div className="text-center py-4">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto"></div>
                      <p className="text-sm text-gray-600 mt-2">Loading payment options...</p>
                    </div>
                  ) : paymentGateways.length > 0 ? (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Payment Method
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {paymentGateways.map((gateway) => (
                          <button
                            key={gateway.id}
                            onClick={() => setSelectedGateway(gateway.id)}
                            className={`px-4 py-3 rounded-lg border-2 transition-colors text-left ${
                              selectedGateway === gateway.id
                                ? 'border-blue-600 bg-blue-50'
                                : 'border-gray-200 bg-white hover:border-gray-300'
                            }`}
                          >
                            <div className="font-medium text-gray-900">{gateway.name}</div>
                            <div className="text-xs text-gray-600 mt-1">
                              {gateway.supported_methods.join(', ')}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-600">
                      No payment gateways available. Please contact support.
                    </div>
                  )}
                </div>
              )}

              {/* Pricing Info */}
              {preview && preview.prorated_charge && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
                  <p className="text-sm font-medium text-yellow-900">Prorated Charge</p>
                  <p className="text-sm text-yellow-700 mt-1">
                    You'll be charged ${preview.prorated_charge.toFixed(2)} today for the remainder of this billing period.
                  </p>
                </div>
              )}

              {/* Downgrade Warning */}
              {!isUpgrading && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-orange-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-orange-900">Important</p>
                      <p className="text-sm text-orange-700 mt-1">
                        If your current storage usage exceeds the new plan's limit, you won't be able to upload new files until you free up space.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Effective Date */}
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <p className="text-sm text-gray-600">
                  <span className="font-medium text-gray-900">Effective:</span> Immediately after confirmation
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            disabled={confirming}
            className="px-6 py-2 rounded-lg font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming || loading || !!error}
            className={`
              px-6 py-2 rounded-lg font-medium text-white transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed
              ${isUpgrading
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-orange-600 hover:bg-orange-700'
              }
            `}
          >
            {confirming ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Processing...
              </span>
            ) : (
              `Confirm ${changeType}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
