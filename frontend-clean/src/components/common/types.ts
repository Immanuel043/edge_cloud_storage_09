/**
 * Common Components Type Definitions
 *
 * Strict TypeScript types for all common components.
 * Following best practices:
 * - No `any` types
 * - `unknown` at trust boundaries
 * - Explicit return types
 * - Proper React types
 */

import type React from 'react';

// ==================== ErrorBoundary Types ====================

/**
 * ErrorBoundary component props
 */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackMessage?: string;
}

/**
 * ErrorBoundary component state
 */
export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  errorCount: number;
}

/**
 * Window error logger interface (optional extension)
 */
export interface WindowErrorLogger {
  logError: (error: Error, errorInfo: React.ErrorInfo) => void;
}

/**
 * Extended Window interface with optional errorLogger
 */
declare global {
  interface Window {
    errorLogger?: WindowErrorLogger;
  }
}

// ==================== RecoveryReminder Types ====================

/**
 * RecoveryReminder component props
 */
export interface RecoveryReminderProps {
  onSetupClick?: () => void;
}

/**
 * RecoveryReminderCompact component props
 */
export interface RecoveryReminderCompactProps {
  onSetupClick?: () => void;
}

/**
 * LocalStorage dismiss data structure
 */
export interface DismissData {
  timestamp: number;
}

// ==================== Type Guards ====================

/**
 * Type guard for DismissData
 */
export function isDismissData(data: unknown): data is DismissData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'timestamp' in data &&
    typeof (data as { timestamp: unknown }).timestamp === 'number'
  );
}

/**
 * Type guard for WindowErrorLogger
 */
export function hasErrorLogger(window: Window): window is Window & { errorLogger: WindowErrorLogger } {
  return (
    'errorLogger' in window &&
    typeof window.errorLogger === 'object' &&
    window.errorLogger !== null &&
    'logError' in window.errorLogger &&
    typeof window.errorLogger.logError === 'function'
  );
}
