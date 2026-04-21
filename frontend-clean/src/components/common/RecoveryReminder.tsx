import React, { useState, useEffect } from 'react';
import { Shield, ArrowRight, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import type {
  RecoveryReminderProps,
  RecoveryReminderCompactProps,
  DismissData,
} from './types';
import { isDismissData } from './types';
import { Button } from '@/components/ui';

const REMINDER_DISMISS_KEY = 'zkRecoveryReminderDismissed';
const REMINDER_DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * RecoveryReminder — non-intrusive banner nudging ZK users without a
 * recovery phrase to set one up. Dismissal persists for 7 days via
 * localStorage so the reminder isn't nagging. The full component appears
 * above content; `RecoveryReminderCompact` is a sidebar-friendly button.
 * Both are rebuilt on Signal tokens (no more darkMode ternaries).
 */

function useRecoveryReminderVisibility(): [boolean, () => void] {
  const { zkEnabled, zkRecoveryEnabled, isAuthenticated } = useAuth();
  const [isDismissed, setIsDismissed] = useState<boolean>(true);

  useEffect(() => {
    if (!isAuthenticated || !zkEnabled || zkRecoveryEnabled) {
      setIsDismissed(true);
      return;
    }

    const dismissedDataRaw = localStorage.getItem(REMINDER_DISMISS_KEY);
    if (dismissedDataRaw) {
      try {
        const parsed: unknown = JSON.parse(dismissedDataRaw);
        if (isDismissData(parsed)) {
          if (Date.now() - parsed.timestamp < REMINDER_DISMISS_DURATION) {
            setIsDismissed(true);
            return;
          }
        }
      } catch (err: unknown) {
        console.warn('Failed to parse dismiss data:', err);
      }
    }

    setIsDismissed(false);
  }, [isAuthenticated, zkEnabled, zkRecoveryEnabled]);

  const dismiss = (): void => {
    setIsDismissed(true);
    const dismissData: DismissData = { timestamp: Date.now() };
    localStorage.setItem(REMINDER_DISMISS_KEY, JSON.stringify(dismissData));
  };

  const hidden = isDismissed || !isAuthenticated || !zkEnabled || zkRecoveryEnabled;
  return [hidden, dismiss];
}

export default function RecoveryReminder({
  onSetupClick,
}: RecoveryReminderProps): React.ReactElement | null {
  const [hidden, dismiss] = useRecoveryReminderVisibility();

  if (hidden) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-r from-accent/10 via-primary/10 to-info/10">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex flex-1 items-center gap-3">
          <div
            aria-hidden
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"
          >
            <Shield className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <h4 className="font-semibold text-fg">Protect your account</h4>
            </div>
            <p className="mt-0.5 text-body-sm text-fg-muted">
              Set up your recovery phrase so you never lose access to your encrypted files.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            rightIcon={<ArrowRight className="h-4 w-4" />}
            onClick={() => onSetupClick?.()}
          >
            Set up now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Dismiss reminder"
            onClick={dismiss}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RecoveryReminderCompact({
  onSetupClick,
}: RecoveryReminderCompactProps): React.ReactElement | null {
  const [hidden] = useRecoveryReminderVisibility();

  if (hidden) return null;

  return (
    <button
      type="button"
      onClick={onSetupClick}
      className="w-full rounded-xl border border-warning/40 bg-warning/10 p-3 text-left transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:shadow-focus"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-warning" />
        <div className="flex-1 min-w-0">
          <p className="text-body-sm font-medium text-fg">Set up recovery</p>
          <p className="truncate text-caption text-fg-muted">Protect your account</p>
        </div>
        <ArrowRight className="h-4 w-4 flex-shrink-0 text-warning" />
      </div>
    </button>
  );
}
