/**
 * Normal Auth Context - Standard Mode
 *
 * Standard authentication with server-side password validation.
 * - Traditional login/register
 * - Session token management
 * - WebSocket connection management
 * - OAuth support (ready for future implementation)
 */

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { authService, type UserProfile } from '../../services/authService';
import { websocketService } from '../../services/websocketService';
import type { User, LoginResponse, NormalAuthContextValue } from './types';

const NormalAuthContext = createContext<NormalAuthContextValue | undefined>(undefined);

/**
 * Convert UserProfile to User type (adds index signature)
 */
const userProfileToUser = (profile: UserProfile): User => {
  const user: User = {
    id: profile.id,
    email: profile.email,
    username: profile.username,
    user_type: profile.user_type,
    created_at: profile.created_at,
    // Add extra properties via index signature
    plan_type: profile.plan_type,
    storage_quota: profile.storage_quota,
    storage_used: profile.storage_used,
  };

  // Add optional properties only if defined
  if (profile.zk_enabled !== undefined) {
    user.zk_enabled = profile.zk_enabled;
  }
  if (profile.theme !== undefined) {
    user.theme = profile.theme;
  }

  return user;
};

export const useNormalAuth = (): NormalAuthContextValue => {
  const context = useContext(NormalAuthContext);
  if (!context) {
    throw new Error('useNormalAuth must be used within NormalAuthProvider');
  }
  return context;
};

interface NormalAuthProviderProps {
  children: React.ReactNode;
}

export const NormalAuthProvider: React.FC<NormalAuthProviderProps> = ({ children }) => {
  // User state
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [token, setToken] = useState<string | null>(null);

  // WebSocket management
  const wsUnsubscribersRef = useRef<Array<() => void>>([]);

  // ==================== WEBSOCKET MANAGEMENT ====================

  const setupWebSocketListeners = (): void => {
    console.log('[Normal] Setting up WebSocket listeners...');

    // File uploaded event
    const unsubFileUploaded = websocketService.on('file_uploaded', (data: unknown) => {
      console.log('[Normal] WS: File uploaded', data);
      window.dispatchEvent(new CustomEvent('ws-file-uploaded', { detail: data }));
    });

    // File deleted event
    const unsubFileDeleted = websocketService.on('file_deleted', (data: unknown) => {
      console.log('[Normal] WS: File deleted', data);
      window.dispatchEvent(new CustomEvent('ws-file-deleted', { detail: data }));
    });

    // Storage update event
    const unsubStorageUpdate = websocketService.on('storage_updated', (data: unknown) => {
      console.log('[Normal] WS: Storage updated', data);
      window.dispatchEvent(new CustomEvent('ws-storage-update', { detail: data }));
    });

    // Error event
    const unsubError = websocketService.on('error', (error: unknown) => {
      console.error('[Normal] WS: Error', error);
    });

    // Disconnected event
    const unsubDisconnected = websocketService.on('disconnected', () => {
      console.log('[Normal] WS: Disconnected');
    });

    // Store unsubscribe functions
    wsUnsubscribersRef.current = [
      unsubFileUploaded,
      unsubFileDeleted,
      unsubStorageUpdate,
      unsubError,
      unsubDisconnected,
    ];
  };

  const removeWebSocketListeners = (): void => {
    console.log('[Normal] Removing WebSocket listeners...');
    wsUnsubscribersRef.current.forEach((unsubscribe) => unsubscribe());
    wsUnsubscribersRef.current = [];
  };

  // ==================== BOOTSTRAP ====================

  useEffect(() => {
    const initializeNormalAuth = async (): Promise<void> => {
      try {
        console.log('[Normal] Bootstrapping normal auth...');

        // Try to get user profile (checks HTTP-only cookie)
        try {
          const userProfile = await authService.getProfile();
          setUser(userProfileToUser(userProfile));
          setIsAuthenticated(true);

          // Get session token for API calls
          const sessionToken = await refreshSessionToken();
          if (sessionToken) {
            setToken(sessionToken);
          }

          // Set up WebSocket
          if (!websocketService.isConnected) {
            websocketService.connect();
            setupWebSocketListeners();
          }
        } catch (error) {
          console.log('[Normal] No active session found');
          // No active session - user needs to log in
        }
      } catch (error) {
        console.error('[Normal] Bootstrap error:', error);
      } finally {
        setLoading(false);
      }
    };

    void initializeNormalAuth();

    // Cleanup on unmount
    return () => {
      removeWebSocketListeners();
      if (websocketService.isConnected) {
        websocketService.disconnect();
      }
    };
  }, []);

  // ==================== SESSION TOKEN ====================

  const refreshSessionToken = async (): Promise<string | null> => {
    try {
      const response = await authService.getSessionToken();
      const sessionToken = response.session_token;
      setToken(sessionToken);
      return sessionToken;
    } catch (error) {
      console.error('[Normal] Failed to refresh session token:', error);
      return null;
    }
  };

  // ==================== REGISTRATION ====================

  const register = async (
    email: string,
    password: string,
    username: string,
    userType: string,
    planCode?: string
  ): Promise<LoginResponse> => {
    console.log('[Normal] Starting registration...');

    try {
      const response = await authService.register(email, password, username, userType, planCode);

      setUser(response.user ? userProfileToUser(response.user) : null);
      setIsAuthenticated(true);

      // Get session token if not provided
      if (!response.access_token) {
        const sessionToken = await refreshSessionToken();
        if (sessionToken) {
          setToken(sessionToken);
        }
      } else {
        setToken(response.access_token);
      }

      // Set up WebSocket
      if (!websocketService.isConnected) {
        websocketService.connect();
        setupWebSocketListeners();
      }

      console.log('[Normal] Registration successful');

      // Convert AuthResponse to LoginResponse
      const loginResponse: LoginResponse = {
        access_token: response.access_token,
        token_type: response.token_type,
      };

      if (response.user) {
        loginResponse.user = userProfileToUser(response.user);
      }

      return loginResponse;
    } catch (error) {
      console.error('[Normal] Registration failed:', error);
      throw error;
    }
  };

  // ==================== LOGIN ====================

  const login = async (email: string, password: string): Promise<LoginResponse> => {
    console.log('[Normal] Starting login...');

    try {
      const response = await authService.login(email, password);

      setUser(response.user ? userProfileToUser(response.user) : null);
      setIsAuthenticated(true);

      // Get session token if not provided
      if (!response.access_token) {
        const sessionToken = await refreshSessionToken();
        if (sessionToken) {
          setToken(sessionToken);
        }
      } else {
        setToken(response.access_token);
      }

      // Set up WebSocket
      if (!websocketService.isConnected) {
        websocketService.connect();
        setupWebSocketListeners();
      }

      console.log('[Normal] Login successful');

      // Convert AuthResponse to LoginResponse
      const loginResponse: LoginResponse = {
        access_token: response.access_token,
        token_type: response.token_type,
      };

      if (response.user) {
        loginResponse.user = userProfileToUser(response.user);
      }

      return loginResponse;
    } catch (error) {
      console.error('[Normal] Login failed:', error);
      throw error;
    }
  };

  // ==================== LOGOUT ====================

  const logout = async (): Promise<void> => {
    console.log('[Normal] Logging out...');

    try {
      // Remove WebSocket listeners
      removeWebSocketListeners();

      // Disconnect WebSocket
      if (websocketService.isConnected) {
        websocketService.disconnect();
      }

      // Call backend logout (clears HTTP-only cookie)
      await authService.logout();

      // Clear state
      setUser(null);
      setIsAuthenticated(false);
      setToken(null);

      console.log('[Normal] Logout complete');
    } catch (error) {
      console.error('[Normal] Logout error:', error);
      // Still clear state even if backend call fails
      setUser(null);
      setIsAuthenticated(false);
      setToken(null);
    }
  };

  // ==================== PROVIDER ====================

  const value: NormalAuthContextValue = {
    // User
    user,
    isAuthenticated,
    loading,
    token,

    // Methods
    login,
    register,
    logout,

    // Internal
    refreshSessionToken,
  };

  return <NormalAuthContext.Provider value={value}>{children}</NormalAuthContext.Provider>;
};

export default NormalAuthContext;
