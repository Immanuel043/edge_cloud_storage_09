import React, { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useNotification } from '../../contexts/NotificationContext';
import type { NotificationItemProps, NotificationType } from './types';
import { cn } from '@/lib/cn';

/**
 * NotificationToast — stack of toast notifications anchored bottom-left.
 * Colour-coded by `NotificationType` via Signal semantic tokens so both
 * light and dark themes pick up the palette automatically.
 */
const NotificationToast: React.FC = () => {
  const { notifications, dismissNotification } = useNotification();

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex flex-col gap-2">
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

const toneMap: Record<
  NotificationType,
  { icon: React.ReactNode; border: string; iconColor: string }
> = {
  success: {
    icon: <CheckCircle className="h-5 w-5" />,
    border: 'border-l-success',
    iconColor: 'text-success',
  },
  error: {
    icon: <XCircle className="h-5 w-5" />,
    border: 'border-l-danger',
    iconColor: 'text-danger',
  },
  warning: {
    icon: <AlertTriangle className="h-5 w-5" />,
    border: 'border-l-warning',
    iconColor: 'text-warning',
  },
  info: {
    icon: <Info className="h-5 w-5" />,
    border: 'border-l-primary',
    iconColor: 'text-primary',
  },
};

function NotificationItem({ notification, onDismiss }: NotificationItemProps): React.ReactElement {
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [isLeaving, setIsLeaving] = useState<boolean>(false);

  useEffect(() => {
    const handle = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(handle);
  }, []);

  const handleDismiss = (): void => {
    setIsLeaving(true);
    setTimeout(() => {
      onDismiss(notification.id);
    }, 300);
  };

  const tone = toneMap[notification.type];

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto min-w-[320px] max-w-[400px] rounded-xl border border-border border-l-4 bg-surface-elevated p-4 shadow-lg',
        'transform transition-all duration-[300ms] ease-out',
        tone.border,
        isVisible && !isLeaving ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn('mt-0.5 flex-shrink-0', tone.iconColor)}>{tone.icon}</div>

        <div className="min-w-0 flex-1">
          <p className="text-body-sm leading-relaxed text-fg">{notification.message}</p>

          {notification.action && (
            <button
              onClick={() => {
                notification.action?.onClick();
                handleDismiss();
              }}
              className="mt-2 text-body-sm font-medium text-primary hover:text-primary/80"
            >
              {notification.action.label}
            </button>
          )}
        </div>

        <button
          onClick={handleDismiss}
          className="flex-shrink-0 text-fg-subtle transition-colors hover:text-fg-muted"
          aria-label="Dismiss notification"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default NotificationToast;
