/**
 * Subscription Service
 *
 * Handles all subscription-related API calls including:
 * - Fetching subscription dashboard data
 * - Getting usage summaries
 * - Upgrading/downgrading plans
 * - Creating Stripe checkout sessions
 * - Fetching plan comparisons
 */

import API_CONFIG from '../config/api';

// ==================== Type Definitions ====================

type ServiceType = 'normal' | 'zk';

type BillingCycle = 'monthly' | 'six_months' | 'yearly';

type PaymentGateway = 'razorpay' | 'stripe';

export interface SubscriptionDashboard {
  current_subscription: Subscription;
  available_plans: Plan[];
  usage?: Record<string, unknown> | null;
  warnings?: Warning[];
  recommendations?: Recommendation[];
}

export interface Subscription {
  id: string;
  user_id: string;
  plan_code: string;
  billing_cycle: BillingCycle;
  status: 'active' | 'cancelled' | 'expired' | 'past_due';
  started_at: string;
  expires_at?: string;
  stripe_subscription_id?: string;
}

interface Plan {
  plan_code: string;
  display_name: string;
  storage_gb: number;
  bandwidth_mbps: number;
  price_monthly: number;
  price_six_months?: number;
  price_yearly?: number;
  features: Record<string, boolean>;
  service_type: ServiceType;
}

interface Warning {
  type: 'quota' | 'expiration' | 'payment';
  message: string;
  severity: 'low' | 'medium' | 'high';
}

interface Recommendation {
  plan_code: string;
  reason: string;
  savings?: number;
}

export interface UsageSummary {
  storage_used: number;
  storage_quota: number;
  storage_percentage: number;
  bandwidth_used: number;
  bandwidth_quota: number;
  bandwidth_percentage: number;
  files_count: number;
  files_quota?: number;
}

interface PaymentGatewayInfo {
  gateway: PaymentGateway;
  enabled: boolean;
  display_name: string;
}

interface CreatePaymentRequest {
  plan_code: string;
  billing_cycle: BillingCycle;
  payment_gateway: PaymentGateway;
}

interface CreatePaymentResponse {
  payment_url?: string;
  gateway_data?: Record<string, unknown>;
  free_plan?: boolean;
  order_id?: string;
  payment_id?: string;
}

interface VerifyPaymentRequest {
  payment_id: string;
  order_id: string | null;
  signature: string | null;
}

interface VerifyPaymentResponse {
  success: boolean;
  subscription: Subscription;
}

interface UpgradeRequest {
  new_plan_code: string;
}

interface UpgradeResponse {
  success: boolean;
  subscription: Subscription;
  message?: string;
}

interface DowngradeRequest {
  new_plan_code: string;
}

interface DowngradeResponse {
  success: boolean;
  subscription: Subscription;
  effective_date?: string;
  message?: string;
}

interface PreviewChangeRequest {
  new_plan_code: string;
}

export interface PreviewChangeResponse {
  current_plan: Plan;
  new_plan: Plan;
  storage_impact: {
    current: number;
    new: number;
    will_exceed: boolean;
  };
  bandwidth_impact: {
    current: number;
    new: number;
    will_exceed: boolean;
  };
  price_difference: number;
  is_upgrade: boolean;
}

interface CreateCheckoutSessionRequest {
  plan_code: string;
  billing_cycle: BillingCycle;
}

interface CreateCheckoutSessionResponse {
  checkout_url: string;
  session_id: string;
}

export interface SubscriptionHistoryEntry {
  id: string;
  plan_code?: string;
  started_at?: string;
  created_at?: string;
  ended_at?: string;
  amount_paid?: number;
  billing_cycle?: BillingCycle;
  event_type?: string;
  from_plan_code?: string;
  to_plan_code?: string;
  reason?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface UpcomingPayment {
  amount_due: number;
  currency: string;
  payment_due_date: string;
  plan_code: string;
  plan_name: string;
  billing_cycle: BillingCycle;
  days_until_payment: number;
  payment_gateway?: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  plan_code: string;
  plan_name: string;
  billing_cycle?: BillingCycle;
  amount: number;
  currency: string;
  status: string;
  payment_gateway?: string;
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  paid_at?: string;
  created_at: string;
}

export interface InvoiceListResponse {
  invoices: Invoice[];
  total: number;
}

export interface BillingPortalSession {
  url: string;
}

interface ErrorResponse {
  detail?: string;
}

// ==================== Subscription Service Class ====================

class SubscriptionService {
  private serviceType: ServiceType;
  private baseUrl: string;

  constructor() {
    // Default to normal service
    this.serviceType = 'normal';
    this.baseUrl = API_CONFIG.STORAGE_API;
  }

  /**
   * Set the service type dynamically based on user's authentication
   * @param serviceType - 'normal' or 'zk'
   */
  setServiceType(serviceType: ServiceType): void {
    this.serviceType = serviceType;
    this.baseUrl = serviceType === 'zk' ? API_CONFIG.ZK_API : API_CONFIG.STORAGE_API;
  }

  /**
   * Get the current service type
   */
  getServiceType(): ServiceType {
    return this.serviceType;
  }

  /**
   * Get complete subscription dashboard data
   * Returns: current subscription, available plans, warnings, recommendations
   */
  async getDashboard(): Promise<SubscriptionDashboard> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/subscription-ui/dashboard`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch dashboard');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching subscription dashboard:', error);
      throw error;
    }
  }

  /**
   * Get usage summary optimized for progress bars and charts
   */
  async getUsageSummary(): Promise<UsageSummary> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/subscription-ui/usage/summary`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch usage summary');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching usage summary:', error);
      throw error;
    }
  }

  /**
   * Get available payment gateways
   */
  async getAvailablePaymentGateways(): Promise<PaymentGatewayInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/payment-gateways`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch payment gateways');
      }

      const data = await response.json();
      // Backend returns { gateways: [...] }, extract the array
      return data.gateways || data;
    } catch (error) {
      console.error('Error fetching payment gateways:', error);
      throw error;
    }
  }

  /**
   * Create a payment for subscription upgrade
   * @param planCode - The plan code to upgrade to
   * @param billingCycle - 'monthly', 'six_months', or 'yearly'
   * @param paymentGateway - 'razorpay' or 'stripe'
   */
  async createPayment(
    planCode: string,
    billingCycle: BillingCycle,
    paymentGateway: PaymentGateway
  ): Promise<CreatePaymentResponse> {
    try {
      const requestBody: CreatePaymentRequest = {
        plan_code: planCode,
        billing_cycle: billingCycle,
        payment_gateway: paymentGateway,
      };

      const response = await fetch(`${this.baseUrl}/api/v1/billing/create-payment`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to create payment');
      }

      const data = (await response.json()) as CreatePaymentResponse;

      // If free plan, return immediately
      if (data.free_plan) {
        return data;
      }

      // For paid plans, redirect to payment URL
      if (data.payment_url) {
        window.location.href = data.payment_url;
      } else if (paymentGateway === 'razorpay' && data.gateway_data) {
        // Razorpay requires frontend integration
        // Return gateway data for frontend to handle
        return data;
      }

      return data;
    } catch (error) {
      console.error('Error creating payment:', error);
      throw error;
    }
  }

  /**
   * Verify a payment after completion
   * @param paymentId - Payment ID from gateway
   * @param orderId - Order ID (for Razorpay)
   * @param signature - Payment signature (for Razorpay)
   */
  async verifyPayment(
    paymentId: string,
    orderId: string | null = null,
    signature: string | null = null
  ): Promise<VerifyPaymentResponse> {
    try {
      const requestBody: VerifyPaymentRequest = {
        payment_id: paymentId,
        order_id: orderId,
        signature: signature,
      };

      const response = await fetch(`${this.baseUrl}/api/v1/billing/verify-payment`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Payment verification failed');
      }

      return await response.json();
    } catch (error) {
      console.error('Error verifying payment:', error);
      throw error;
    }
  }

  /**
   * Upgrade to a higher tier plan
   * @param planCode - The plan code to upgrade to (e.g., 'normal_pro')
   */
  async upgrade(planCode: string): Promise<UpgradeResponse> {
    try {
      const requestBody: UpgradeRequest = { new_plan_code: planCode };

      const response = await fetch(`${this.baseUrl}/api/v1/billing/upgrade`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Upgrade failed');
      }

      return await response.json();
    } catch (error) {
      console.error('Error upgrading plan:', error);
      throw error;
    }
  }

  /**
   * Downgrade to a lower tier plan
   * @param planCode - The plan code to downgrade to (e.g., 'normal_free')
   */
  async downgrade(planCode: string): Promise<DowngradeResponse> {
    try {
      const requestBody: DowngradeRequest = { new_plan_code: planCode };

      const response = await fetch(`${this.baseUrl}/api/v1/billing/downgrade`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Downgrade failed');
      }

      return await response.json();
    } catch (error) {
      console.error('Error downgrading plan:', error);
      throw error;
    }
  }

  /**
   * Preview what will change if user switches to a new plan
   * @param planCode - The plan code to preview
   */
  async previewChange(planCode: string): Promise<PreviewChangeResponse> {
    try {
      const requestBody: PreviewChangeRequest = { new_plan_code: planCode };

      const response = await fetch(`${this.baseUrl}/api/v1/billing/preview-change`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to preview change');
      }

      return await response.json();
    } catch (error) {
      console.error('Error previewing plan change:', error);
      throw error;
    }
  }

  /**
   * Create a Stripe Checkout session for upgrading to a paid plan
   * @param planCode - The plan code to upgrade to
   * @param billingCycle - 'monthly' or 'yearly'
   */
  async createCheckoutSession(
    planCode: string,
    billingCycle: BillingCycle = 'monthly'
  ): Promise<CreateCheckoutSessionResponse> {
    try {
      const requestBody: CreateCheckoutSessionRequest = {
        plan_code: planCode,
        billing_cycle: billingCycle,
      };

      const response = await fetch(`${this.baseUrl}/api/v1/billing/create-checkout-session`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to create checkout session');
      }

      const data = (await response.json()) as CreateCheckoutSessionResponse;

      // Redirect to Stripe Checkout
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }

      return data;
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw error;
    }
  }

  /**
   * Cancel current subscription
   */
  async cancelSubscription(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to cancel subscription');
      }

      return await response.json();
    } catch (error) {
      console.error('Error canceling subscription:', error);
      throw error;
    }
  }

  /**
   * Get current user's subscription
   */
  async getCurrentSubscription(): Promise<Subscription> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/subscription`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch subscription');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching current subscription:', error);
      throw error;
    }
  }

  /**
   * Get all available plans for the current service type
   */
  async getAvailablePlans(): Promise<Plan[]> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/billing/plans?service_type=${this.serviceType}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch plans');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching available plans:', error);
      throw error;
    }
  }

  /**
   * Compare multiple plans side-by-side
   * @param planCodes - Array of plan codes to compare
   */
  async comparePlans(planCodes: string[]): Promise<Plan[]> {
    try {
      const codesParam = planCodes.join(',');
      const response = await fetch(
        `${this.baseUrl}/api/v1/subscription-ui/plans/compare?plan_codes=${codesParam}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to compare plans');
      }

      return await response.json();
    } catch (error) {
      console.error('Error comparing plans:', error);
      throw error;
    }
  }

  /**
   * Get subscription history for the current user
   */
  async getSubscriptionHistory(): Promise<SubscriptionHistoryEntry[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/history`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch subscription history');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching subscription history:', error);
      throw error;
    }
  }

  /**
   * Get upgrade recommendations based on current usage
   */
  async getRecommendations(): Promise<Recommendation[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/recommendations`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch recommendations');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching recommendations:', error);
      throw error;
    }
  }

  /**
   * Get upcoming payment information
   */
  async getUpcomingPayment(): Promise<UpcomingPayment | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/upcoming-payment`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) return null;
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch upcoming payment');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching upcoming payment:', error);
      throw error;
    }
  }

  /**
   * Get invoices for the current user
   */
  async getInvoices(): Promise<InvoiceListResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/invoices`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        if (response.status === 404) return { invoices: [], total: 0 };
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to fetch invoices');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching invoices:', error);
      throw error;
    }
  }

  /**
   * Download an invoice PDF
   */
  async downloadInvoice(invoiceId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/billing/invoices/${invoiceId}/download`,
        {
          method: 'GET',
          credentials: 'include',
        },
      );

      if (!response.ok) {
        throw new Error('Failed to download invoice');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const filename = filenameMatch ? filenameMatch[1] : `invoice-${invoiceId}.pdf`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (error) {
      console.error('Error downloading invoice:', error);
      throw error;
    }
  }

  /**
   * Create a Stripe billing portal session for managing payment methods and invoices
   */
  async createBillingPortalSession(): Promise<BillingPortalSession> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/portal`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.detail || 'Failed to create billing portal session');
      }

      return await response.json();
    } catch (error) {
      console.error('Error creating billing portal session:', error);
      throw error;
    }
  }
}

// Export singleton instance
export default new SubscriptionService();
