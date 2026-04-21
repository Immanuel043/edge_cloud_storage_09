import { useState, useEffect, useCallback, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, HardDrive, Gauge, Check, AlertCircle, CreditCard } from 'lucide-react';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useAuth } from '../../contexts/AuthContext';
import subscriptionService from '../../services/subscriptionService';
import type {
  PlanChangeModalProps,
  PaymentGatewayInfo,
  FeatureObject,
  PlanDisplay,
} from '../../types/subscription-components.types';
import type { PreviewChangeResponse } from '../../services/subscriptionService';
import type { PricingPlan } from '../../types/pricing.types';
import { isPaymentGatewayInfo } from '../../types/subscription-components.types';
import { cn } from '@/lib/cn';
import {
  Banner,
  Button,
  Modal,
  ModalBody,
  ModalFooter,
  Spinner,
} from '@/components/ui';

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: () => void) => void;
    };
  }
}

/** Load Razorpay SDK dynamically (avoids cross-origin iframe on every page load) */
let razorpayLoadPromise: Promise<void> | null = null;
function loadRazorpaySDK(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayLoadPromise) return razorpayLoadPromise;
  razorpayLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => {
      razorpayLoadPromise = null;
      reject(new Error('Failed to load Razorpay SDK'));
    };
    document.head.appendChild(script);
  });
  return razorpayLoadPromise;
}

/**
 * PlanChangeModal — upgrade/downgrade confirmation.
 *
 * Rebuilt on the `Modal` primitive for focus trap + ESC close. Preview API
 * call, Stripe redirect, Razorpay SDK load, and dev_mode short-circuit are
 * all preserved from the prior implementation.
 */
export default function PlanChangeModal({
  isOpen,
  onClose,
  targetPlan,
  initialBillingCycle,
}: PlanChangeModalProps): ReactElement | null {
  const navigate = useNavigate();
  const { subscription, upgrade, downgrade, previewChange, isUpgrade, refresh } =
    useSubscription();
  const { user } = useAuth();

  const [preview, setPreview] = useState<PreviewChangeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [paymentGateways, setPaymentGateways] = useState<PaymentGatewayInfo[]>([]);
  const [selectedGateway, setSelectedGateway] = useState<string>('');
  const [selectedBillingCycle, setSelectedBillingCycle] = useState<
    'monthly' | 'six_months' | 'yearly'
  >(initialBillingCycle || 'monthly');
  const [loadingGateways, setLoadingGateways] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen && initialBillingCycle) {
      setSelectedBillingCycle(initialBillingCycle);
    }
  }, [isOpen, initialBillingCycle]);

  useEffect(() => {
    if (isOpen && targetPlan) {
      void loadPreview();
      void loadPaymentGateways();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, targetPlan]);

  const loadPreview = useCallback(async (): Promise<void> => {
    if (!targetPlan) return;
    try {
      setLoading(true);
      setError(null);
      const data = await previewChange(targetPlan.plan_code);
      setPreview(data);
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [targetPlan, previewChange]);

  const loadPaymentGateways = useCallback(async (): Promise<void> => {
    try {
      setLoadingGateways(true);
      const data: unknown = await subscriptionService.getAvailablePaymentGateways();

      if (Array.isArray(data)) {
        const gateways = data.filter((item): item is PaymentGatewayInfo =>
          isPaymentGatewayInfo(item)
        );
        setPaymentGateways(gateways);
        const firstGateway = gateways[0];
        if (firstGateway) {
          setSelectedGateway(firstGateway.id ?? firstGateway.name);
        }
      }
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to load payment gateways:', e);
    } finally {
      setLoadingGateways(false);
    }
  }, []);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (!targetPlan) return;

    try {
      setConfirming(true);
      setError(null);

      const isUpgrading = isUpgrade(targetPlan.plan_code);
      const planPrice = targetPlan.price_monthly ?? targetPlan.price_yearly ?? 0;

      if (isUpgrading && planPrice > 0) {
        const effectiveGateway = selectedGateway || 'razorpay';

        try {
          const gateway = paymentGateways.find(
            (g) => (g.id || g.name) === effectiveGateway
          );
          const gatewayType = (gateway?.id || gateway?.name || effectiveGateway) as
            | 'razorpay'
            | 'stripe';

          const paymentResult = await subscriptionService.createPayment(
            targetPlan.plan_code,
            selectedBillingCycle,
            gatewayType
          );

          if (
            paymentResult.free_plan ||
            (paymentResult as Record<string, unknown>).dev_mode
          ) {
            await refresh();
            onClose();
            setTimeout(() => navigate('/'), 500);
            return;
          }

          if (paymentResult.payment_url) {
            window.location.href = paymentResult.payment_url;
            return;
          }

          if (gatewayType === 'razorpay' && paymentResult.gateway_data) {
            const gd = paymentResult.gateway_data as Record<string, unknown>;
            try {
              await loadRazorpaySDK();
            } catch {
              setError(
                'Failed to load Razorpay SDK. Please check your connection and try again.'
              );
              setConfirming(false);
              return;
            }
            const rzpOptions: Record<string, unknown> = {
              key: gd.razorpay_key_id,
              amount: gd.amount,
              currency: (gd.currency as string) || 'INR',
              order_id: gd.order_id,
              name: 'Edge Cloud Storage',
              description: `${targetPlan.display_name} - ${selectedBillingCycle.replace(
                '_',
                ' '
              )}`,
              handler: async (response: {
                razorpay_payment_id: string;
                razorpay_order_id: string;
                razorpay_signature: string;
              }) => {
                try {
                  await subscriptionService.verifyPayment(
                    response.razorpay_payment_id,
                    response.razorpay_order_id,
                    response.razorpay_signature
                  );
                  await refresh();
                  onClose();
                  navigate('/');
                } catch (verifyErr) {
                  console.error('Payment verification failed:', verifyErr);
                  setError('Payment verification failed. Please contact support.');
                  setConfirming(false);
                }
              },
              prefill: {
                email: (user as { email?: string })?.email || '',
              },
              theme: { color: '#3B82F6' },
              modal: {
                ondismiss: () => {
                  setConfirming(false);
                },
              },
            };
            const rzp = new window.Razorpay(rzpOptions);
            rzp.open();
            return;
          }
        } catch (paymentErr: unknown) {
          const e =
            paymentErr instanceof Error ? paymentErr : new Error(String(paymentErr));
          setError(e.message);
          setConfirming(false);
          return;
        }
      } else {
        if (isUpgrading) {
          await upgrade(targetPlan.plan_code);
        } else {
          await downgrade(targetPlan.plan_code);
        }
        onClose();
        setTimeout(() => {
          navigate('/');
        }, 500);
      }
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e.message);
    } finally {
      setConfirming(false);
    }
  }, [
    targetPlan,
    isUpgrade,
    selectedGateway,
    selectedBillingCycle,
    paymentGateways,
    upgrade,
    downgrade,
    onClose,
    navigate,
    refresh,
    user,
  ]);

  if (!isOpen || !targetPlan || !subscription) return null;

  const isUpgrading = isUpgrade(targetPlan.plan_code);
  const changeType = isUpgrading ? 'Upgrade' : 'Downgrade';

  const getPriceDisplay = (plan: PricingPlan | PlanDisplay | null): string => {
    if (!plan) return 'Free';
    const planDisplay = plan as PlanDisplay;
    if (planDisplay.price_display) return planDisplay.price_display;
    if (planDisplay.price_monthly !== null && planDisplay.price_monthly !== undefined) {
      return `₹${planDisplay.price_monthly}`;
    }
    if (planDisplay.price_yearly !== null && planDisplay.price_yearly !== undefined) {
      return `₹${planDisplay.price_yearly}`;
    }
    return 'Free';
  };

  const getPlanName = (plan: PricingPlan | PlanDisplay | null): string => {
    if (!plan) return 'Unknown';
    const planDisplay = plan as PlanDisplay;
    return planDisplay.display_name || planDisplay.plan_name || 'Unknown';
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="lg"
      title={`${changeType} plan`}
    >
      <ModalBody className="max-h-[70vh] overflow-y-auto">
        {loading ? (
          <div className="text-center py-8">
            <Spinner size="lg" className="mx-auto" />
            <p className="text-body-sm text-fg-muted mt-4">Loading preview…</p>
          </div>
        ) : error ? (
          <Banner variant="danger" title="Error">
            {error}
          </Banner>
        ) : (
          <>
            {/* Plan comparison */}
            <div className="rounded-lg bg-surface-muted p-6 mb-6">
              <div className="grid grid-cols-3 gap-4 items-center">
                <div className="text-center">
                  <p className="text-body-sm text-fg-muted mb-2">Current plan</p>
                  <p className="text-body font-semibold text-fg">
                    {(subscription as { plan_name?: string }).plan_name ||
                      subscription.plan_code}
                  </p>
                  <p className="text-body-sm text-fg-muted mt-1">
                    {(subscription as { price_display?: string }).price_display || 'Free'}
                  </p>
                </div>

                <div className="flex justify-center">
                  <ArrowRight className="w-6 h-6 text-fg-subtle" />
                </div>

                <div className="text-center">
                  <p className="text-body-sm text-fg-muted mb-2">New plan</p>
                  <p className="text-body font-semibold text-primary">
                    {getPlanName(targetPlan)}
                  </p>
                  <p className="text-body-sm text-fg-muted mt-1">
                    {getPriceDisplay(targetPlan)}
                  </p>
                </div>
              </div>
            </div>

            {/* Changes summary */}
            <div className="space-y-3 mb-6">
              <h3 className="font-semibold text-fg text-body">What's changing</h3>

              {/* Storage */}
              <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
                <HardDrive className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium text-fg">Storage</p>
                  <p className="text-body-sm text-fg-muted mt-1">
                    {subscription.storage_quota_gb} GB → {targetPlan.storage_gb} GB
                    <span
                      className={cn(
                        'ml-2 font-semibold',
                        isUpgrading ? 'text-success' : 'text-warning'
                      )}
                    >
                      ({isUpgrading ? '+' : ''}
                      {Number(targetPlan.storage_gb) -
                        Number(subscription.storage_quota_gb)}{' '}
                      GB)
                    </span>
                  </p>
                </div>
              </div>

              {/* Bandwidth */}
              <div className="flex items-start gap-3 p-4 bg-success/5 border border-success/20 rounded-lg">
                <Gauge className="w-5 h-5 text-success shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium text-fg">Bandwidth</p>
                  <p className="text-body-sm text-fg-muted mt-1">
                    {subscription.bandwidth_quota_mbps} Mbps → {targetPlan.bandwidth_mbps}{' '}
                    Mbps
                    <span
                      className={cn(
                        'ml-2 font-semibold',
                        isUpgrading ? 'text-success' : 'text-warning'
                      )}
                    >
                      ({isUpgrading ? '+' : ''}
                      {Number(targetPlan.bandwidth_mbps) -
                        Number(subscription.bandwidth_quota_mbps)}{' '}
                      Mbps)
                    </span>
                  </p>
                </div>
              </div>

              {/* Features */}
              {targetPlan.features &&
                Array.isArray(targetPlan.features) &&
                targetPlan.features.length > 0 && (
                  <div className="p-4 bg-accent/5 border border-accent/20 rounded-lg">
                    <p className="font-medium text-fg mb-2">Features included</p>
                    <div className="space-y-1">
                      {targetPlan.features.map((feature, index) => {
                        let featureText: string;
                        let isAvailable = true;

                        if (typeof feature === 'string') {
                          featureText = feature;
                        } else if (feature && typeof feature === 'object') {
                          const featureObj = feature as FeatureObject;
                          featureText =
                            featureObj.description || featureObj.name || 'Feature';
                          isAvailable = featureObj.available !== false;
                        } else {
                          featureText = 'Feature';
                        }

                        return (
                          <div key={index} className="flex items-start gap-2">
                            <Check
                              className={cn(
                                'w-4 h-4 shrink-0 mt-0.5',
                                isAvailable ? 'text-accent' : 'text-fg-subtle'
                              )}
                            />
                            <span
                              className={cn(
                                'text-body-sm',
                                isAvailable ? 'text-fg' : 'text-fg-subtle'
                              )}
                            >
                              {featureText}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
            </div>

            {/* Payment details — paid upgrades only */}
            {isUpgrading && (targetPlan.price_monthly ?? 0) > 0 && (
              <div className="rounded-lg border border-border bg-surface p-4 mb-6">
                <h3 className="font-semibold text-fg text-body mb-4 flex items-center gap-2">
                  <CreditCard className="w-5 h-5" />
                  Payment details
                </h3>

                {/* Billing cycle */}
                <div className="mb-4">
                  <label className="block text-body-sm font-medium text-fg mb-2">
                    Billing cycle
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['monthly', 'six_months', 'yearly'] as const).map((cycle) => {
                      const priceKey =
                        cycle === 'six_months' ? 'price_six_months' : `price_${cycle}`;
                      const planRecord = targetPlan as unknown as Record<string, unknown>;
                      const price =
                        (planRecord[priceKey] as number | null | undefined) ?? 0;
                      const monthlyPrice =
                        (planRecord['price_monthly'] as number | null | undefined) ?? 0;
                      const cycleLabel =
                        cycle === 'monthly'
                          ? 'Monthly'
                          : cycle === 'six_months'
                            ? '6 months'
                            : 'Yearly';
                      const months = cycle === 'monthly' ? 1 : cycle === 'six_months' ? 6 : 12;
                      const savings =
                        monthlyPrice > 0 && months > 1
                          ? Math.round((1 - price / (monthlyPrice * months)) * 100)
                          : 0;
                      const active = selectedBillingCycle === cycle;
                      return (
                        <button
                          key={cycle}
                          type="button"
                          onClick={() => setSelectedBillingCycle(cycle)}
                          aria-pressed={active}
                          className={cn(
                            'rounded-lg border-2 px-4 py-3 text-left transition-colors',
                            active
                              ? 'border-primary bg-primary/5 text-primary'
                              : 'border-border bg-surface text-fg hover:border-border-strong'
                          )}
                        >
                          <div className="text-body-sm font-medium">{cycleLabel}</div>
                          <div className="text-body font-bold mt-1">
                            ₹{Math.round(price)}
                          </div>
                          {savings > 0 && (
                            <div className="text-caption text-success font-medium mt-0.5">
                              Save {savings}%
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Payment gateway */}
                {loadingGateways ? (
                  <div className="text-center py-4">
                    <Spinner size="md" className="mx-auto" />
                    <p className="text-body-sm text-fg-muted mt-2">
                      Loading payment options…
                    </p>
                  </div>
                ) : paymentGateways.length > 0 ? (
                  <div>
                    <label className="block text-body-sm font-medium text-fg mb-2">
                      Payment method
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {paymentGateways.map((gateway) => {
                        const gatewayId = gateway.id || gateway.name;
                        const active = selectedGateway === gatewayId;
                        return (
                          <button
                            key={gatewayId}
                            type="button"
                            onClick={() => setSelectedGateway(gatewayId)}
                            aria-pressed={active}
                            className={cn(
                              'rounded-lg border-2 px-4 py-3 text-left transition-colors',
                              active
                                ? 'border-primary bg-primary/5'
                                : 'border-border bg-surface hover:border-border-strong'
                            )}
                          >
                            <div className="font-medium text-fg">{gateway.name}</div>
                            {gateway.supported_methods &&
                              Array.isArray(gateway.supported_methods) &&
                              gateway.supported_methods.length > 0 && (
                                <div className="text-caption text-fg-muted mt-1">
                                  {gateway.supported_methods.map(String).join(', ')}
                                </div>
                              )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-body-sm text-fg-muted">
                    No payment gateways available. Please contact support.
                  </div>
                )}
              </div>
            )}

            {/* Prorated charge */}
            {preview &&
              (preview as unknown as { prorated_charge?: number }).prorated_charge !==
                undefined && (
                <Banner variant="warning" title="Prorated charge" className="mb-6">
                  You'll be charged ₹
                  {(
                    preview as unknown as { prorated_charge: number }
                  ).prorated_charge.toFixed(2)}{' '}
                  today for the remainder of this billing period.
                </Banner>
              )}

            {/* Downgrade warning */}
            {!isUpgrading && (
              <Banner
                variant="warning"
                icon={<AlertCircle />}
                title="Important"
                className="mb-6"
              >
                If your current storage usage exceeds the new plan's limit, you won't be
                able to upload new files until you free up space.
              </Banner>
            )}

            {/* Effective date */}
            <div className="rounded-lg bg-surface-muted p-4">
              <p className="text-body-sm text-fg-muted">
                <span className="font-medium text-fg">Effective:</span> Immediately after
                confirmation
              </p>
            </div>
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={confirming}>
          Cancel
        </Button>
        <Button
          variant={isUpgrading ? 'primary' : 'destructive'}
          onClick={() => void handleConfirm()}
          disabled={loading || !!error}
          loading={confirming}
        >
          {confirming ? 'Processing…' : `Confirm ${changeType.toLowerCase()}`}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
