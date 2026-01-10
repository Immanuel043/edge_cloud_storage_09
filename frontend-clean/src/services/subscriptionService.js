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

import API_CONFIG from '../config/api.js';

class SubscriptionService {
  constructor() {
    // Default to normal service
    this.serviceType = 'normal';
    this.baseUrl = API_CONFIG.STORAGE_API;
  }

  /**
   * Set the service type dynamically based on user's authentication
   * @param {string} serviceType - 'normal' or 'zk'
   */
  setServiceType(serviceType) {
    this.serviceType = serviceType;
    this.baseUrl = serviceType === 'zk'
      ? API_CONFIG.ZK_API
      : API_CONFIG.STORAGE_API;
  }

  /**
   * Get the current service type
   */
  getServiceType() {
    return this.serviceType;
  }

  /**
   * Get complete subscription dashboard data
   * Returns: current subscription, available plans, warnings, recommendations
   */
  async getDashboard() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/subscription-ui/dashboard`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
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
  async getUsageSummary() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/subscription-ui/usage/summary`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
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
  async getAvailablePaymentGateways() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/payment-gateways`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to fetch payment gateways');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching payment gateways:', error);
      throw error;
    }
  }

  /**
   * Create a payment for subscription upgrade
   * @param {string} planCode - The plan code to upgrade to
   * @param {string} billingCycle - 'monthly', 'six_months', or 'yearly'
   * @param {string} paymentGateway - 'razorpay' or 'stripe'
   */
  async createPayment(planCode, billingCycle, paymentGateway) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/create-payment`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan_code: planCode,
          billing_cycle: billingCycle,
          payment_gateway: paymentGateway,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to create payment');
      }

      const data = await response.json();
      
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
   * @param {string} paymentId - Payment ID from gateway
   * @param {string} orderId - Order ID (for Razorpay)
   * @param {string} signature - Payment signature (for Razorpay)
   */
  async verifyPayment(paymentId, orderId = null, signature = null) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/verify-payment`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payment_id: paymentId,
          order_id: orderId,
          signature: signature,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
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
   * @param {string} planCode - The plan code to upgrade to (e.g., 'normal_pro')
   */
  async upgrade(planCode) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/upgrade`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ new_plan_code: planCode }),
      });

      if (!response.ok) {
        const error = await response.json();
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
   * @param {string} planCode - The plan code to downgrade to (e.g., 'normal_free')
   */
  async downgrade(planCode) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/downgrade`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ new_plan_code: planCode }),
      });

      if (!response.ok) {
        const error = await response.json();
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
   * @param {string} planCode - The plan code to preview
   */
  async previewChange(planCode) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/preview-change`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ new_plan_code: planCode }),
      });

      if (!response.ok) {
        const error = await response.json();
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
   * @param {string} planCode - The plan code to upgrade to
   * @param {string} billingCycle - 'monthly' or 'yearly'
   */
  async createCheckoutSession(planCode, billingCycle = 'monthly') {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/create-checkout-session`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan_code: planCode,
          billing_cycle: billingCycle
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to create checkout session');
      }

      const data = await response.json();

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
  async cancelSubscription() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
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
  async getCurrentSubscription() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/subscription`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
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
  async getAvailablePlans() {
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
        const error = await response.json();
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
   * @param {string[]} planCodes - Array of plan codes to compare
   */
  async comparePlans(planCodes) {
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
        const error = await response.json();
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
  async getSubscriptionHistory() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/history`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
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
  async getRecommendations() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/billing/recommendations`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to fetch recommendations');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching recommendations:', error);
      throw error;
    }
  }
}

// Export singleton instance
export default new SubscriptionService();
