// frontend-clean/src/contexts/AuthContext.tsx

import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { authService, type AuthResponse, type UserProfile } from '../services/authService';
import { websocketService } from '../services/websocketService';
import * as zkAuthService from '../services/zkAuthService';
import type { RegisterZKData } from '../services/zkAuthService';
import {
  generateZKRegistrationData,
  unlockZKSession,
  lockZKSession,
  isZKSessionUnlocked,
  getPasswordHashForLogin,
  generateRecoveryPhraseData,
  verifyRecoveryPhrase as verifyRecoveryPhraseZK,
  recoverMasterKeyFromPhrase,
} from '../services/zkEncryptionService';
import { ZK_STORAGE } from '../config/constants';

type User = UserProfile;

interface LoginResponse extends AuthResponse {
  encrypted_master_key?: string;
  kdf_iv?: string;
  recovery_enabled?: boolean;
}

interface ZKData {
  kdfSalt: string;
  kdfAlgorithm: 'pbkdf2' | 'argon2id';
  kdfIterations: number;
  kdfMemory: number | undefined;
  encryptedMasterKey: string;
  masterKeyIV: string;
}

interface RecoveryPhraseResult {
  recoveryPhrase: string;
  success: boolean;
}

interface ZKStatusResponse {
  zk_enabled: boolean;
  recovery_enabled?: boolean;
  [key: string]: unknown;
}

interface RecoveryAccountResponse {
  user?: User;
  user_id?: string;
  kdf_salt: string;
  kdf_iterations: number;
  encrypted_master_key?: string;
  recovery_encrypted_master_key: string;
  kdf_iv?: string;
  recovery_iv?: string;
  [key: string]: unknown;
}

interface AuthContextValue {
  // Standard Auth
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  token: string | null;
  login: (email: string, password: string) => Promise<LoginResponse>;
  register: (email: string, password: string, username: string, userType: string, planCode?: string | null) => Promise<LoginResponse>;
  logout: () => Promise<void>;

  // Zero-Knowledge Encryption
  zkEnabled: boolean;
  zkSessionUnlocked: boolean;
  zkRecoveryEnabled: boolean;
  registerZK: (email: string, password: string, username: string, userType?: string, planCode?: string | null) => Promise<LoginResponse>;
  loginZK: (email: string, password: string) => Promise<LoginResponse>;
  unlockSession: (password: string) => Promise<boolean>;
  lockSession: () => void;
  setupRecoveryPhrase: (skipSessionCheck?: boolean) => Promise<RecoveryPhraseResult>;
  verifyRecoveryPhrase: (recoveryPhrase: string) => Promise<boolean>;
  recoverAccount: (email: string, recoveryPhrase: string) => Promise<RecoveryAccountResponse>;
  checkZKStatus: () => Promise<ZKStatusResponse | null>;

  // Session Management
  showUnlockModal: boolean;
  setShowUnlockModal: (show: boolean) => void;
}

interface AuthProviderProps {
  children: React.ReactNode;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [token, setToken] = useState<string | null>(null);

  // Zero-Knowledge Encryption State
  const [zkEnabled, setZkEnabled] = useState<boolean>(false);
  const [zkSessionUnlocked, setZkSessionUnlocked] = useState<boolean>(false);
  const [zkRecoveryEnabled, setZkRecoveryEnabled] = useState<boolean>(false);
  const [zkData, setZkData] = useState<ZKData | null>(null); // KDF params, encrypted master key, etc.

  // Session timeout state
  const [showUnlockModal, setShowUnlockModal] = useState<boolean>(false);
  const lastActivityRef = useRef<number>(Date.now());
  const inactivityTimerRef = useRef<number | null>(null);

  // Rate limiting for unlock attempts
  const [unlockAttempts, setUnlockAttempts] = useState<number>(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);
  const MAX_UNLOCK_ATTEMPTS = 5;
  const LOCKOUT_DURATION = 60 * 1000; // 60 seconds

  // Keep unsubscribe functions here so we can remove listeners cleanly
  const wsUnsubscribersRef = useRef<Array<() => void>>([]);

  // Helper: remove any existing websocket listeners registered by this provider
  const removeWebSocketListeners = (): void => {
    if (wsUnsubscribersRef.current && wsUnsubscribersRef.current.length > 0) {
      wsUnsubscribersRef.current.forEach(unsub => {
        try {
          if (typeof unsub === 'function') unsub();
        } catch (err) {
          console.warn('Error while unsubscribing ws listener', err);
        }
      });
      wsUnsubscribersRef.current = [];
    }
  };

  const setupWebSocketListeners = (): void => {
    // Remove previous listeners before adding new ones (prevents duplicates)
    removeWebSocketListeners();

    // Register listeners and keep unsubscribe functions
    wsUnsubscribersRef.current.push(
      websocketService.on('file_uploaded', (data: unknown) => {
        console.log('File uploaded via WebSocket:', data);
        // keep the existing window event bridge for StorageContext
        window.dispatchEvent(new CustomEvent('ws-file-uploaded', { detail: data }));
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('file_deleted', (data: unknown) => {
        console.log('File deleted via WebSocket:', data);
        window.dispatchEvent(new CustomEvent('ws-file-deleted', { detail: data }));
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('storage_update', (data: unknown) => {
        console.log('Storage updated via WebSocket:', data);
        window.dispatchEvent(new CustomEvent('ws-storage-update', { detail: data }));
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('error', (error: unknown) => {
        console.error('WebSocket error:', error);
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('disconnected', (data: unknown) => {
        console.log('WebSocket disconnected:', data);
      })
    );
  };

  useEffect(() => {
    let mounted = true;

    const bootstrap = async (): Promise<void> => {
      // SECURITY FIX: Check if user is authenticated via HTTP-only cookie
      // by attempting to load profile (backend will validate cookie)

      const MAX_RETRIES = 3;
      const RETRY_DELAY = 2000; // 2 seconds between retries
      const REQUEST_TIMEOUT = 15000; // 15 seconds per request

      // Check if this is a ZK user (stored in localStorage during login)
      const isZKUser = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
      console.log('[Auth] Bootstrap - isZKUser:', isZKUser);

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (!mounted) return;

        try {
          console.log(`Bootstrap attempt ${attempt}/${MAX_RETRIES}...`);

          // Create abort controller for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

          try {
            let userData: User;

            if (isZKUser) {
              // ZK users: Call ZK service /me endpoint
              console.log('[Auth] Bootstrap - calling ZK service /me endpoint');
              const { ZK_ENDPOINTS } = await import('../config/constants');
              const response = await fetch(ZK_ENDPOINTS.ME, {
                method: 'GET',
                credentials: 'include',
                signal: controller.signal,
              });

              if (!response.ok) {
                throw new Error('ZK authentication failed');
              }

              userData = await response.json() as User;
              userData.zk_enabled = true; // Ensure ZK flag is set
              setUser(userData);
              setZkEnabled(true);
            } else {
              // Normal users: Call normal storage service
              userData = await loadUserDataWithSignal(null, controller.signal);
            }

            clearTimeout(timeoutId);

            if (!mounted) return;

            setIsAuthenticated(true);

            // Skip session token refresh and WebSocket for ZK users
            if (!isZKUser) {
              await refreshSessionToken();

              // Connect WebSocket (will use cookie or token from backend response)
              try {
                await websocketService.connect(null);
                if (!mounted) return;
                setupWebSocketListeners();
              } catch (error) {
                console.error('Failed to connect WebSocket on boot:', error);
              }
            }

            // If user has ZK enabled, check session state and sync React state
            if (userData.zk_enabled) {
              // Check if ZK session is already unlocked (keys still in memory)
              if (isZKSessionUnlocked()) {
                console.log('[Auth] ZK session already unlocked - syncing React state');
                setZkSessionUnlocked(true);

                // Also load ZK data for potential re-lock/unlock
                try {
                  const storedZkData = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
                  if (storedZkData && mounted) {
                    setZkData(JSON.parse(storedZkData) as ZKData);
                  }
                } catch (e) {
                  console.warn('[Auth] Failed to load zkData from localStorage:', e);
                }
              } else {
                console.log('[Auth] ZK user detected but session not unlocked - loading ZK data from localStorage');
                try {
                  // Get ZK data from localStorage (stored during login)
                  const storedZkData = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
                  console.log('[Auth] storedZkData from localStorage:', storedZkData ? 'found' : 'not found');

                  if (storedZkData && mounted) {
                    const zkDataObj = JSON.parse(storedZkData) as ZKData;
                    console.log('[Auth] Parsed zkData:', {
                      hasKdfSalt: !!zkDataObj.kdfSalt,
                      hasEncryptedMasterKey: !!zkDataObj.encryptedMasterKey,
                      hasKdfIterations: !!zkDataObj.kdfIterations,
                      hasMasterKeyIV: !!zkDataObj.masterKeyIV,
                    });

                    // Validate zkData has required fields
                    if (!zkDataObj.kdfSalt || !zkDataObj.encryptedMasterKey) {
                      console.error('[Auth] Invalid zkData - missing required fields');
                      console.warn('[Auth] ZK user needs to re-login to get valid credentials');
                    } else {
                      // Store ZK data for unlock
                      setZkData(zkDataObj);
                      // Show unlock modal
                      setShowUnlockModal(true);
                    }
                  } else {
                    console.warn('[Auth] ZK user detected but no ZK data in localStorage - user needs to re-login');
                  }
                } catch (zkError) {
                  console.error('[Auth] Failed to load ZK data from localStorage:', zkError);
                }
              }
            }

            // Success - exit retry loop
            break;
          } catch (err) {
            clearTimeout(timeoutId);

            // If aborted due to timeout, retry
            if (err instanceof Error && err.name === 'AbortError') {
              console.log(`Bootstrap attempt ${attempt} timed out`);
              if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
              }
            }

            // If 401/403, user is not authenticated - don't retry
            if (err instanceof Error && (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('Failed to load profile'))) {
              console.log('User not authenticated');
              break;
            }

            // Other error - retry
            if (err instanceof Error) {
              console.log(`Bootstrap attempt ${attempt} failed:`, err.message);
            }
            if (attempt < MAX_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
              continue;
            }
          }
        } catch (err) {
          if (err instanceof Error) {
            console.log('Bootstrap error:', err.message);
          }
        }
      }

      if (mounted) setLoading(false);
    };

    bootstrap();

    return () => {
      mounted = false;
      // cleanup listeners and disconnect WS on unmount
      removeWebSocketListeners();
      if (websocketService.isConnected) {
        websocketService.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session timeout auto-lock (30 minutes of inactivity)
  useEffect(() => {
    if (!zkEnabled || !zkSessionUnlocked) {
      // Clear timer if ZK is not enabled or session is already locked
      if (inactivityTimerRef.current) {
        clearInterval(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }

    const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    // Update last activity on user interaction
    const updateActivity = (): void => {
      lastActivityRef.current = Date.now();
    };

    // Activity event listeners - only meaningful user actions (not mousemove)
    const events: Array<keyof WindowEventMap> = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach(event => {
      window.addEventListener(event, updateActivity, { passive: true } as AddEventListenerOptions);
    });

    // Check for inactivity every minute
    inactivityTimerRef.current = window.setInterval(() => {
      const now = Date.now();
      const timeSinceActivity = now - lastActivityRef.current;

      if (timeSinceActivity >= SESSION_TIMEOUT && zkSessionUnlocked) {
        console.log('Session auto-locked due to inactivity');
        lockSession();
        setShowUnlockModal(true);
      }
    }, 60 * 1000); // Check every minute

    // Cleanup
    return () => {
      events.forEach(event => {
        window.removeEventListener(event, updateActivity);
      });
      if (inactivityTimerRef.current) {
        clearInterval(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };
  }, [zkEnabled, zkSessionUnlocked]);

  // Auto-lock behavior is handled by:
  // 1. Inactivity timeout (30 minutes) - see above useEffect
  // 2. Manual lock button
  //
  // Note: We intentionally do NOT lock on:
  // - Tab visibility change (too aggressive, annoying UX)
  // - Page refresh (would require unlock on every refresh)
  // - Page hide (same as above)
  //
  // The encryption keys are still cleared from memory on refresh,
  // but we attempt to restore the session from localStorage zkData.

  // Version with AbortSignal support for timeout handling
  const loadUserDataWithSignal = async (_authToken: string | null, signal: AbortSignal): Promise<User> => {
    try {
      const userData = await authService.getProfileWithSignal(signal);
      setUser(userData);
      setIsAuthenticated(true);
      // Set ZK enabled status from profile
      if (userData.zk_enabled) {
        setZkEnabled(true);
      }
      return userData;
    } catch (error) {
      console.error('Failed to load user data:', error);
      throw error;
    }
  };

  const refreshSessionToken = async (): Promise<string | null> => {
    try {
      const session = await authService.getSessionToken();
      if (session?.session_token) {
        setToken(session.session_token);
        return session.session_token;
      }
    } catch (error) {
      console.error('Failed to refresh session token:', error);
    }
    return null;
  };

  const login = async (email: string, password: string): Promise<LoginResponse> => {
    const data = await authService.login(email, password);

    setToken(data?.access_token || null);
    setUser(data.user);
    setIsAuthenticated(true);
    if (!data?.access_token) {
      await refreshSessionToken();
    }

    // Connect WebSocket after successful login
    try {
      await websocketService.connect(null); // Will use cookie
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after login:', error);
    }

    return data;
  };

  const register = async (email: string, password: string, username: string, userType: string, planCode: string | null = null): Promise<LoginResponse> => {
    const data = await authService.register(email, password, username, userType, planCode);

    setToken(data?.access_token || null);
    setUser(data.user);
    setIsAuthenticated(true);
    if (!data?.access_token) {
      await refreshSessionToken();
    }

    // Connect WebSocket after successful registration
    try {
      await websocketService.connect(null); // Will use cookie
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after registration:', error);
    }

    return data;
  };

  const logout = async (): Promise<void> => {
    // Remove our listeners first
    removeWebSocketListeners();

    // Disconnect WebSocket before clearing auth
    try {
      websocketService.disconnect();
    } catch (e) {
      // Websocket may not be connected
    }

    // Call backend logout to clear HTTP-only cookie
    try {
      await authService.logout();
    } catch (error) {
      console.error('Logout error:', error);
    }

    // Clear ZK session if enabled
    if (zkEnabled) {
      lockZKSession();
      setZkSessionUnlocked(false);
      setZkData(null);
    }

    // Clear ZK data from localStorage
    localStorage.removeItem(ZK_STORAGE.ZK_ENABLED_KEY);
    localStorage.removeItem(ZK_STORAGE.ZK_EMAIL_KEY);
    localStorage.removeItem(ZK_STORAGE.ZK_DATA_KEY);
    localStorage.removeItem(ZK_STORAGE.RECOVERY_ENABLED_KEY);

    setToken(null);
    setIsAuthenticated(false);
    setUser(null);
    setZkEnabled(false);
    setZkRecoveryEnabled(false);
  };

  // ==================== Zero-Knowledge Encryption Methods ====================

  /**
   * Register a new user with Zero-Knowledge Encryption
   * @param email - User email
   * @param password - User password (never sent to server)
   * @param username - Username
   * @param userType - User type
   * @returns Registration result
   */
  const registerZK = async (email: string, password: string, username: string, userType: string = 'individual'): Promise<LoginResponse> => {
    // Generate ZK registration data (client-side encryption with Argon2id)
    const zkRegData = await generateZKRegistrationData(password);

    // Send encrypted data to backend (includes Argon2id parameters)
    const registerData: RegisterZKData = {
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

    const data = await zkAuthService.registerZK(registerData);

    // Set user data and auth state
    const user: User = { id: data.user_id, email, username, user_type: userType, plan_type: 'free', storage_quota: 0, storage_used: 0, created_at: new Date().toISOString(), zk_enabled: true };
    setUser(user);
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);

    // Store ZK data for session
    const zkDataObj: ZKData = {
      kdfSalt: zkRegData.kdfSalt,
      kdfAlgorithm: zkRegData.kdfAlgorithm,  // argon2id (primary) or pbkdf2 (low-memory fallback)
      kdfIterations: zkRegData.kdfIterations,
      kdfMemory: zkRegData.kdfMemory,  // Argon2id memory parameter
      encryptedMasterKey: zkRegData.encryptedMasterKey,
      masterKeyIV: zkRegData.masterKeyIV,
    };
    setZkData(zkDataObj);

    // Store ZK preferences and encrypted data in localStorage
    // (encrypted master key is safe to store - encrypted with password-derived key)
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);
    localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));

    // Skip WebSocket for ZK users (ZK service doesn't have WebSocket support)
    // WebSocket is only available on the normal storage service (port 8001)
    // Note: ZK service uses HTTP-only APIs, no real-time updates via WebSocket

    // Skip session token refresh for ZK users (they use HTTP-only cookies, not tokens)
    // The ZK service doesn't have a /session-token endpoint

    return {
      access_token: data.access_token,
      token_type: 'bearer',
      user,
    };
  };

  /**
   * Login with Zero-Knowledge Encryption
   * @param email - User email
   * @param password - User password (never sent to server)
   * @returns Login result
   */
  const loginZK = async (email: string, password: string): Promise<LoginResponse> => {
    // First, get KDF params from backend
    const kdfParams = await zkAuthService.getKDFParams(email);

    if (!kdfParams) {
      throw new Error('User not found or ZK not enabled for this account');
    }

    // Derive password hash client-side (async for Argon2id)
    const passwordHash = await getPasswordHashForLogin(
      password,
      kdfParams.kdf_salt,
      kdfParams.kdf_iterations,
      kdfParams.kdf_algorithm === 'pbkdf2' ? 'pbkdf2' : 'argon2id'
    );

    // Login with hashed password
    const data = await zkAuthService.loginZK(email, passwordHash);

    // Unlock ZK session with the encrypted master key from backend
    const unlocked = await unlockZKSession(password, {
      kdfSalt: kdfParams.kdf_salt,
      encryptedMasterKey: data.encrypted_master_key,
      kdfAlgorithm: kdfParams.kdf_algorithm === 'pbkdf2' ? 'pbkdf2' : 'argon2id',
      kdfIterations: kdfParams.kdf_iterations,
      masterKeyIV: data.master_key_iv,
    });

    if (!unlocked) {
      throw new Error('Failed to unlock encryption session');
    }

    // Set user data and auth state
    const user: User = { id: data.user_id, email, username: email, user_type: 'individual', plan_type: 'free', storage_quota: 0, storage_used: 0, created_at: new Date().toISOString(), zk_enabled: true };
    setUser(user);
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);

    // Store ZK data for session
    const zkDataObj: ZKData = {
      kdfSalt: kdfParams.kdf_salt,
      kdfAlgorithm: kdfParams.kdf_algorithm === 'pbkdf2' ? 'pbkdf2' : 'argon2id',
      kdfIterations: kdfParams.kdf_iterations,
      kdfMemory: kdfParams.kdf_memory || undefined,
      encryptedMasterKey: data.encrypted_master_key,
      masterKeyIV: data.master_key_iv,
    };
    setZkData(zkDataObj);

    // Check if recovery is enabled - zkAuthService response may have this field
    const recoveryEnabled = (data as any).recovery_enabled;
    if (recoveryEnabled) {
      setZkRecoveryEnabled(true);
      localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');
    }

    // Store ZK preferences and encrypted data in localStorage
    // (encrypted master key is safe to store - encrypted with password-derived key)
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);
    localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));

    // Skip WebSocket for ZK users (ZK service doesn't have WebSocket support)
    // WebSocket is only available on the normal storage service (port 8001)
    // Note: ZK service uses HTTP-only APIs, no real-time updates via WebSocket

    // Skip session token refresh for ZK users (they use HTTP-only cookies, not tokens)
    // The ZK service doesn't have a /session-token endpoint

    return {
      access_token: data.access_token,
      token_type: 'bearer',
      user,
    };
  };

  /**
   * Unlock ZK session (e.g., after session timeout)
   * Includes rate limiting to prevent brute force attacks
   * @param password - User password
   * @returns True if unlock successful
   */
  const unlockSession = async (password: string): Promise<boolean> => {
    console.log('[Auth] unlockSession called');

    // Check if currently locked out
    if (lockoutUntil && Date.now() < lockoutUntil) {
      const remainingSeconds = Math.ceil((lockoutUntil - Date.now()) / 1000);
      throw new Error(`Too many failed attempts. Please wait ${remainingSeconds} seconds before trying again.`);
    }

    // Clear lockout if expired
    if (lockoutUntil && Date.now() >= lockoutUntil) {
      setLockoutUntil(null);
      setUnlockAttempts(0);
    }

    console.log('[Auth] zkData:', zkData ? 'present' : 'null');

    if (!zkData) {
      console.error('[Auth] No zkData available');
      throw new Error('No ZK data available. Please log in again.');
    }

    console.log('[Auth] zkData fields:', {
      hasKdfSalt: !!zkData.kdfSalt,
      hasEncryptedMasterKey: !!zkData.encryptedMasterKey,
      hasKdfIterations: !!zkData.kdfIterations,
      hasMasterKeyIV: !!zkData.masterKeyIV,
    });

    try {
      const unlocked = await unlockZKSession(password, zkData);
      console.log('[Auth] unlockZKSession result:', unlocked);

      if (unlocked) {
        console.log('[Auth] Setting zkSessionUnlocked to true');
        setZkSessionUnlocked(true);
        setShowUnlockModal(false);
        lastActivityRef.current = Date.now(); // Reset activity timer
        setUnlockAttempts(0); // Reset attempts on success
        setLockoutUntil(null);
        return true;
      }

      // Increment failed attempts
      const newAttempts = unlockAttempts + 1;
      setUnlockAttempts(newAttempts);

      if (newAttempts >= MAX_UNLOCK_ATTEMPTS) {
        setLockoutUntil(Date.now() + LOCKOUT_DURATION);
        throw new Error(`Too many failed attempts. Please wait ${LOCKOUT_DURATION / 1000} seconds before trying again.`);
      }

      throw new Error(`Invalid password. ${MAX_UNLOCK_ATTEMPTS - newAttempts} attempts remaining.`);
    } catch (error) {
      console.error('[Auth] Error in unlockSession:', error);

      // Only increment attempts for authentication failures, not other errors
      if (error instanceof Error && (error.message?.includes('Decryption failed') || error.message?.includes('Invalid password'))) {
        const newAttempts = unlockAttempts + 1;
        setUnlockAttempts(newAttempts);

        if (newAttempts >= MAX_UNLOCK_ATTEMPTS) {
          setLockoutUntil(Date.now() + LOCKOUT_DURATION);
          throw new Error(`Too many failed attempts. Please wait ${LOCKOUT_DURATION / 1000} seconds before trying again.`);
        }
      }

      throw error;
    }
  };

  /**
   * Lock ZK session (manual lock or auto-lock on timeout)
   */
  const lockSession = (): void => {
    lockZKSession();
    setZkSessionUnlocked(false);
    setShowUnlockModal(true);
  };

  /**
   * Setup recovery phrase for account recovery
   * @param skipSessionCheck - Skip session check (used during registration when session is unlocked but state not updated)
   * @returns { recoveryPhrase, success }
   */
  const setupRecoveryPhrase = async (skipSessionCheck: boolean = false): Promise<RecoveryPhraseResult> => {
    if (!skipSessionCheck && !zkSessionUnlocked) {
      throw new Error('Session must be unlocked to setup recovery phrase');
    }

    // Generate recovery phrase and encrypt master key with it (async)
    const recoveryData = await generateRecoveryPhraseData();

    // Send encrypted data to backend
    await zkAuthService.enableRecoveryPhrase(
      recoveryData.recoveryEncryptedMasterKey,
      recoveryData.recoveryPhraseHash
    );

    setZkRecoveryEnabled(true);
    localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');

    // Return recovery phrase to show to user (ONLY SHOWN ONCE)
    return {
      recoveryPhrase: recoveryData.recoveryPhrase,
      success: true,
    };
  };

  /**
   * Verify recovery phrase
   * @param recoveryPhrase - Recovery phrase to verify
   * @returns True if valid
   */
  const verifyRecoveryPhrase = async (recoveryPhrase: string): Promise<boolean> => {
    // Client-side validation first (async)
    if (!await verifyRecoveryPhraseZK(recoveryPhrase)) {
      return false;
    }

    // Backend verification
    try {
      const result = await zkAuthService.verifyRecoveryPhrase(recoveryPhrase);
      return result.valid || false;
    } catch (error) {
      console.error('Recovery phrase verification failed:', error);
      return false;
    }
  };

  /**
   * Recover account using recovery phrase
   * @param email - User email
   * @param recoveryPhrase - Recovery phrase
   * @returns Recovery result
   */
  const recoverAccount = async (email: string, recoveryPhrase: string): Promise<RecoveryAccountResponse> => {
    // Validate recovery phrase format (async)
    if (!await verifyRecoveryPhraseZK(recoveryPhrase)) {
      throw new Error('Invalid recovery phrase format');
    }

    // First, get recovery info to obtain KDF params
    const recoveryInfo = await zkAuthService.getRecoveryInfo(email);

    // Call backend to recover account
    const recoverData = await zkAuthService.recoverAccount(email, recoveryPhrase);

    // Recover master key from recovery phrase (async)
    const recovered = await recoverMasterKeyFromPhrase(
      recoveryPhrase,
      recoverData.recovery_encrypted_master_key,
      recoveryInfo.kdf_params.kdf_iv || ''
    );

    if (!recovered) {
      throw new Error('Failed to recover account. Invalid recovery phrase.');
    }

    // Get current user info
    const userProfile = await authService.getProfile();
    const currentUser: User = {
      ...userProfile,
      zk_enabled: userProfile.zk_enabled || true,
    };

    // Set user data and auth state
    setUser(currentUser);
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);
    setZkRecoveryEnabled(true);

    // Store ZK data for session
    const kdfAlgorithm = recoveryInfo.kdf_params.kdf_algorithm as 'pbkdf2' | 'argon2id';
    setZkData({
      kdfSalt: recoveryInfo.kdf_params.kdf_salt,
      kdfAlgorithm: kdfAlgorithm,
      kdfIterations: recoveryInfo.kdf_params.kdf_iterations,
      kdfMemory: recoveryInfo.kdf_params.kdf_memory,
      encryptedMasterKey: recoverData.encrypted_master_key || recoverData.recovery_encrypted_master_key,
      masterKeyIV: recoveryInfo.kdf_params.kdf_iv || '',
    });

    // Store ZK preferences
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);
    localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');

    // Connect WebSocket
    try {
      await websocketService.connect(null);
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after recovery:', error);
    }

    await refreshSessionToken();

    // Construct response matching interface
    const response: RecoveryAccountResponse = {
      user: currentUser,
      user_id: currentUser.id,
      kdf_salt: recoveryInfo.kdf_params.kdf_salt,
      kdf_iterations: recoveryInfo.kdf_params.kdf_iterations,
      encrypted_master_key: recoverData.encrypted_master_key,
      recovery_encrypted_master_key: recoverData.recovery_encrypted_master_key,
      ...(recoveryInfo.kdf_params.kdf_iv ? { kdf_iv: recoveryInfo.kdf_params.kdf_iv } : {}),
    };

    return response;
  };

  /**
   * Check ZK status for current user
   * @returns ZK status
   */
  const checkZKStatus = async (): Promise<ZKStatusResponse | null> => {
    try {
      const status = await zkAuthService.getZKStatus();

      setZkEnabled(status.zk_enabled || false);
      // Backend returns 'recovery_enabled'
      setZkRecoveryEnabled(status.recovery_enabled || false);

      return { zk_enabled: status.zk_enabled, recovery_enabled: status.recovery_enabled };
    } catch (error) {
      console.error('Failed to check ZK status:', error);
      return null;
    }
  };

  const value: AuthContextValue = {
    // Standard Auth
    user,
    isAuthenticated,
    loading,
    token,
    login,
    register,
    logout,

    // Zero-Knowledge Encryption
    zkEnabled,
    zkSessionUnlocked,
    zkRecoveryEnabled,
    registerZK,
    loginZK,
    unlockSession,
    lockSession,
    setupRecoveryPhrase,
    verifyRecoveryPhrase,
    recoverAccount,
    checkZKStatus,

    // Session Management
    showUnlockModal,
    setShowUnlockModal,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
