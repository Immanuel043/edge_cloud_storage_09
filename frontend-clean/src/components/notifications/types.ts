/**
 * Notifications Component Type Definitions
 *
 * Strict TypeScript types for notification components.
 * Following best practices:
 * - No `any` types
 * - Proper React types
 */

// ==================== Notification Types ====================

/**
 * Notification type (discriminated union)
 */
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

/**
 * Notification action button
 */
export interface NotificationAction {
  label: string;
  onClick: () => void;
}

/**
 * Notification object structure
 */
export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  action: NotificationAction | null;
  createdAt: number;
}

// ==================== NotificationToast Types ====================

/**
 * NotificationItem component props
 */
export interface NotificationItemProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}
