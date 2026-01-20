/**
 * Subscription Component Type Definitions
 * 
 * Production-grade types for subscription-related React components.
 * These types extend the base subscription types with component-specific structures.
 */

import type { PreviewChangeResponse } from '../services/subscriptionService';
import type { PricingPlan } from './pricing.types';

/**
 * Extended Plan interface for components (includes display properties)
 */
export interface PlanDisplay {
  /** Unique plan identifier */
  plan_code: string;
  
  /** Display name for the plan */
  display_name: string;
  
  /** Plan description */
  description?: string;
  
  /** Monthly price in currency units (null for free plans) */
  price_monthly: number | null;
  
  /** Six-month price in currency units (null if not available) */
  price_six_months?: number | null;
  
  /** Yearly price in currency units (null if not available) */
  price_yearly: number | null;
  
  /** Storage in GB */
  storage_gb: number;
  
  /** Storage in bytes (for precise calculations) */
  storage_bytes?: number;
  
  /** Bandwidth in Mbps */
  bandwidth_mbps: number;
  
  /** Burst bandwidth in Mbps */
  bandwidth_burst_mbps?: number;
  
  /** Maximum concurrent streams */
  max_concurrent_streams: number;
  
  /** Display price string (e.g., "$9.99" or "Free") */
  price_display?: string;
  
  /** Plan tier (for upgrade/downgrade logic) */
  tier?: number;
  
  /** Badge text (e.g., "Most Popular") */
  badge?: string | null;
  
  /** Plan name (alias for display_name) */
  plan_name?: string;
  
  /** Features as array (for display) or object */
  features?: (string | FeatureObject)[] | Record<string, unknown>;
  
  /** Whether plan is currently active */
  is_active?: boolean;
  
  /** Whether this is the default plan */
  is_default?: boolean;
  
  /** Whether this is the most popular plan */
  is_most_popular?: boolean;
}

/**
 * Feature object structure (from backend)
 */
export interface FeatureObject {
  name?: string;
  description?: string;
  available?: boolean;
  tooltip?: string;
}

/**
 * Extended Subscription interface for components
 */
export interface SubscriptionDisplay {
  plan_code: string;
  plan_name: string;
  status: 'active' | 'cancelled' | 'expired' | 'past_due';
  price_display?: string | null;
  billing_cycle?: 'monthly' | 'six_months' | 'yearly' | null;
  storage_quota_gb: number;
  bandwidth_quota_mbps: number;
  next_billing_date?: string | null;
  tier?: number;
  [key: string]: unknown;
}

/**
 * Usage display interface
 */
export interface UsageDisplay {
  storage_used_bytes: number;
  storage_used_display: string;
  storage_quota_display: string;
  storage_percent: number;
  bandwidth_used_display?: string;
  bandwidth_quota_display?: string;
  bandwidth_percent?: number;
  [key: string]: unknown;
}

/**
 * Warning interface for subscription warnings
 */
export interface SubscriptionWarning {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  action_label?: string;
  action_type?: string;
  [key: string]: unknown;
}

/**
 * Recommendation interface
 */
export interface SubscriptionRecommendation {
  plan_code?: string;
  plan_name?: string;
  message?: string;
  reason?: string;
  savings?: number;
  [key: string]: unknown;
}

/**
 * Payment Gateway interface (from subscriptionService)
 * Note: The API returns an array of gateway objects with this structure
 */
export interface PaymentGatewayInfo {
  id?: string;
  name: string;
  gateway?: 'razorpay' | 'stripe';
  enabled?: boolean;
  supported_methods?: string[];
  [key: string]: unknown;
}

/**
 * PlanChangeModal props
 */
export interface PlanChangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetPlan: PlanDisplay | PricingPlan | null;
}

/**
 * PlanCard props
 */
export interface PlanCardProps {
  plan: PlanDisplay;
  isCurrent?: boolean;
  onSelect: (planCode: string) => void;
  disabled?: boolean;
}

/**
 * Type guard for PlanDisplay
 */
export function isPlanDisplay(data: unknown): data is PlanDisplay {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  return (
    typeof obj.plan_code === 'string' &&
    typeof obj.display_name === 'string' &&
    typeof obj.storage_gb === 'number' &&
    typeof obj.bandwidth_mbps === 'number'
  );
}

/**
 * Type guard for SubscriptionDisplay
 */
export function isSubscriptionDisplay(data: unknown): data is SubscriptionDisplay {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  return (
    typeof obj.plan_code === 'string' &&
    typeof obj.plan_name === 'string' &&
    typeof obj.status === 'string' &&
    typeof obj.storage_quota_gb === 'number' &&
    typeof obj.bandwidth_quota_mbps === 'number'
  );
}

/**
 * Type guard for UsageDisplay
 */
export function isUsageDisplay(data: unknown): data is UsageDisplay {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  return (
    typeof obj.storage_used_bytes === 'number' &&
    typeof obj.storage_used_display === 'string' &&
    typeof obj.storage_quota_display === 'string' &&
    typeof obj.storage_percent === 'number'
  );
}

/**
 * Type guard for PaymentGatewayInfo
 */
export function isPaymentGatewayInfo(data: unknown): data is PaymentGatewayInfo {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    (obj.gateway === 'razorpay' || obj.gateway === 'stripe') &&
    typeof obj.enabled === 'boolean' &&
    Array.isArray(obj.supported_methods)
  );
}
