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

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (!mounted) return;

        try {
          console.log(`Bootstrap attempt ${attempt}/${MAX_RETRIES}...`);

          // Create abort controller for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

          try {
            const userData = await loadUserDataWithSignal(null, controller.signal);
            clearTimeout(timeoutId);

            if (!mounted) return;

            setIsAuthenticated(true);
            await refreshSessionToken();

            // Connect WebSocket (will use cookie or token from backend response)
            try {
              await websocketService.connect(null);
              if (!mounted) return;
              setupWebSocketListeners();
            } catch (error) {
              console.error('Failed to connect WebSocket on boot:', error);
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

    // Activity event listeners
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
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

  const loadUserData = async (authToken) => {
    try {
      const userData = await authService.getProfile(authToken);
      setUser(userData);
      setIsAuthenticated(true);
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

  const register = async (email, password, username, userType) => {
    const data = await authService.register(email, password, username, userType);

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
  const registerZK = async (email, password, username, userType = 'individual') => {
    // Generate ZK registration data (client-side encryption)
    const zkRegData = generateZKRegistrationData(password);

    // Send encrypted data to backend
    const data = await zkAuthService.registerZK({
      email,
      username,
      passwordHash: zkRegData.passwordHash,
      encryptedMasterKey: zkRegData.encryptedMasterKey,
      kdfSalt: zkRegData.kdfSalt,
      kdfAlgorithm: zkRegData.kdfAlgorithm,
      kdfIterations: zkRegData.kdfIterations,
    });

    // Set user data and auth state
    setUser(data.user || { id: data.user_id, email, username });
    setIsAuthenticated(true);
    setZkEnabled(true);
    setZkSessionUnlocked(true);

    // Store ZK data for session
    setZkData({
      kdfSalt: zkRegData.kdfSalt,
      kdfIterations: zkRegData.kdfIterations,
      encryptedMasterKey: zkRegData.encryptedMasterKey,
      masterKeyIV: zkRegData.masterKeyIV,
    });

    // Store ZK preferences in localStorage (non-sensitive data only)
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);

    // Connect WebSocket after successful registration
    try {
      await websocketService.connect(null);
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after ZK registration:', error);
    }

    await refreshSessionToken();

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

    // Derive password hash client-side
    const passwordHash = getPasswordHashForLogin(
      password,
      kdfParams.kdf_salt,
      kdfParams.kdf_iterations
    );

    // Login with hashed password
    const data = await zkAuthService.loginZK(email, passwordHash);

    // Unlock ZK session with the encrypted master key from backend
    const unlocked = unlockZKSession(password, {
      kdfSalt: kdfParams.kdf_salt,
      encryptedMasterKey: data.encrypted_master_key,
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
    setZkData({
      kdfSalt: kdfParams.kdf_salt,
      kdfIterations: kdfParams.kdf_iterations,
      encryptedMasterKey: data.encrypted_master_key,
      masterKeyIV: kdfParams.kdf_iv || data.kdf_iv,
    });

    // Check if recovery is enabled
    if (data.recovery_enabled) {
      setZkRecoveryEnabled(true);
      localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');
    }

    // Store ZK preferences in localStorage
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
    localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, email);

    // Connect WebSocket after successful login
    try {
      await websocketService.connect(null);
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after ZK login:', error);
    }

    await refreshSessionToken();

    return data;
  };

  /**
   * Unlock ZK session (e.g., after session timeout)
   * @param {string} password - User password
   * @returns {boolean} True if unlock successful
   */
  const unlockSession = async (password) => {
    if (!zkData) {
      throw new Error('No ZK data available. Please log in again.');
    }

    const unlocked = unlockZKSession(password, zkData);

    if (unlocked) {
      setZkSessionUnlocked(true);
      setShowUnlockModal(false);
      lastActivityRef.current = Date.now(); // Reset activity timer
      return true;
    }

    return false;
  };

  /**
   * Lock ZK session (manual lock or auto-lock on timeout)
   */
  const lockSession = () => {
    lockZKSession();
    setZkSessionUnlocked(false);
  };

  /**
   * Setup recovery phrase for account recovery
   * @returns {Promise<Object>} { recoveryPhrase, success }
   */
  const setupRecoveryPhrase = async () => {
    if (!zkSessionUnlocked) {
      throw new Error('Session must be unlocked to setup recovery phrase');
    }

    // Generate recovery phrase and encrypt master key with it
    const recoveryData = generateRecoveryPhraseData();

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
    // Client-side validation first
    if (!verifyRecoveryPhraseZK(recoveryPhrase)) {
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
    // Validate recovery phrase format
    if (!verifyRecoveryPhraseZK(recoveryPhrase)) {
      throw new Error('Invalid recovery phrase format');
    }

    // Call backend to get encrypted master key
    const data = await zkAuthService.recoverAccount(email, recoveryPhrase);

    // Recover master key from recovery phrase
    const recovered = recoverMasterKeyFromPhrase(
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
      setZkRecoveryEnabled(status.recovery_enabled || false);

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
