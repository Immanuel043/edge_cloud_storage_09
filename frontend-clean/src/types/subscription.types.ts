/**
 * Subscription and Billing Types
 */

export interface Subscription {
  id: string;
  userId: string;
  planType: string;
  billingCycle: 'monthly' | 'yearly';
  status: 'active' | 'cancelled' | 'expired' | 'past_due';
  startedAt: string;
  expiresAt?: string;
  stripeSubscriptionId?: string;
}

export interface Plan {
  planCode: string;
  displayName: string;
  storageGb: number;
  bandwidthMbps: number;
  priceMonthly: number;
  priceYearly?: number;
  features: Record<string, boolean>;
}

export interface PaymentMethod {
  id: string;
  type: 'card' | 'paypal';
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
}
