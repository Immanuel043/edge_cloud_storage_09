// frontend-clean/src/contexts/AuthContext.jsx

import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { authService } from '../services/authService';
import { websocketService } from '../services/websocketService';

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
      const savedToken = localStorage.getItem('token');
      if (savedToken) {
        setToken(savedToken);
        setIsAuthenticated(true);

        try {
          // connect and register listeners after connect resolves
          await websocketService.connect(savedToken);
          if (!mounted) return;
          setupWebSocketListeners();
        } catch (error) {
          console.error('Failed to connect WebSocket on boot:', error);
          // don't force logout here; let subsequent API calls handle auth failure
        }

        // load user profile (non-blocking for WS)
        try {
          await loadUserData(savedToken);
        } catch (err) {
          console.error('Failed to load user data during bootstrap:', err);
          // if profile load fails, ensure cleanup
          logout();
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

  const login = async (email, password) => {
    const data = await authService.login(email, password);
    setToken(data.access_token);
    localStorage.setItem('token', data.access_token);
    setUser(data.user);
    setIsAuthenticated(true);

    // Connect WebSocket after successful login. Ensure we remove any previous listeners first.
    try {
      await websocketService.connect(data.access_token);
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after login:', error);
    }

    return data;
  };

  const register = async (email, password, username, userType) => {
    const data = await authService.register(email, password, username, userType);
    setToken(data.access_token);
    localStorage.setItem('token', data.access_token);
    setUser(data.user);
    setIsAuthenticated(true);

    // Connect WebSocket after successful registration
    try {
      await websocketService.connect(data.access_token);
      setupWebSocketListeners();
    } catch (error) {
      console.error('Failed to connect WebSocket after registration:', error);
    }

    return data;
  };

  const logout = () => {
    // Remove our listeners first
    removeWebSocketListeners();

    // Disconnect WebSocket before clearing auth
    if (websocketService.isConnected) {
      websocketService.disconnect();
    }

    setToken(null);
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    setUser(null);
  };

  const value = {
    user,
    isAuthenticated,
    loading,
    token,
    login,
    register,
    logout
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
