import { API_URL } from '../config/constants';
import { sanitizeInput } from '../utils/security';
import { rateLimiter } from '../utils/rateLimiter';

class AuthService {
  async login(email, password) {
    await rateLimiter.checkLimit();

    const formData = new FormData();
    formData.append('email', sanitizeInput(email));
    formData.append('password', password);
    formData.append('timestamp', Date.now());

    // SECURITY FIX: Include credentials to receive HTTP-only cookie
    const response = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: 'POST',
      body: formData,
      credentials: 'include'  // Important for cookie-based auth
    });

    if (!response.ok) {
      throw new Error('Invalid credentials');
    }

    return await response.json();
  }

  async register(email, password, username, userType, planCode = null) {
    await rateLimiter.checkLimit();

    const formData = new FormData();
    formData.append('email', sanitizeInput(email));
    formData.append('password', password);
    formData.append('username', sanitizeInput(username));
    formData.append('user_type', userType);
    formData.append('timestamp', Date.now());

    // Add plan_type if planCode provided (extract from plan_code)
    if (planCode) {
      // Extract plan_type from plan_code (e.g., "normal_basic" -> "basic")
      const planType = planCode.split('_')[1] || 'free';
      formData.append('plan_type', planType);
    }

    // SECURITY FIX: Include credentials to receive HTTP-only cookie
    const response = await fetch(`${API_URL}/api/v1/auth/register`, {
      method: 'POST',
      body: formData,
      credentials: 'include'  // Important for cookie-based auth
    });

    if (!response.ok) {
      throw new Error('Registration failed');
    }

    return await response.json();
  }

  async getProfile(token) {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Use cookies instead of Authorization header
    const response = await fetch(`${API_URL}/api/v1/users/profile`, {
      credentials: 'include'  // Send HTTP-only cookie
    });

    if (!response.ok) {
      throw new Error('Failed to load profile');
    }

    return await response.json();
  }

  // Version with AbortSignal support for timeout handling
  async getProfileWithSignal(token, signal) {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/users/profile`, {
      credentials: 'include',
      signal  // Pass abort signal for timeout support
    });

    if (!response.ok) {
      throw new Error(`Failed to load profile: ${response.status}`);
    }

    return await response.json();
  }

  async logout() {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Call logout endpoint to clear HTTP-only cookie
    const response = await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      console.error('Logout request failed');
    }

    return response.ok;
  }

  async updateTheme(token, theme) {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Use cookies instead of Authorization header
    const response = await fetch(`${API_URL}/api/v1/users/theme`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',  // Send HTTP-only cookie
      body: JSON.stringify({ theme })
    });

    if (!response.ok) {
      throw new Error('Failed to update theme');
    }

    return await response.json();
  }

  async getSessionToken() {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/auth/session-token`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error('Failed to refresh session token');
    }

    return await response.json();
  }

  // ==================== OAuth Methods ====================

  /**
   * Get list of available OAuth providers
   * @returns {Promise<Array>} List of configured providers
   */
  async getOAuthProviders() {
    const response = await fetch(`${API_URL}/api/v1/auth/oauth/providers`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error('Failed to get OAuth providers');
    }

    return await response.json();
  }

  /**
   * Initiate OAuth login flow
   * Redirects user to the OAuth provider's login page
   * @param {string} provider - 'google', 'microsoft', or 'github'
   */
  initiateOAuthLogin(provider) {
    // Redirect to OAuth login endpoint - backend handles the OAuth flow
    window.location.href = `${API_URL}/api/v1/auth/oauth/${provider}/login`;
  }

  /**
   * Get user's linked OAuth accounts
   * @returns {Promise<Array>} List of linked OAuth accounts
   */
  async getLinkedAccounts() {
    const response = await fetch(`${API_URL}/api/v1/auth/linked-accounts`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error('Failed to get linked accounts');
    }

    return await response.json();
  }

  /**
   * Link OAuth provider to existing account
   * @param {string} provider - OAuth provider name
   */
  linkOAuthAccount(provider) {
    window.location.href = `${API_URL}/api/v1/auth/oauth/${provider}/link`;
  }

  /**
   * Unlink OAuth provider from account
   * @param {string} provider - OAuth provider name
   * @returns {Promise<Object>} Result of unlink operation
   */
  async unlinkOAuthAccount(provider) {
    const response = await fetch(`${API_URL}/api/v1/auth/oauth/${provider}/unlink`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error('Failed to unlink OAuth account');
    }

    return await response.json();
  }
}

export const authService = new AuthService();
