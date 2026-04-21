import React, { useState, useEffect } from 'react';
import { CreditCard, Calendar, AlertCircle, X } from 'lucide-react';
import { API_URL } from '../../config/constants';
import { useSubscription } from '../../contexts/SubscriptionContext';
import type { PaymentReminderBannerProps, PaymentReminderData } from './types';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';

type UrgencyLevel = 'danger' | 'warning' | 'primary';

interface UrgencyScheme {
  border: string;
  bg: string;
  accent: string;
}

const urgencyMap: Record<UrgencyLevel, UrgencyScheme> = {
  danger: {
    border: 'border-danger/30',
    bg: 'bg-danger/10',
    accent: 'text-danger',
  },
  warning: {
    border: 'border-warning/30',
    bg: 'bg-warning/10',
    accent: 'text-warning',
  },
  primary: {
    border: 'border-primary/30',
    bg: 'bg-primary/10',
    accent: 'text-primary',
  },
};

/**
 * PaymentReminderBanner — tier-coloured reminder shown a few days before a
 * paid subscription renews. Urgency rises (primary → warning → danger) as
 * the due date nears; dismissal is persisted in localStorage for 24 hours.
 */
const PaymentReminderBanner: React.FC<PaymentReminderBannerProps> = () => {
  const { subscription, loading: subscriptionLoading } = useSubscription();
  const [paymentData, setPaymentData] = useState<PaymentReminderData | null>(null);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [hasFetched, setHasFetched] = useState<boolean>(false);

  useEffect(() => {
    if (!subscriptionLoading && !hasFetched) {
      if (subscription) {
        const tierName = (subscription.plan as { tier_name?: string })?.tier_name;
        if (tierName && tierName !== 'free') {
          setHasFetched(true);
          void fetchUpcomingPayment();
        } else {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    }
  }, [subscription, subscriptionLoading, hasFetched]);

  const wasDismissedToday = (): boolean => {
    const dismissal = localStorage.getItem('payment_reminder_dismissed');
    if (!dismissal) return false;
    const dismissedAt = parseInt(dismissal, 10);
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    return now - dismissedAt < oneDayMs;
  };

  const fetchUpcomingPayment = async (): Promise<void> => {
    try {
      const response = await fetch(`${API_URL}/api/v1/billing/upcoming-payment`, {
        credentials: 'include',
      });
      if (response.status === 404) {
        setLoading(false);
        return;
      }
      if (response.ok) {
        const data = (await response.json()) as PaymentReminderData;
        if (!wasDismissedToday()) {
          setPaymentData(data);
          setIsVisible(true);
        }
      } else {
        console.error('Failed to fetch upcoming payment:', response.status, response.statusText);
      }
    } catch (error: unknown) {
      console.error('Failed to fetch upcoming payment:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = (): void => {
    localStorage.setItem('payment_reminder_dismissed', Date.now().toString());
    setIsVisible(false);
  };

  if (loading || !isVisible || !paymentData) {
    return null;
  }

  const formatDate = (isoDate: string): string =>
    new Date(isoDate).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

  const getUrgency = (days: number): UrgencyLevel => {
    if (days <= 1) return 'danger';
    if (days <= 3) return 'warning';
    return 'primary';
  };

  const urgency = getUrgency(paymentData.days_until_payment);
  const scheme = urgencyMap[urgency];

  return (
    <div className={cn('mb-4 rounded-xl border p-4', scheme.border, scheme.bg)}>
      <div className="flex items-start gap-3">
        <div className={cn('flex-shrink-0 rounded-lg p-2', scheme.bg, scheme.accent)}>
          <CreditCard className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h3 className="flex items-center gap-2 font-semibold text-fg">
                {paymentData.days_until_payment <= 1 && (
                  <AlertCircle className={cn('h-4 w-4 flex-shrink-0', scheme.accent)} />
                )}
                Payment reminder
              </h3>
              <p className="mt-1 text-body-sm text-fg-muted">
                Your <strong className="text-fg">{paymentData.plan_name}</strong> subscription (
                {paymentData.billing_cycle.replace('_', ' ')}) will renew in{' '}
                <strong className="text-fg">
                  {paymentData.days_until_payment} day
                  {paymentData.days_until_payment !== 1 ? 's' : ''}
                </strong>
                .
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-4 text-body-sm">
                <div className="flex items-center gap-2 text-fg-muted">
                  <Calendar className="h-3.5 w-3.5" />
                  <span className="text-fg">{formatDate(paymentData.payment_due_date)}</span>
                </div>
                <div className={cn('font-semibold', scheme.accent)}>
                  ₹{paymentData.amount_due.toFixed(2)}
                </div>
              </div>
            </div>

            <IconButton
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PaymentReminderBanner;
