/**
 * ZK Auth Context - Zero-Knowledge Mode
 *
 * Pure ZK authentication with client-side encryption.
 * - Argon2id key derivation
 * - Session unlock/lock with inactivity timeout
 * - Recovery phrase management
 * - Rate limiting for unlock attempts
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import * as zkAuthService from '../../services/zkAuthService';
import * as zkEncryptionService from '../../services/zkEncryptionService';
import { ZK_STORAGE } from '../../config/constants';
import type {
  User,
  LoginResponse,
  ZKData,
  RecoveryPhraseResult,
  RecoveryAccountResponse,
  ZKStatusResponse,
  ZKAuthContextValue,
} from './types';

const ZKAuthContext = createContext<ZKAuthContextValue | undefined>(undefined);

export const useZKAuth = (): ZKAuthContextValue => {
  const context = useContext(ZKAuthContext);
  if (!context) {
    throw new Error('useZKAuth must be used within ZKAuthProvider');
  }
  return context;
};

interface ZKAuthProviderProps {
  children: React.ReactNode;
}

export const ZKAuthProvider: React.FC<ZKAuthProviderProps> = ({ children }) => {
  // User state
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  // ZK-specific state
  const [zkEnabled, setZkEnabled] = useState<boolean>(false);
  const [zkSessionUnlocked, setZkSessionUnlocked] = useState<boolean>(false);
  const [zkRecoveryEnabled, setZkRecoveryEnabled] = useState<boolean>(false);
  const [zkData, setZkData] = useState<ZKData | null>(null);

  // Session management
  const [showUnlockModal, setShowUnlockModal] = useState<boolean>(false);
  const lastActivityRef = useRef<number>(Date.now());
  const inactivityTimerRef = useRef<number | null>(null);

  // Rate limiting for unlock attempts
  const [unlockAttempts, setUnlockAttempts] = useState<number>(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);

  // Constants
  const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  const MAX_UNLOCK_ATTEMPTS = 5;
  const LOCKOUT_DURATION = 60 * 1000; // 60 seconds

  // ==================== BOOTSTRAP ====================

  useEffect(() => {
    // Use a local cancelled flag instead of a shared ref.
    // React StrictMode double-invokes effects: mount → cleanup → mount.
    // A shared ref (useRef) gets set to false during cleanup and never resets,
    // causing the second invocation to bail out and never set loading=false.
    // A local variable gives each invocation its own independent flag.
    let cancelled = false;

    const initializeZKAuth = async (): Promise<void> => {
      try {
        console.log('[ZK] Starting ZK bootstrap...');

        // Check if user is ZK-enabled
        const isZKUser = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';

        if (!isZKUser) {
          if (!cancelled) setLoading(false);
          return;
        }

        if (!cancelled) setZkEnabled(true);

        // Load ZK data from localStorage
        const storedZkData = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
        if (storedZkData) {
          try {
            const parsedZkData = JSON.parse(storedZkData) as ZKData;
            if (!cancelled) setZkData(parsedZkData);
          } catch (error) {
            console.error('[ZK] Failed to parse stored ZK data:', error);
          }
        }

        // Check recovery status
        const recoveryEnabled = localStorage.getItem(ZK_STORAGE.RECOVERY_ENABLED_KEY) === 'true';
        if (!cancelled) setZkRecoveryEnabled(recoveryEnabled);

        // Fast-path for fresh login/registration (avoids async getProfile race conditions)
        // After login or registration, a sessionStorage hint is stored with user metadata.
        // This skips the async getProfile() call entirely — all state updates are
        // synchronous, so the cancelled flag can't change during the operation.
        const authHint = sessionStorage.getItem('zkAuthComplete');
        if (authHint) {
          sessionStorage.removeItem('zkAuthComplete');
          try {
            const hintData = JSON.parse(authHint) as { userId: string; email: string; username: string; ts: number };
            // TTL: ignore hints older than 2 minutes
            if (Date.now() - hintData.ts <= 2 * 60 * 1000) {
              console.log('[ZK] Fresh auth detected, using fast-path bootstrap');
              const user: User = {
                id: hintData.userId,
                email: hintData.email,
                username: hintData.username,
                user_type: 'individual',
                created_at: new Date().toISOString(),
                zk_enabled: true,
              };
              if (!cancelled) {
                setUser(user);
                setIsAuthenticated(true);
                setZkSessionUnlocked(true);
                setLoading(false);
              }
              return;
            }
            console.log('[ZK] Auth hint expired, falling back to getProfile');
          } catch (e) {
            console.warn('[ZK] Failed to parse auth hint, falling back to getProfile');
          }
        }

        // Try to get user profile from ZK service (uses HTTP-only cookie set by ZK login)
        // Use retry logic to handle race conditions after fresh login
        let retryCount = 0;
        const maxRetries = 1; // Bootstrap verification validates sessions before mount
        let profileLoaded = false;

        while (retryCount < maxRetries && !profileLoaded) {
          // Bail out early if effect was cleaned up
          if (cancelled) return;

          try {
            // Add small delay for retries (except first attempt)
            if (retryCount > 0) {
              await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
            }

            // Check again after await
            if (cancelled) return;

            // Use ZK service profile endpoint (port 8002)
            const userProfile = await zkAuthService.getProfile();

            if (cancelled) return;

            const user: User = {
              id: userProfile.id,
              email: userProfile.email,
              username: userProfile.username,
              user_type: 'individual', // ZK service doesn't have user_type, default to individual
              created_at: userProfile.created_at,
              zk_enabled: userProfile.zk_enabled,
            };
            setUser(user);
            setIsAuthenticated(true);

            // Check if session is unlocked
            const sessionUnlocked = zkEncryptionService.isZKSessionUnlocked();
            setZkSessionUnlocked(sessionUnlocked);

            // Show unlock modal if session is locked
            if (!sessionUnlocked) {
              setShowUnlockModal(true);
            }

            profileLoaded = true;
          } catch (error) {
            retryCount++;
            if (retryCount >= maxRetries) {
              console.error('[ZK] Failed to load user profile after retries:', error);
              // Session expired - clear ZK data
              localStorage.removeItem(ZK_STORAGE.ZK_ENABLED_KEY);
              localStorage.removeItem(ZK_STORAGE.ZK_EMAIL_KEY);
              localStorage.removeItem(ZK_STORAGE.ZK_DATA_KEY);
              localStorage.removeItem(ZK_STORAGE.RECOVERY_ENABLED_KEY);

              // Dispatch custom event to trigger immediate provider switch
              window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: false } }));

              if (!cancelled) {
                setZkEnabled(false);
                setZkData(null);
              }
            } else {
              console.log(`[ZK] Profile fetch failed, retrying (${retryCount}/${maxRetries})...`);
            }
          }
        }
      } catch (error) {
        console.error('[ZK] Bootstrap error:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void initializeZKAuth();

    return () => { cancelled = true; };
  }, []);

  // ==================== SESSION TIMEOUT ====================

  const resetActivityTimer = useCallback((): void => {
    lastActivityRef.current = Date.now();
  }, []);

  const lockSession = useCallback((): void => {
    console.log('[ZK] Locking session...');
    zkEncryptionService.lockZKSession();
    setZkSessionUnlocked(false);
    setShowUnlockModal(true);
  }, []);

  const checkInactivity = useCallback((): void => {
    const timeSinceActivity = Date.now() - lastActivityRef.current;

    if (timeSinceActivity >= SESSION_TIMEOUT && zkSessionUnlocked) {
      console.log('[ZK] Session timed out due to inactivity');
      lockSession();
    }
  }, [zkSessionUnlocked, lockSession]); // SESSION_TIMEOUT is a constant, not a dependency

  useEffect(() => {
    if (!zkEnabled || !zkSessionUnlocked) {
      return;
    }

    // Activity events
    const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];

    activityEvents.forEach((event) => {
      window.addEventListener(event, resetActivityTimer);
    });

    // Check inactivity every minute
    inactivityTimerRef.current = window.setInterval(checkInactivity, 60 * 1000);

    return () => {
      activityEvents.forEach((event) => {
        window.removeEventListener(event, resetActivityTimer);
      });

      if (inactivityTimerRef.current) {
        clearInterval(inactivityTimerRef.current);
      }
    };
  }, [zkEnabled, zkSessionUnlocked, resetActivityTimer, checkInactivity]);

  // ==================== ZK REGISTRATION ====================

  const registerZK = async (
    email: string,
    password: string,
    username: string,
    userType: string = 'individual',
    _planCode?: string
  ): Promise<LoginResponse> => {
    console.log('[ZK] Starting ZK registration...');

    try {
      // Generate ZK registration data (Argon2id)
      const zkRegData = await zkEncryptionService.generateZKRegistrationData(password);

      // Register with ZK service
      // Note: RegisterZKData interface uses camelCase, not snake_case
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

      // Store ZK data
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

      setZkEnabled(true);
      setZkData(zkDataObj);
      setZkSessionUnlocked(true);

      // Create user object from response
      const user: User = {
        id: response.user_id,
        email,
        username,
        user_type: userType,
        created_at: new Date().toISOString(),
        zk_enabled: true,
      };
      setUser(user);
      setIsAuthenticated(true);

      console.log('[ZK] Registration successful');

      // Convert RegisterZKResponse to LoginResponse
      return {
        access_token: response.access_token,
        user,
      };
    } catch (error) {
      console.error('[ZK] Registration failed:', error);
      throw error;
    }
  };

  // ==================== ZK LOGIN ====================

  const loginZK = async (email: string, password: string): Promise<LoginResponse> => {
    console.log('[ZK] Starting ZK login...');

    try {
      // Step 1: Get KDF parameters
      const kdfParams = await zkAuthService.getKDFParams(email);
      if (!kdfParams) {
        throw new Error('Failed to get KDF parameters for user');
      }
      const { kdf_salt, kdf_algorithm, kdf_iterations, kdf_memory, kdf_iv } = kdfParams;

      // Step 2: Derive password hash (Argon2id or PBKDF2)
      const passwordHash = await zkEncryptionService.getPasswordHashForLogin(
        password,
        kdf_salt,
        kdf_iterations,
        kdf_algorithm as 'argon2id' | 'pbkdf2'
      );

      // Step 3: Login with password hash
      const response = await zkAuthService.loginZK(email, passwordHash);

      // Step 4: Store ZK data
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

      // Check recovery status via separate call (non-fatal — don't kill login if this fails)
      try {
        const zkStatus = await zkAuthService.getZKStatus();
        if (zkStatus.recovery_enabled) {
          localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');
          setZkRecoveryEnabled(true);
        }
      } catch (statusError) {
        console.warn('[ZK] Failed to fetch ZK status during login, continuing:', statusError);
      }

      setZkEnabled(true);
      setZkData(zkDataObj);

      // Step 5: Unlock session BEFORE setting authenticated (prevents mode switching)
      const unlocked = await zkEncryptionService.unlockZKSession(password, zkDataObj);
      setZkSessionUnlocked(unlocked);

      // Fetch full user profile from ZK service to get complete data
      let user: User;
      try {
        const userProfile = await zkAuthService.getProfile();
        user = {
          id: userProfile.id,
          email: userProfile.email,
          username: userProfile.username,
          user_type: 'individual', // ZK service doesn't have user_type
          created_at: userProfile.created_at,
          zk_enabled: userProfile.zk_enabled,
        };
      } catch (profileError) {
        // Fallback to basic user object if profile fetch fails
        console.warn('[ZK] Failed to fetch full profile, using basic user data:', profileError);
        user = {
          id: response.user_id,
          email,
          username: email.split('@')[0] || email, // Use email prefix as fallback username
          user_type: 'individual',
          created_at: new Date().toISOString(),
          zk_enabled: response.zk_enabled,
        };
      }
      setUser(user);
      setIsAuthenticated(true);
      setLoading(false); // Ensure loading is false so redirect condition fires

      if (!unlocked) {
        setShowUnlockModal(true);
      }

      console.log('[ZK] Login successful');
      return response;
    } catch (error) {
      console.error('[ZK] Login failed:', error);
      throw error;
    }
  };

  // ==================== SESSION UNLOCK/LOCK ====================

  const unlockSession = async (password: string): Promise<boolean> => {
    // Check lockout
    if (lockoutUntil && Date.now() < lockoutUntil) {
      const remainingSeconds = Math.ceil((lockoutUntil - Date.now()) / 1000);
      throw new Error(`Too many failed attempts. Please wait ${remainingSeconds} seconds.`);
    }

    if (!zkData) {
      throw new Error('ZK data not found. Please log in again.');
    }

    try {
      console.log('[ZK] Unlocking session...');
      const unlocked = await zkEncryptionService.unlockZKSession(password, zkData);

      if (unlocked) {
        setZkSessionUnlocked(true);
        setShowUnlockModal(false);
        setUnlockAttempts(0);
        setLockoutUntil(null);
        resetActivityTimer();
        console.log('[ZK] Session unlocked successfully');
        return true;
      } else {
        // Failed unlock
        const newAttempts = unlockAttempts + 1;
        setUnlockAttempts(newAttempts);

        if (newAttempts >= MAX_UNLOCK_ATTEMPTS) {
          const lockoutEndTime = Date.now() + LOCKOUT_DURATION;
          setLockoutUntil(lockoutEndTime);
          setUnlockAttempts(0);
          throw new Error('Too many failed attempts. Locked out for 60 seconds.');
        }

        throw new Error(`Incorrect password. ${MAX_UNLOCK_ATTEMPTS - newAttempts} attempts remaining.`);
      }
    } catch (error) {
      console.error('[ZK] Unlock failed:', error);
      throw error;
    }
  };

  // ==================== RECOVERY PHRASE ====================

  const setupRecoveryPhrase = async (skipSessionCheck: boolean = false): Promise<RecoveryPhraseResult> => {
    if (!skipSessionCheck && !zkSessionUnlocked) {
      throw new Error('Session must be unlocked to set up recovery phrase');
    }

    try {
      console.log('[ZK] Setting up recovery phrase...');

      // Generate recovery phrase and encrypt master key
      const recoveryData = zkEncryptionService.generateRecoveryPhraseData();

      // Enable recovery on backend
      await zkAuthService.enableRecoveryPhrase(
        recoveryData.recoveryEncryptedMasterKey,
        recoveryData.recoveryPhraseHash
      );

      // Store recovery status
      localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');
      setZkRecoveryEnabled(true);

      console.log('[ZK] Recovery phrase setup complete');
      return {
        recoveryPhrase: recoveryData.recoveryPhrase,
        success: true,
      };
    } catch (error) {
      console.error('[ZK] Recovery phrase setup failed:', error);
      throw error;
    }
  };

  const verifyRecoveryPhrase = async (recoveryPhrase: string): Promise<boolean> => {
    try {
      // Client-side validation
      const isValid = zkEncryptionService.verifyRecoveryPhrase(recoveryPhrase);
      if (!isValid) {
        return false;
      }

      // Backend verification
      const response = await zkAuthService.verifyRecoveryPhrase(recoveryPhrase);
      return response.valid;
    } catch (error) {
      console.error('[ZK] Recovery phrase verification failed:', error);
      return false;
    }
  };

  const recoverAccount = async (email: string, recoveryPhrase: string): Promise<RecoveryAccountResponse> => {
    console.log('[ZK] Starting account recovery...');

    try {
      // Step 1: Validate recovery phrase
      const isValid = zkEncryptionService.verifyRecoveryPhrase(recoveryPhrase);
      if (!isValid) {
        throw new Error('Invalid recovery phrase format');
      }

      // Step 2: Get recovery info from backend
      const recoveryInfo = await zkAuthService.getRecoveryInfo(email);

      // Step 3: Recover account (sets session cookie)
      await zkAuthService.recoverAccount(email, recoveryPhrase);

      // Step 4: Decrypt master key in memory
      const kdfParams = recoveryInfo.kdf_params;
      const recovered = zkEncryptionService.recoverMasterKeyFromPhrase(
        recoveryPhrase,
        recoveryInfo.recovery_encrypted_master_key,
        kdfParams.kdf_iv || ''
      );

      if (!recovered) {
        throw new Error('Failed to decrypt master key');
      }

      // Step 5: Get user profile from ZK service
      const userProfile = await zkAuthService.getProfile();

      // Step 6: Set up ZK state
      const zkDataObj: ZKData = {
        kdfSalt: kdfParams.kdf_salt,
        kdfAlgorithm: kdfParams.kdf_algorithm as 'argon2id' | 'pbkdf2',
        kdfIterations: kdfParams.kdf_iterations,
        encryptedMasterKey: recoveryInfo.recovery_encrypted_master_key,
        masterKeyIV: kdfParams.kdf_iv || '',
        ...(kdfParams.kdf_memory !== undefined && { kdfMemory: kdfParams.kdf_memory }),
      };

      localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
      localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);
      localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));
      localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');

      setZkEnabled(true);
      setZkData(zkDataObj);
      setZkSessionUnlocked(true);
      setZkRecoveryEnabled(true);

      // Convert ZKUserProfile to User
      const user: User = {
        id: userProfile.id,
        email: userProfile.email,
        username: userProfile.username,
        user_type: 'individual', // ZK service doesn't have user_type, default to individual
        created_at: userProfile.created_at,
        zk_enabled: userProfile.zk_enabled,
      };
      setUser(user);
      setIsAuthenticated(true);

      // Note: ZK users don't use WebSocket - ZK service (port 8002) doesn't have WebSocket support
      // Real-time updates are not available for ZK users; they use polling or manual refresh

      console.log('[ZK] Account recovery successful');
      return {
        user,
        recovery_enabled: true,
      };
    } catch (error) {
      console.error('[ZK] Account recovery failed:', error);
      throw error;
    }
  };

  // ==================== ZK STATUS ====================

  const checkZKStatus = async (): Promise<ZKStatusResponse | null> => {
    try {
      const status = await zkAuthService.getZKStatus();
      setZkEnabled(status.zk_enabled);
      setZkRecoveryEnabled(status.recovery_enabled);
      return status;
    } catch (error) {
      console.error('[ZK] Failed to check ZK status:', error);
      return null;
    }
  };

  // ==================== LOGOUT ====================

  const logout = async (): Promise<void> => {
    console.log('[ZK] Logging out...');

    try {
      // Mark logout intent so bootstrap won't re-enable ZK from a stale backend cookie.
      // sessionStorage persists across page refresh but clears when the tab closes.
      sessionStorage.setItem('zkLogoutIntent', String(Date.now()));

      // Lock session (clear master key from memory)
      zkEncryptionService.lockZKSession();

      // Clear localStorage
      localStorage.removeItem(ZK_STORAGE.ZK_ENABLED_KEY);
      localStorage.removeItem(ZK_STORAGE.ZK_EMAIL_KEY);
      localStorage.removeItem(ZK_STORAGE.ZK_DATA_KEY);
      localStorage.removeItem(ZK_STORAGE.RECOVERY_ENABLED_KEY);

      // Dispatch custom event to trigger immediate provider switch
      window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: false } }));

      // Clear state
      setZkEnabled(false);
      setZkSessionUnlocked(false);
      setZkRecoveryEnabled(false);
      setZkData(null);
      setUser(null);
      setIsAuthenticated(false);
      setShowUnlockModal(false);

      // Note: ZK users don't use WebSocket, so no need to disconnect

      // Call backend logout (clears HTTP-only cookie)
      await zkAuthService.logout();

      console.log('[ZK] Logout complete');
    } catch (error) {
      console.error('[ZK] Logout error:', error);
      throw error;
    }
  };

  // ==================== PROVIDER ====================

  const value: ZKAuthContextValue = {
    // User
    user,
    isAuthenticated,
    loading,

    // ZK-specific
    zkEnabled,
    zkSessionUnlocked,
    zkRecoveryEnabled,
    zkData,

    // Methods
    registerZK,
    loginZK,
    unlockSession,
    lockSession,
    setupRecoveryPhrase,
    verifyRecoveryPhrase,
    recoverAccount,
    checkZKStatus,
    logout,

    // Session management
    showUnlockModal,
    setShowUnlockModal,

    // Rate limiting
    unlockAttempts,
    lockoutUntil,
  };

  return <ZKAuthContext.Provider value={value}>{children}</ZKAuthContext.Provider>;
};

export default ZKAuthContext;
