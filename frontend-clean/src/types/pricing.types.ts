/**
 * Pricing Plan Type Definitions
 * 
 * Production-grade types for pricing plans matching the backend API structure.
 * All types are based on the expected_plans_structure.json schema.
 */

/**
 * Support tier types
 */
export type SupportTier = 'community' | 'email' | 'standard' | 'priority' | '24/7';

/**
 * Encryption types
 */
export type EncryptionType = 'zero_knowledge' | 'server_side';

/**
 * Versioning can be a number or 'unlimited' or boolean
 */
export type VersioningValue = number | 'unlimited' | boolean;

/**
 * Plan features interface
 */
export interface PlanFeatures {
  /** Support tier */
  support?: SupportTier;
  
  /** File versioning (number of versions, 'unlimited', or boolean) */
  versioning?: VersioningValue;
  
  /** AI features enabled */
  ai_features?: boolean;
  
  /** Team sharing enabled */
  team_sharing?: boolean;
  
  /** WebAuthn authentication enabled */
  webauthn?: boolean;
  
  /** Number of hardware keys allowed */
  hardware_keys?: number;
  
  /** Recovery phrase enabled */
  recovery_phrase?: boolean;
  
  /** Encryption type */
  encryption?: EncryptionType;
}

/**
 * Billing cycle types
 */
export type BillingCycle = 'monthly' | 'six_months' | 'yearly';

/**
 * Service type (edge storage vs zero-knowledge)
 */
export type ServiceType = 'edge' | 'zk' | 'normal';

/**
 * Plan category
 */
export type PlanCategory = 'individual' | 'business' | 'enterprise';

/**
 * Complete pricing plan interface matching backend structure
 */
export interface PricingPlan {
  /** Unique plan identifier */
  plan_code: string;
  
  /** Display name for the plan */
  display_name: string;
  
  /** Plan description */
  description: string;
  
  /** Monthly price in currency units (null for free plans) */
  price_monthly: number | null;
  
  /** Six-month price in currency units (null if not available) */
  price_six_months: number | null;
  
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
  
  /** Plan features */
  features: PlanFeatures;
  
  /** Whether plan is currently active */
  is_active?: boolean;
  
  /** Whether this is the default plan */
  is_default?: boolean;
  
  /** Whether this is the most popular plan */
  is_most_popular?: boolean;
}

/**
 * Categorized plans structure
 */
export interface CategorizedPlans {
  individual: PricingPlan[];
  business: PricingPlan[];
  enterprise: PricingPlan[];
}

/**
 * Complete plans response structure from API
 */
export interface PlansResponse {
  plans: CategorizedPlans;
}

/**
 * API response wrapper
 */
export interface PlansApiResponse {
  edge_plans?: CategorizedPlans;
  zk_plans?: CategorizedPlans;
  plans?: CategorizedPlans;
}

/**
 * Type guard for PlanFeatures
 */
export function isPlanFeatures(data: unknown): data is PlanFeatures {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  // All fields are optional, but if present must be correct types
  if (obj.support !== undefined && typeof obj.support !== 'string') {
    return false;
  }
  
  if (obj.versioning !== undefined) {
    const versioning = obj.versioning;
    if (
      typeof versioning !== 'number' &&
      versioning !== 'unlimited' &&
      typeof versioning !== 'boolean'
    ) {
      return false;
    }
  }
  
  if (obj.ai_features !== undefined && typeof obj.ai_features !== 'boolean') {
    return false;
  }
  
  if (obj.team_sharing !== undefined && typeof obj.team_sharing !== 'boolean') {
    return false;
  }
  
  if (obj.webauthn !== undefined && typeof obj.webauthn !== 'boolean') {
    return false;
  }
  
  if (obj.hardware_keys !== undefined && typeof obj.hardware_keys !== 'number') {
    return false;
  }
  
  if (obj.recovery_phrase !== undefined && typeof obj.recovery_phrase !== 'boolean') {
    return false;
  }
  
  if (obj.encryption !== undefined && typeof obj.encryption !== 'string') {
    return false;
  }
  
  return true;
}

/**
 * Type guard for PricingPlan
 */
export function isPricingPlan(data: unknown): data is PricingPlan {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  return (
    typeof obj.plan_code === 'string' &&
    typeof obj.display_name === 'string' &&
    typeof obj.description === 'string' &&
    (obj.price_monthly === null || typeof obj.price_monthly === 'number') &&
    (obj.price_six_months === null || typeof obj.price_six_months === 'number') &&
    (obj.price_yearly === null || typeof obj.price_yearly === 'number') &&
    typeof obj.storage_gb === 'number' &&
    (obj.storage_bytes === undefined || typeof obj.storage_bytes === 'number') &&
    typeof obj.bandwidth_mbps === 'number' &&
    (obj.bandwidth_burst_mbps === undefined || typeof obj.bandwidth_burst_mbps === 'number') &&
    typeof obj.max_concurrent_streams === 'number' &&
    isPlanFeatures(obj.features) &&
    (obj.is_active === undefined || typeof obj.is_active === 'boolean') &&
    (obj.is_default === undefined || typeof obj.is_default === 'boolean') &&
    (obj.is_most_popular === undefined || typeof obj.is_most_popular === 'boolean')
  );
}

/**
 * Type guard for CategorizedPlans
 */
export function isCategorizedPlans(data: unknown): data is CategorizedPlans {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  const hasValidArray = (key: string): boolean => {
    const value = obj[key];
    return (
      Array.isArray(value) &&
      value.every((item) => isPricingPlan(item))
    );
  };
  
  return (
    hasValidArray('individual') &&
    hasValidArray('business') &&
    hasValidArray('enterprise')
  );
}

/**
 * Type guard for PlansResponse
 */
export function isPlansResponse(data: unknown): data is PlansResponse {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  return (
    obj.plans !== undefined &&
    isCategorizedPlans(obj.plans)
  );
}

/**
 * Type guard for PlansApiResponse
 */
export function isPlansApiResponse(data: unknown): data is PlansApiResponse {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  // Must have at least one of edge_plans, zk_plans, or plans
  const hasEdgePlans = obj.edge_plans !== undefined && isCategorizedPlans(obj.edge_plans);
  const hasZkPlans = obj.zk_plans !== undefined && isCategorizedPlans(obj.zk_plans);
  const hasPlans = obj.plans !== undefined && isCategorizedPlans(obj.plans);
  
  return hasEdgePlans || hasZkPlans || hasPlans;
}
