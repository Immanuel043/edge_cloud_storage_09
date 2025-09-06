import React, { createContext, useState, useContext, useEffect } from 'react';
import { authService } from '../services/authService';

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

  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    if (savedToken) {
      setToken(savedToken);
      setIsAuthenticated(true);
      loadUserData(savedToken);
    }
    setLoading(false);
  }, []);

  const loadUserData = async (authToken) => {
    try {
      const userData = await authService.getProfile(authToken);
      setUser(userData);
    } catch (error) {
      console.error('Failed to load user data:', error);
      logout();
    }
  };

  const login = async (email, password) => {
    const data = await authService.login(email, password);
    setToken(data.access_token);
    localStorage.setItem('token', data.access_token);
    setUser(data.user);
    setIsAuthenticated(true);
    return data;
  };

  const register = async (email, password, username, userType) => {
    const data = await authService.register(email, password, username, userType);
    setToken(data.access_token);
    localStorage.setItem('token', data.access_token);
    setUser(data.user);
    setIsAuthenticated(true);
    return data;
  };

  const logout = () => {
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