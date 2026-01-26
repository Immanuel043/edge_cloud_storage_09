/**
 * Auth Context Router
 *
 * Routes to appropriate auth provider based on ZK mode.
 * - ZK Mode: ZKAuthProvider (client-side encryption, Argon2id)
 * - Normal Mode: NormalAuthProvider (server-side auth, WebSocket)
 */

import React, { useState, useEffect } from 'react';
import { ZK_STORAGE } from '../config/constants';
import { ZKAuthProvider, useZKAuth } from './auth/ZKAuthContext';
import { NormalAuthProvider, useNormalAuth } from './auth/NormalAuthContext';
import type { AuthContextValue, LoginResponse, ZKData } from './auth/types';
import * as zkAuthService from '../services/zkAuthService';
import * as zkEncryptionService from '../services/zkEncryptionService';

// Re-export types for backwards compatibility
export type {
  User,
  LoginResponse,
  ZKData,
  RecoveryPhraseResult,
  RecoveryAccountResponse,
  ZKStatusResponse,
  AuthContextValue,
} from './auth/types';

// Re-export UserProfile type alias for backwards compatibility
export type { UserProfile } from '../services/authService';

/**
 * Hook to access auth context (mode-aware)
 */
export const useAuth = (): AuthContextValue => {
  // Check current mode from localStorage
  const [isZKMode, setIsZKMode] = useState<boolean>(() => {
    return localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
  });

  // Watch for changes to ZK mode (e.g., during login/logout)
  useEffect(() => {
    const checkZKMode = (): void => {
      const zkEnabled = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
      if (zkEnabled !== isZKMode) {
        setIsZKMode(zkEnabled);
      }
    };

    // Check on storage changes (cross-tab)
    window.addEventListener('storage', checkZKMode);

    // Check on custom zk-mode-changed event (same-window, immediate)
    window.addEventListener('zk-mode-changed', checkZKMode);

    // Poll periodically (fallback)
    const interval = setInterval(checkZKMode, 1000);

    return () => {
      window.removeEventListener('storage', checkZKMode);
      window.removeEventListener('zk-mode-changed', checkZKMode);
      clearInterval(interval);
    };
  }, [isZKMode]);

  // Route to appropriate hook based on current mode
  if (isZKMode) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const zkAuth = useZKAuth();

    // Build combined interface (ZK mode)
    const combined: AuthContextValue = {
      user: zkAuth.user,
      isAuthenticated: zkAuth.isAuthenticated,
      loading: zkAuth.loading,
      token: null, // ZK uses HTTP-only cookies, no token

      // ZK state
      zkEnabled: zkAuth.zkEnabled,
      zkSessionUnlocked: zkAuth.zkSessionUnlocked,
      zkRecoveryEnabled: zkAuth.zkRecoveryEnabled,

      // Unified auth methods (delegates to ZK)
      login: zkAuth.loginZK,
      register: zkAuth.registerZK,
      logout: zkAuth.logout,

      // Expose ZK-specific methods explicitly (for mode selection during auth)
      loginZK: zkAuth.loginZK,
      registerZK: zkAuth.registerZK,

      // ZK session methods
      unlockSession: zkAuth.unlockSession,
      lockSession: zkAuth.lockSession,
      setupRecoveryPhrase: zkAuth.setupRecoveryPhrase,
      verifyRecoveryPhrase: zkAuth.verifyRecoveryPhrase,
      recoverAccount: zkAuth.recoverAccount,
      checkZKStatus: zkAuth.checkZKStatus,
      showUnlockModal: zkAuth.showUnlockModal,
      setShowUnlockModal: zkAuth.setShowUnlockModal,
    };

    return combined;
  }

  // Normal mode
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const normalAuth = useNormalAuth();

  /**
   * Standalone ZK login/register functions for use during auth flow
   * (when user chooses ZK mode via toggle before logging in)
   */
  const standaloneLoginZK = async (email: string, password: string): Promise<LoginResponse> => {
    console.log('[Router] Standalone ZK login initiated');

    // Step 1: Get KDF parameters
    const kdfParams = await zkAuthService.getKDFParams(email);
    if (!kdfParams) {
      throw new Error('Failed to get KDF parameters');
    }
    const { kdf_salt, kdf_algorithm, kdf_iterations, kdf_memory, kdf_iv } = kdfParams;

    // Step 2: Derive password hash
    const passwordHash = await zkEncryptionService.getPasswordHashForLogin(
      password,
      kdf_salt,
      kdf_iterations,
      kdf_algorithm as 'argon2id' | 'pbkdf2'
    );

    // Step 3: Login
    const response = await zkAuthService.loginZK(email, passwordHash);

    // Step 4: Store ZK data (this will trigger mode switch)
    // Use master_key_iv from response, or fall back to kdf_iv from params
    const masterKeyIV = response.master_key_iv || kdf_iv || '';
    const zkDataObj: ZKData = {
      kdfSalt: kdf_salt,
      kdfAlgorithm: kdf_algorithm as 'argon2id' | 'pbkdf2',
      kdfIterations: kdf_iterations,
      encryptedMasterKey: response.encrypted_master_key,
      masterKeyIV: masterKeyIV,
      ...(kdf_memory !== undefined && { kdfMemory: kdf_memory }),
    };

    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);
    localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));

    // Step 5: Unlock session immediately (so user doesn't need to unlock after redirect)
    const unlocked = await zkEncryptionService.unlockZKSession(password, zkDataObj);
    if (!unlocked) {
      console.warn('[Router] Session unlock failed, user will need to unlock manually');
    }

    // Dispatch custom event to trigger immediate provider switch
    window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: true } }));

    // Convert LoginZKResponse to LoginResponse
    return {
      access_token: response.access_token,
      user: { id: response.user_id, email, username: '', user_type: '', created_at: '' },
      encrypted_master_key: response.encrypted_master_key,
      kdf_iv: masterKeyIV,
    };
  };

  const standaloneRegisterZK = async (
    email: string,
    password: string,
    username: string,
    _userType?: string,
    _planCode?: string
  ): Promise<LoginResponse> => {
    console.log('[Router] Standalone ZK registration initiated');

    // Step 1: Generate ZK registration data (Argon2id)
    const zkRegData = await zkEncryptionService.generateZKRegistrationData(password);

    // Step 2: Register with ZK service
    // Note: userType and planCode are accepted for API compatibility but not currently
    // used by the ZK registration endpoint (they may be used in future versions)
    const registerData = {
      email,
      username,
      passwordHash: zkRegData.passwordHash,
      encryptedMasterKey: zkRegData.encryptedMasterKey,
      masterKeyIV: zkRegData.masterKeyIV,
      kdfSalt: zkRegData.kdfSalt,
      kdfAlgorithm: zkRegData.kdfAlgorithm,
      kdfIterations: zkRegData.kdfIterations,
      kdfMemory: zkRegData.kdfMemory,
      kdfParallelism: zkRegData.kdfParallelism,
    };

    const response = await zkAuthService.registerZK(registerData);

    // Step 3: Store ZK data (this will trigger mode switch)
    const zkDataObj: ZKData = {
      kdfSalt: zkRegData.kdfSalt,
      kdfAlgorithm: zkRegData.kdfAlgorithm,
      kdfIterations: zkRegData.kdfIterations,
      kdfMemory: zkRegData.kdfMemory,
      encryptedMasterKey: zkRegData.encryptedMasterKey,
      masterKeyIV: zkRegData.masterKeyIV,
    };

    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);
    localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));

    // Step 4: Unlock session immediately (so user doesn't need to unlock after redirect)
    const unlocked = await zkEncryptionService.unlockZKSession(password, zkDataObj);
    if (!unlocked) {
      console.warn('[Router] Session unlock failed after registration');
    }

    // Dispatch custom event to trigger immediate provider switch
    window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: true } }));

    return response;
  };

  // Build combined interface (Normal mode)
  const combined: AuthContextValue = {
    user: normalAuth.user,
    isAuthenticated: normalAuth.isAuthenticated,
    loading: normalAuth.loading,
    token: normalAuth.token,

    // ZK state (all false in normal mode)
    zkEnabled: false,
    zkSessionUnlocked: false,
    zkRecoveryEnabled: false,

    // Unified auth methods (delegates to Normal)
    login: normalAuth.login,
    register: normalAuth.register,
    logout: normalAuth.logout,

    // Expose ZK methods for mode selection during auth
    loginZK: standaloneLoginZK,
    registerZK: standaloneRegisterZK,

    // Normal-specific methods
    refreshSessionToken: normalAuth.refreshSessionToken,
  };

  return combined;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * Auth Provider Router
 *
 * Automatically selects ZK or Normal provider based on localStorage.
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  // Determine initial mode from localStorage
  const [isZKMode, setIsZKMode] = useState<boolean>(() => {
    return localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
  });

  // Watch for changes to ZK mode
  useEffect(() => {
    const checkZKMode = (): void => {
      const zkEnabled = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
      if (zkEnabled !== isZKMode) {
        console.log('[AuthRouter] Mode changed, switching provider...');
        setIsZKMode(zkEnabled);
      }
    };

    // Listen for storage changes (cross-tab)
    window.addEventListener('storage', checkZKMode);

    // Listen for custom zk-mode-changed event (same-window, immediate)
    window.addEventListener('zk-mode-changed', checkZKMode);

    // Poll for same-window changes (fallback)
    const interval = setInterval(checkZKMode, 1000);

    return () => {
      window.removeEventListener('storage', checkZKMode);
      window.removeEventListener('zk-mode-changed', checkZKMode);
      clearInterval(interval);
    };
  }, [isZKMode]);

  // ZK Mode: Use ZK Auth Provider
  if (isZKMode) {
    console.log('[AuthRouter] Using ZK Auth Provider');
    return <ZKAuthProvider>{children}</ZKAuthProvider>;
  }

  // Normal Mode: Use Normal Auth Provider
  console.log('[AuthRouter] Using Normal Auth Provider');
  return <NormalAuthProvider>{children}</NormalAuthProvider>;
};

export default {
  AuthProvider,
  useAuth,
};
