import React, { createContext, useContext, useState, useCallback } from 'react';

const NotificationContext = createContext();

// Simple UUID generator
const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

export const useNotification = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotification must be used within NotificationProvider');
  }
  return context;
};

/**
 * NotificationProvider
 *
 * Provides global notification system for the entire app.
 * Supports 4 types: info, success, warning, error
 *
 * Usage:
 *   const { showNotification } = useNotification();
 *   showNotification('success', 'File uploaded successfully!');
 *   showNotification('error', 'Upload failed', { duration: 10000 });
 */
export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);

  /**
   * Show a notification
   * @param {string} type - 'info' | 'success' | 'warning' | 'error'
   * @param {string} message - The notification message
   * @param {Object} options - Additional options
   * @param {number} options.duration - Duration in ms (default: 5000)
   * @param {Object} options.action - Action button {label, onClick}
   */
  const showNotification = useCallback((type, message, options = {}) => {
    const {
      duration = 5000,
      action = null
    } = options;

    const id = generateId();

    const notification = {
      id,
      type,
      message,
      action,
      createdAt: Date.now()
    };

    setNotifications(prev => [...prev, notification]);

    // Auto-dismiss after duration
    if (duration > 0) {
      setTimeout(() => {
        dismissNotification(id);
      }, duration);
    }

    return id;
  }, []);

  /**
   * Dismiss a specific notification
   */
  const dismissNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  /**
   * Clear all notifications
   */
  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  /**
   * Show a success notification (shorthand)
   */
  const success = useCallback((message, options) => {
    return showNotification('success', message, options);
  }, [showNotification]);

  /**
   * Show an error notification (shorthand)
   */
  const error = useCallback((message, options) => {
    return showNotification('error', message, options);
  }, [showNotification]);

  /**
   * Show a warning notification (shorthand)
   */
  const warning = useCallback((message, options) => {
    return showNotification('warning', message, options);
  }, [showNotification]);

  /**
   * Show an info notification (shorthand)
   */
  const info = useCallback((message, options) => {
    return showNotification('info', message, options);
  }, [showNotification]);

  const value = {
    notifications,
    showNotification,
    dismissNotification,
    clearAll,
    success,
    error,
    warning,
    info
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export default NotificationContext;
