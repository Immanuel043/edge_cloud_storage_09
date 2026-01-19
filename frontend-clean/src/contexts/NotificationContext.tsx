import React, { createContext, useContext, useState, useCallback } from 'react';

type NotificationType = 'info' | 'success' | 'warning' | 'error';

interface NotificationAction {
  label: string;
  onClick: () => void;
}

interface NotificationOptions {
  duration?: number;
  action?: NotificationAction | null;
}

interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  action: NotificationAction | null;
  createdAt: number;
}

interface NotificationContextValue {
  notifications: Notification[];
  showNotification: (type: NotificationType, message: string, options?: NotificationOptions) => string;
  dismissNotification: (id: string) => void;
  clearAll: () => void;
  success: (message: string, options?: NotificationOptions) => string;
  error: (message: string, options?: NotificationOptions) => string;
  warning: (message: string, options?: NotificationOptions) => string;
  info: (message: string, options?: NotificationOptions) => string;
}

interface NotificationProviderProps {
  children: React.ReactNode;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

// Simple UUID generator
const generateId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

export const useNotification = (): NotificationContextValue => {
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
export function NotificationProvider({ children }: NotificationProviderProps): React.ReactElement {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  /**
   * Show a notification
   * @param type - 'info' | 'success' | 'warning' | 'error'
   * @param message - The notification message
   * @param options - Additional options
   * @param options.duration - Duration in ms (default: 5000)
   * @param options.action - Action button {label, onClick}
   */
  const showNotification = useCallback((type: NotificationType, message: string, options: NotificationOptions = {}): string => {
    const {
      duration = 5000,
      action = null
    } = options;

    const id = generateId();

    const notification: Notification = {
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
  const dismissNotification = useCallback((id: string): void => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  /**
   * Clear all notifications
   */
  const clearAll = useCallback((): void => {
    setNotifications([]);
  }, []);

  /**
   * Show a success notification (shorthand)
   */
  const success = useCallback((message: string, options?: NotificationOptions): string => {
    return showNotification('success', message, options);
  }, [showNotification]);

  /**
   * Show an error notification (shorthand)
   */
  const error = useCallback((message: string, options?: NotificationOptions): string => {
    return showNotification('error', message, options);
  }, [showNotification]);

  /**
   * Show a warning notification (shorthand)
   */
  const warning = useCallback((message: string, options?: NotificationOptions): string => {
    return showNotification('warning', message, options);
  }, [showNotification]);

  /**
   * Show an info notification (shorthand)
   */
  const info = useCallback((message: string, options?: NotificationOptions): string => {
    return showNotification('info', message, options);
  }, [showNotification]);

  const value: NotificationContextValue = {
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
