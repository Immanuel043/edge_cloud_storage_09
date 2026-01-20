// frontend-clean/src/contexts/AuthContext.jsx

import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { authService } from '../services/authService';
import { websocketService } from '../services/websocketService';
import * as zkAuthService from '../services/zkAuthService';
import {
  generateZKRegistrationData,
  unlockZKSession,
  lockZKSession,
  isZKSessionUnlocked,
  getPasswordHashForLogin,
  generateRecoveryPhraseData,
  verifyRecoveryPhrase as verifyRecoveryPhraseZK,
  recoverMasterKeyFromPhrase,
  getRecoveryPhraseHash,
} from '../services/zkEncryptionService';
import { ZK_FEATURES, ZK_STORAGE } from '../config/constants';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(null);

  // Zero-Knowledge Encryption State
  const [zkEnabled, setZkEnabled] = useState(false);
  const [zkSessionUnlocked, setZkSessionUnlocked] = useState(false);
  const [zkRecoveryEnabled, setZkRecoveryEnabled] = useState(false);
  const [zkData, setZkData] = useState(null); // KDF params, encrypted master key, etc.

  // Session timeout state
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const lastActivityRef = useRef(Date.now());
  const inactivityTimerRef = useRef(null);

  // Rate limiting for unlock attempts
  const [unlockAttempts, setUnlockAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(null);
  const MAX_UNLOCK_ATTEMPTS = 5;
  const LOCKOUT_DURATION = 60 * 1000; // 60 seconds

  // Keep unsubscribe functions here so we can remove listeners cleanly
  const wsUnsubscribersRef = useRef([]);

  // Helper: remove any existing websocket listeners registered by this provider
  const removeWebSocketListeners = () => {
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

  const setupWebSocketListeners = () => {
    // Remove previous listeners before adding new ones (prevents duplicates)
    removeWebSocketListeners();

    // Register listeners and keep unsubscribe functions
    wsUnsubscribersRef.current.push(
      websocketService.on('file_uploaded', (data) => {
        console.log('File uploaded via WebSocket:', data);
        // keep the existing window event bridge for StorageContext
        window.dispatchEvent(new CustomEvent('ws-file-uploaded', { detail: data }));
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('file_deleted', (data) => {
        console.log('File deleted via WebSocket:', data);
        window.dispatchEvent(new CustomEvent('ws-file-deleted', { detail: data }));
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('storage_update', (data) => {
        console.log('Storage updated via WebSocket:', data);
        window.dispatchEvent(new CustomEvent('ws-storage-update', { detail: data }));
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('error', (error) => {
        console.error('WebSocket error:', error);
      })
    );

    wsUnsubscribersRef.current.push(
      websocketService.on('disconnected', (data) => {
        console.log('WebSocket disconnected:', data);
      })
    );
  };

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
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
            let userData;

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

              userData = await response.json();
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
                    setZkData(JSON.parse(storedZkData));
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
                    const zkDataObj = JSON.parse(storedZkData);
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
            if (err.name === 'AbortError') {
              console.log(`Bootstrap attempt ${attempt} timed out`);
              if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
              }
            }

            // If 401/403, user is not authenticated - don't retry
            if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('Failed to load profile')) {
              console.log('User not authenticated');
              break;
            }

            // Other error - retry
            console.log(`Bootstrap attempt ${attempt} failed:`, err.message);
            if (attempt < MAX_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
              continue;
            }
          }
        } catch (err) {
          console.log('Bootstrap error:', err.message);
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
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };

    // Activity event listeners - only meaningful user actions (not mousemove)
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach(event => {
      window.addEventListener(event, updateActivity, { passive: true });
    });

    // Check for inactivity every minute
    inactivityTimerRef.current = setInterval(() => {
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

  const loadUserData = async (authToken) => {
    try {
      const userData = await authService.getProfile(authToken);
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

  // Version with AbortSignal support for timeout handling
  const loadUserDataWithSignal = async (authToken, signal) => {
    try {
      const userData = await authService.getProfileWithSignal(authToken, signal);
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

  const refreshSessionToken = async () => {
    try {
      const session = await authService.getSessionToken();
      if (session?.access_token) {
        setToken(session.access_token);
        return session.access_token;
      }
    } catch (error) {
      console.error('Failed to refresh session token:', error);
    }
    return null;
  };

  const login = async (email, password) => {
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

  const register = async (email, password, username, userType, planCode = null) => {
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

  const logout = async () => {
    // Remove our listeners first
    removeWebSocketListeners();

    // Disconnect WebSocket before clearing auth
    if (websocketService.isConnected) {
      websocketService.disconnect();
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
   * @param {string} email - User email
   * @param {string} password - User password (never sent to server)
   * @param {string} username - Username
   * @param {string} userType - User type
   * @returns {Promise<Object>} Registration result
   */
  const registerZK = async (email, password, username, userType = 'individual', planCode = null) => {
    // Generate ZK registration data (client-side encryption with Argon2id)
    const zkRegData = await generateZKRegistrationData(password);

    // Send encrypted data to backend (includes Argon2id parameters)
    const data = await zkAuthService.registerZK({
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
      planCode: planCode,  // Pass plan code for subscription creation
    });

    // Set user data and auth state
    setUser(data.user || { id: data.user_id, email, username });
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);

    // Store ZK data for session
    const zkDataObj = {
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

    return data;
  };

  /**
   * Login with Zero-Knowledge Encryption
   * @param {string} email - User email
   * @param {string} password - User password (never sent to server)
   * @returns {Promise<Object>} Login result
   */
  const loginZK = async (email, password) => {
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
      kdfParams.kdf_algorithm || 'argon2id'  // Default to argon2id (primary algorithm)
    );

    // Login with hashed password
    const data = await zkAuthService.loginZK(email, passwordHash);

    // Unlock ZK session with the encrypted master key from backend
    const unlocked = await unlockZKSession(password, {
      kdfSalt: kdfParams.kdf_salt,
      encryptedMasterKey: data.encrypted_master_key,
      kdfAlgorithm: kdfParams.kdf_algorithm || 'argon2id',  // Default to argon2id (primary)
      kdfIterations: kdfParams.kdf_iterations,
      masterKeyIV: kdfParams.kdf_iv || data.kdf_iv,
    });

    if (!unlocked) {
      throw new Error('Failed to unlock encryption session');
    }

    // Set user data and auth state
    setUser(data.user || { id: data.user_id, email });
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);

    // Store ZK data for session
    const zkDataObj = {
      kdfSalt: kdfParams.kdf_salt,
      kdfAlgorithm: kdfParams.kdf_algorithm || 'argon2id',  // argon2id (primary) or pbkdf2 (low-memory fallback)
      kdfIterations: kdfParams.kdf_iterations,
      kdfMemory: kdfParams.kdf_memory,  // Argon2id memory parameter
      encryptedMasterKey: data.encrypted_master_key,
      masterKeyIV: kdfParams.kdf_iv || data.kdf_iv,
    };
    setZkData(zkDataObj);

    // Check if recovery is enabled
    if (data.recovery_enabled) {
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

    return data;
  };

  /**
   * Unlock ZK session (e.g., after session timeout)
   * Includes rate limiting to prevent brute force attacks
   * @param {string} password - User password
   * @returns {boolean} True if unlock successful
   */
  const unlockSession = async (password) => {
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
      if (error.message?.includes('Decryption failed') || error.message?.includes('Invalid password')) {
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
  const lockSession = () => {
    lockZKSession();
    setZkSessionUnlocked(false);
    setShowUnlockModal(true);
  };

  /**
   * Setup recovery phrase for account recovery
   * @param {boolean} skipSessionCheck - Skip session check (used during registration when session is unlocked but state not updated)
   * @returns {Promise<Object>} { recoveryPhrase, success }
   */
  const setupRecoveryPhrase = async (skipSessionCheck = false) => {
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
   * @param {string} recoveryPhrase - Recovery phrase to verify
   * @returns {Promise<boolean>} True if valid
   */
  const verifyRecoveryPhrase = async (recoveryPhrase) => {
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
   * @param {string} email - User email
   * @param {string} recoveryPhrase - Recovery phrase
   * @returns {Promise<Object>} Recovery result
   */
  const recoverAccount = async (email, recoveryPhrase) => {
    // Validate recovery phrase format (async)
    if (!await verifyRecoveryPhraseZK(recoveryPhrase)) {
      throw new Error('Invalid recovery phrase format');
    }

    // Call backend to get encrypted master key
    const data = await zkAuthService.recoverAccount(email, recoveryPhrase);

    // Recover master key from recovery phrase (async)
    const recovered = await recoverMasterKeyFromPhrase(
      recoveryPhrase,
      data.recovery_encrypted_master_key,
      data.recovery_iv || data.kdf_iv
    );

    if (!recovered) {
      throw new Error('Failed to recover account. Invalid recovery phrase.');
    }

    // Set user data and auth state
    setUser(data.user || { id: data.user_id, email });
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);
    setZkRecoveryEnabled(true);

    // Store ZK data for session
    setZkData({
      kdfSalt: data.kdf_salt,
      kdfIterations: data.kdf_iterations,
      encryptedMasterKey: data.encrypted_master_key || data.recovery_encrypted_master_key,
      masterKeyIV: data.kdf_iv || data.recovery_iv,
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

    return data;
  };

  /**
   * Check ZK status for current user
   * @returns {Promise<Object>} ZK status
   */
  const checkZKStatus = async () => {
    try {
      const status = await zkAuthService.getZKStatus();

      setZkEnabled(status.zk_enabled || false);
      // Backend returns 'recovery_phrase_enabled', not 'recovery_enabled'
      setZkRecoveryEnabled(status.recovery_phrase_enabled || false);

      return status;
    } catch (error) {
      console.error('Failed to check ZK status:', error);
      return null;
    }
  };

  const value = {
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
