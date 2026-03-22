import { API_URL } from '../config/constants';
import { sanitizeInput } from '../utils/security';
import { rateLimiter } from '../utils/rateLimiter';

/**
 * Authentication API response types
 */
export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: UserProfile;
  pending_upgrade?: {
    plan_code: string;
    billing_cycle: string | null;
  };
}

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  user_type: string;
  plan_type: string;
  storage_quota: number;
  storage_used: number;
  created_at: string;
  theme?: string;
  zk_enabled?: boolean;
}

export interface RegisterInitResponse {
  message: string;
  email: string;
}

export interface RegisterVerifyResponse {
  message: string;
  verification_token: string;
}

export interface ZKData {
  encryptedMasterKey: string;
  masterKeyIV: string;
  kdfSalt: string;
  kdfAlgorithm: string;
  kdfIterations: number;
  kdfMemory?: number;
  kdfParallelism?: number;
  recoveryEncryptedMasterKey?: string;
  recoveryPhraseHash?: string;
}

export interface OAuthProvider {
  name: string;
  display_name: string;
  enabled: boolean;
}

export interface LinkedAccount {
  provider: string;
  provider_user_id: string;
  linked_at: string;
}

export interface SessionTokenResponse {
  access_token: string;
  expires_at?: string;
}

export interface ErrorResponse {
  detail: string | { msg: string; type: string }[];
  message?: string;
}

function extractErrorMessage(error: ErrorResponse, fallback: string): string {
  if (!error.detail) return error.message ?? fallback;
  if (typeof error.detail === 'string') return error.detail;
  if (Array.isArray(error.detail)) return error.detail.map(e => e.msg).join(', ');
  if (typeof error.detail === 'object') {
    const d = error.detail as Record<string, unknown>;
    return (d.message as string) ?? (d.error as string) ?? fallback;
  }
  return fallback;
}

class AuthService {
  async login(email: string, password: string): Promise<AuthResponse> {
    await rateLimiter.checkLimit();

    const formData = new FormData();
    formData.append('email', sanitizeInput(email) as string);
    formData.append('password', password);
    formData.append('timestamp', Date.now().toString());

    // SECURITY FIX: Include credentials to receive HTTP-only cookie
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        body: formData,
        credentials: 'include', // Important for cookie-based auth
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error('Invalid credentials');
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async register(
    email: string,
    password: string,
    username: string,
    userType: string,
    planCode: string | null = null
  ): Promise<AuthResponse> {
    await rateLimiter.checkLimit();

    const formData = new FormData();
    formData.append('email', sanitizeInput(email) as string);
    formData.append('password', password);
    formData.append('username', sanitizeInput(username) as string);
    formData.append('user_type', userType);
    formData.append('timestamp', Date.now().toString());

    // Add plan_type if planCode provided (extract from plan_code)
    if (planCode) {
      // Extract plan_type from plan_code (e.g., "normal_basic" -> "basic")
      const planType = planCode.split('_')[1] ?? 'free';
      formData.append('plan_type', planType);
    }

    // SECURITY FIX: Include credentials to receive HTTP-only cookie
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/register`, {
        method: 'POST',
        body: formData,
        credentials: 'include', // Important for cookie-based auth
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error('Registration failed');
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getProfile(): Promise<UserProfile> {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Use cookies instead of Authorization header
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API_URL}/api/v1/users/profile`, {
        credentials: 'include', // Send HTTP-only cookie
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to load profile');
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Version with AbortSignal support for timeout handling
  async getProfileWithSignal(signal: AbortSignal): Promise<UserProfile> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/users/profile`, {
      credentials: 'include',
      signal, // Pass abort signal for timeout support
    });

    if (!response.ok) {
      throw new Error(`Failed to load profile: ${response.status}`);
    }

    return await response.json();
  }

  async logout(): Promise<boolean> {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Call logout endpoint to clear HTTP-only cookie
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        console.error('Logout request failed');
      }

      return response.ok;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async updateTheme(theme: string): Promise<UserProfile> {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Use cookies instead of Authorization header
    const response = await fetch(`${API_URL}/api/v1/users/theme`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // Send HTTP-only cookie
      body: JSON.stringify({ theme }),
    });

    if (!response.ok) {
      throw new Error('Failed to update theme');
    }

    return await response.json();
  }

  async getSessionToken(): Promise<SessionTokenResponse> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/auth/session-token`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to refresh session token');
    }

    return await response.json();
  }

  // ==================== Email Verification Registration Flow ====================

  /**
   * Step 1: Initialize registration - send verification code
   */
  async registerInit(email: string): Promise<RegisterInitResponse> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/auth/register/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: sanitizeInput(email) }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Failed to send verification code'));
    }

    return await response.json();
  }

  /**
   * Step 2: Verify email code
   */
  async registerVerify(email: string, code: string): Promise<RegisterVerifyResponse> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/auth/register/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email: sanitizeInput(email),
        verification_code: code,
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Invalid verification code'));
    }

    return await response.json();
  }

  /**
   * Step 3: Complete registration with username and password
   */
  async registerComplete(
    email: string,
    username: string,
    password: string,
    verificationToken: string,
    planCode = 'normal_free',
    billingCycle: 'monthly' | 'six_months' | 'yearly' = 'monthly'
  ): Promise<AuthResponse> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/auth/register/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email: sanitizeInput(email),
        username: sanitizeInput(username),
        password,
        verification_token: verificationToken,
        plan_code: planCode,
        billing_cycle: billingCycle,
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Registration failed'));
    }

    return await response.json();
  }

  /**
   * Resend verification code
   */
  async resendVerificationCode(email: string): Promise<RegisterInitResponse> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/auth/register/resend-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: sanitizeInput(email) }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Failed to resend code'));
    }

    return await response.json();
  }

  // ==================== ZK Email Verification Flow ====================

  /**
   * Step 1: Initialize ZK registration - send verification code
   */
  async registerZKInit(email: string): Promise<RegisterInitResponse> {
    await rateLimiter.checkLimit();

    const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
    const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: sanitizeInput(email) }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Failed to send verification code'));
    }

    return await response.json();
  }

  /**
   * Step 2: Verify ZK email code
   */
  async registerZKVerify(email: string, code: string): Promise<RegisterVerifyResponse> {
    await rateLimiter.checkLimit();

    const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
    const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email: sanitizeInput(email),
        verification_code: code,
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Invalid verification code'));
    }

    return await response.json();
  }

  /**
   * Step 3: Complete ZK registration
   */
  async registerZKComplete(
    email: string,
    username: string,
    passwordHash: string,
    zkData: ZKData,
    verificationToken: string,
    planCode = 'zk_pro',
    billingCycle: 'monthly' | 'six_months' | 'yearly' = 'monthly'
  ): Promise<AuthResponse> {
    await rateLimiter.checkLimit();

    const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
    const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email: sanitizeInput(email),
        username: sanitizeInput(username),
        password_hash: passwordHash,
        encrypted_master_key: zkData.encryptedMasterKey,
        master_key_iv: zkData.masterKeyIV,
        kdf_salt: zkData.kdfSalt,
        kdf_algorithm: zkData.kdfAlgorithm,
        kdf_iterations: zkData.kdfIterations,
        kdf_memory: zkData.kdfMemory,
        kdf_parallelism: zkData.kdfParallelism,
        verification_token: verificationToken,
        plan_code: planCode,
        billing_cycle: billingCycle,
        recovery_encrypted_master_key: zkData.recoveryEncryptedMasterKey,
        recovery_phrase_hash: zkData.recoveryPhraseHash,
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Registration failed'));
    }

    return await response.json();
  }

  /**
   * Resend ZK verification code
   */
  async resendZKVerificationCode(email: string): Promise<RegisterInitResponse> {
    await rateLimiter.checkLimit();

    const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
    const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/resend-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: sanitizeInput(email) }),
    });

    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      throw new Error(extractErrorMessage(error, 'Failed to resend code'));
    }

    return await response.json();
  }

  // ==================== OAuth Methods ====================

  /**
   * Get list of available OAuth providers
   */
  async getOAuthProviders(): Promise<OAuthProvider[]> {
    const response = await fetch(`${API_URL}/api/v1/auth/oauth/providers`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get OAuth providers');
    }

    return await response.json();
  }

  /**
   * Initiate OAuth login flow
   * Redirects user to the OAuth provider's login page
   * @param provider - 'google', 'microsoft', or 'github'
   */
  initiateOAuthLogin(provider: string): void {
    // Redirect to OAuth login endpoint - backend handles the OAuth flow
    window.location.href = `${API_URL}/api/v1/auth/oauth/${provider}/login`;
  }

  /**
   * Get user's linked OAuth accounts
   */
  async getLinkedAccounts(): Promise<LinkedAccount[]> {
    const response = await fetch(`${API_URL}/api/v1/auth/linked-accounts`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get linked accounts');
    }

    return await response.json();
  }

  /**
   * Link OAuth provider to existing account
   */
  linkOAuthAccount(provider: string): void {
    window.location.href = `${API_URL}/api/v1/auth/oauth/${provider}/link`;
  }

  /**
   * Unlink OAuth provider from account
   */
  async unlinkOAuthAccount(provider: string): Promise<{ message: string }> {
    const response = await fetch(`${API_URL}/api/v1/auth/oauth/${provider}/unlink`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to unlink OAuth account');
    }

    return await response.json();
  }
}

export const authService = new AuthService();
