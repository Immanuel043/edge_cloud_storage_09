import React, { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useNotification } from '../../contexts/NotificationContext';
import type { NotificationItemProps } from './types';

/**
 * NotificationToast Component
 *
 * Displays a stack of toast notifications in the top-right corner.
 * Automatically renders based on NotificationContext state.
 *
 * Features:
 * - Auto-dismiss after duration
 * - Manual dismiss button
 * - Action button support
 * - Slide-in animation
 * - Color-coded by type
 */
const NotificationToast: React.FC = () => {
  const { notifications, dismissNotification } = useNotification();

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2 pointer-events-none">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          onDismiss={dismissNotification}
        />
      ))}
    </div>
  );
};

/**
 * Individual notification item component
 *
 * Handles entrance/exit animations and displays notification content.
 */
function NotificationItem({ notification, onDismiss }: NotificationItemProps): React.ReactElement {
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [isLeaving, setIsLeaving] = useState<boolean>(false);

  useEffect(() => {
    // Trigger entrance animation
    setTimeout(() => setIsVisible(true), 10);
  }, []);

  const handleDismiss = (): void => {
    setIsLeaving(true);
    setTimeout(() => {
      onDismiss(notification.id);
    }, 300); // Match animation duration
  };

  /**
   * Get icon component based on notification type
   */
  const getIcon = (): React.ReactElement => {
    switch (notification.type) {
      case 'success':
        return <CheckCircle className="w-5 h-5 text-green-600" />;
      case 'error':
        return <XCircle className="w-5 h-5 text-red-600" />;
      case 'warning':
        return <AlertTriangle className="w-5 h-5 text-yellow-600" />;
      case 'info':
      default:
        return <Info className="w-5 h-5 text-blue-600" />;
    }
  };

  /**
   * Get border color class based on notification type
   */
  const getBorderColor = (): string => {
    switch (notification.type) {
      case 'success':
        return 'border-green-500';
      case 'error':
        return 'border-red-500';
      case 'warning':
        return 'border-yellow-500';
      case 'info':
      default:
        return 'border-blue-500';
    }
  };

  return (
    <div
      className={`
        pointer-events-auto
        bg-white rounded-lg shadow-lg p-4
        min-w-[320px] max-w-[400px]
        border-l-4 ${getBorderColor()}
        transform transition-all duration-300 ease-out
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="flex-shrink-0 mt-0.5">{getIcon()}</div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-900 leading-relaxed">{notification.message}</p>

          {/* Action Button */}
          {notification.action && (
            <button
              onClick={() => {
                notification.action?.onClick();
                handleDismiss();
              }}
              className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              {notification.action.label}
            </button>
          )}
        </div>

        {/* Dismiss Button */}
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Dismiss notification"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default NotificationToast;
