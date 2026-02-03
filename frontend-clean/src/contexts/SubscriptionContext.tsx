import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import subscriptionService, { type PreviewChangeResponse } from '../services/subscriptionService';
import { useNotification } from './NotificationContext';
import { useAuth } from './AuthContext';

interface Plan {
  plan_code: string;
  display_name: string;
  stripe_price_id?: string | null;
  tier: number;
  [key: string]: unknown;
}

interface Subscription {
  plan_code: string;
  tier: number;
  storage_quota_gb: number;
  bandwidth_quota_mbps?: number;
  [key: string]: unknown;
}

interface Usage {
  storage_used_bytes: number;
  [key: string]: unknown;
}

interface Warning {
  type: string;
  severity: string;
  message: string;
  action_label?: string;
  action_type?: string;
  [key: string]: unknown;
}

interface Recommendation {
  [key: string]: unknown;
}

interface QuotaCheckResult {
  allowed: boolean;
  message: string | null;
  quotaExceeded?: boolean;
  warning?: boolean;
}

interface SubscriptionContextValue {
  // State
  subscription: Subscription | null;
  availablePlans: Plan[];
  usage: Usage | null;
  warnings: Warning[];
  recommendations: Recommendation[];
  loading: boolean;
  error: string | null;

  // Methods
  refresh: () => Promise<void>;
  upgrade: (planCode: string) => Promise<unknown>;
  downgrade: (planCode: string) => Promise<unknown>;
  previewChange: (planCode: string) => Promise<PreviewChangeResponse>;
  cancel: () => Promise<unknown>;
  checkQuota: (fileSize: number) => QuotaCheckResult;
  getPlanByCode: (planCode: string) => Plan | undefined;
  isUpgrade: (planCode: string) => boolean;
  isDowngrade: (planCode: string) => boolean;
}

interface SubscriptionProviderProps {
  children: React.ReactNode;
}

const SubscriptionContext = createContext<SubscriptionContextValue | undefined>(undefined);

export const useSubscription = (): SubscriptionContextValue => {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error('useSubscription must be used within SubscriptionProvider');
  }
  return context;
};

/**
 * SubscriptionProvider
 *
 * Manages subscription state across the application.
 *
 * Features:
 * - Fetches subscription data on mount
 * - Polls for updates every 30 seconds
 * - Provides upgrade/downgrade methods
 * - Caches plan limits for quota checks
 * - Integrates with notification system
 * - Automatically detects service type (normal/zk) from AuthContext
 */
export function SubscriptionProvider({ children }: SubscriptionProviderProps): React.ReactElement {
  const { showNotification } = useNotification();
  const { zkEnabled, isAuthenticated } = useAuth();

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [availablePlans, setAvailablePlans] = useState<Plan[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Update subscription service type when zkEnabled changes
   */
  useEffect(() => {
    const serviceType = zkEnabled ? 'zk' : 'normal';
    subscriptionService.setServiceType(serviceType);
    console.log(`[SubscriptionContext] Service type set to: ${serviceType}`);

    // Refetch dashboard data when service type changes (only if authenticated)
    if (!loading && isAuthenticated) {
      fetchDashboard();
    }
  }, [zkEnabled, isAuthenticated]); // Note: Not including fetchDashboard/loading to avoid infinite loop

  /**
   * Fetch complete dashboard data
   */
  const fetchDashboard = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const data = await subscriptionService.getDashboard();

      setSubscription(data.current_subscription as any);
      setAvailablePlans(data.available_plans as any || []);
      setUsage(null);
      setWarnings(data.warnings as any || []);
      setRecommendations(data.recommendations as any || []);

      // Show warnings as notifications
      if (data.warnings && data.warnings.length > 0) {
        data.warnings.forEach((warning: any) => {
          const warningKey = `warning_${warning.type}_${warning.severity}`;
          const lastShown = localStorage.getItem(warningKey);
          const now = Date.now();

          // Show warning once per hour
          if (!lastShown || now - parseInt(lastShown) > 3600000) {
            showNotification(
              warning.severity === 'critical' ? 'error' : 'warning',
              warning.message,
              {
                duration: 8000,
                action: warning.action_label ? {
                  label: warning.action_label,
                  onClick: () => {
                    if (warning.action_type === 'upgrade') {
                      // Open upgrade modal
                      window.dispatchEvent(new CustomEvent('openUpgradeModal'));
                    }
                  }
                } : null
              }
            );
            localStorage.setItem(warningKey, now.toString());
          }
        });
      }

      setLoading(false);
    } catch (err) {
      console.error('Error fetching subscription dashboard:', err);
      setError((err as Error).message);
      setLoading(false);
    }
  }, [showNotification]);

  /**
   * Refresh subscription data
   */
  const refresh = useCallback(async (): Promise<void> => {
    await fetchDashboard();
  }, [fetchDashboard]);

  /**
   * Upgrade to a higher tier plan
   */
  const upgrade = useCallback(async (planCode: string): Promise<unknown> => {
    try {
      const plan = availablePlans.find(p => p.plan_code === planCode);

      // If it's a paid plan and current is free, redirect to Stripe
      if (plan && plan.stripe_price_id && subscription?.plan_code?.includes('free')) {
        await subscriptionService.createCheckoutSession(planCode, 'monthly');
        return;
      }

      // Otherwise, direct upgrade
      const result = await subscriptionService.upgrade(planCode);

      showNotification('success', `Successfully upgraded to ${plan?.display_name || planCode}!`, {
        duration: 6000
      });

      // Refresh subscription data
      await refresh();

      return result;
    } catch (err) {
      console.error('Error upgrading subscription:', err);
      showNotification('error', `Upgrade failed: ${(err as Error).message}`);
      throw err;
    }
  }, [availablePlans, subscription, showNotification, refresh]);

  /**
   * Downgrade to a lower tier plan
   */
  const downgrade = useCallback(async (planCode: string): Promise<unknown> => {
    try {
      const plan = availablePlans.find(p => p.plan_code === planCode);

      const result = await subscriptionService.downgrade(planCode);

      showNotification('success', `Successfully downgraded to ${plan?.display_name || planCode}.`, {
        duration: 6000
      });

      // Refresh subscription data
      await refresh();

      return result;
    } catch (err) {
      console.error('Error downgrading subscription:', err);
      showNotification('error', `Downgrade failed: ${(err as Error).message}`);
      throw err;
    }
  }, [availablePlans, showNotification, refresh]);

  /**
   * Preview plan change before applying
   */
  const previewChange = useCallback(async (planCode: string): Promise<PreviewChangeResponse> => {
    try {
      return await subscriptionService.previewChange(planCode);
    } catch (err) {
      console.error('Error previewing plan change:', err);
      throw err;
    }
  }, []);

  /**
   * Cancel current subscription
   */
  const cancel = useCallback(async (): Promise<unknown> => {
    try {
      const result = await subscriptionService.cancelSubscription();

      showNotification('info', 'Subscription cancelled. You will retain access until the end of your billing period.', {
        duration: 8000
      });

      // Refresh subscription data
      await refresh();

      return result;
    } catch (err) {
      console.error('Error cancelling subscription:', err);
      showNotification('error', `Cancellation failed: ${(err as Error).message}`);
      throw err;
    }
  }, [showNotification, refresh]);

  /**
   * Check if upload would exceed quota
   */
  const checkQuota = useCallback((fileSize: number): QuotaCheckResult => {
    if (!subscription || !usage) {
      return { allowed: true, message: null };
    }

    const storageQuotaBytes = subscription.storage_quota_gb * 1024 * 1024 * 1024;
    const currentUsageBytes = usage.storage_used_bytes;
    const newUsageBytes = currentUsageBytes + fileSize;

    if (newUsageBytes > storageQuotaBytes) {
      return {
        allowed: false,
        message: `This upload would exceed your storage quota. Upgrade your plan to continue.`,
        quotaExceeded: true
      };
    }

    const percentAfter = (newUsageBytes / storageQuotaBytes) * 100;

    if (percentAfter > 95) {
      return {
        allowed: true,
        message: `Warning: You'll be at ${percentAfter.toFixed(1)}% capacity after this upload.`,
        warning: true
      };
    }

    return { allowed: true, message: null };
  }, [subscription, usage]);

  /**
   * Get plan by code
   */
  const getPlanByCode = useCallback((planCode: string): Plan | undefined => {
    return availablePlans.find(p => p.plan_code === planCode);
  }, [availablePlans]);

  /**
   * Check if a plan is an upgrade
   */
  const isUpgrade = useCallback((planCode: string): boolean => {
    const plan = getPlanByCode(planCode);
    if (!plan || !subscription) return false;

    return plan.tier > subscription.tier;
  }, [subscription, getPlanByCode]);

  /**
   * Check if a plan is a downgrade
   */
  const isDowngrade = useCallback((planCode: string): boolean => {
    const plan = getPlanByCode(planCode);
    if (!plan || !subscription) return false;

    return plan.tier < subscription.tier;
  }, [subscription, getPlanByCode]);

  /**
   * Initial load (only when authenticated)
   */
  useEffect(() => {
    if (isAuthenticated) {
      fetchDashboard();
    } else {
      // Reset state when not authenticated
      setLoading(false);
    }
  }, [fetchDashboard, isAuthenticated]);

  /**
   * Poll for updates every 30 seconds (only when authenticated)
   */
  useEffect(() => {
    if (!isAuthenticated) {
      return; // Don't poll when not authenticated
    }

    const interval = setInterval(() => {
      fetchDashboard();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchDashboard, isAuthenticated]);

  const value: SubscriptionContextValue = {
    // State
    subscription,
    availablePlans,
    usage,
    warnings,
    recommendations,
    loading,
    error,

    // Methods
    refresh,
    upgrade,
    downgrade,
    previewChange,
    cancel,
    checkQuota,
    getPlanByCode,
    isUpgrade,
    isDowngrade
  };

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export default SubscriptionContext;
