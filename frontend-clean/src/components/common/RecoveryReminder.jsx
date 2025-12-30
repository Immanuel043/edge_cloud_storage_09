import React, { useState, useEffect } from 'react';
import { Shield, X, ArrowRight, AlertTriangle } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';

const REMINDER_DISMISS_KEY = 'zkRecoveryReminderDismissed';
const REMINDER_DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * RecoveryReminder Component
 *
 * A non-intrusive banner shown to users who haven't set up their recovery phrase.
 * Can be dismissed, but will reappear after a set period.
 */
export default function RecoveryReminder({ onSetupClick }) {
  const { darkMode } = useTheme();
  const { zkEnabled, zkRecoveryEnabled, isAuthenticated } = useAuth();
  const [isDismissed, setIsDismissed] = useState(true);

  // Check if reminder should be shown
  useEffect(() => {
    // Only show if user is authenticated, has ZK enabled, but no recovery phrase
    if (!isAuthenticated || !zkEnabled || zkRecoveryEnabled) {
      setIsDismissed(true);
      return;
    }

    // Check if user has previously dismissed the reminder
    const dismissedData = localStorage.getItem(REMINDER_DISMISS_KEY);
    if (dismissedData) {
      try {
        const { timestamp } = JSON.parse(dismissedData);
        const now = Date.now();
        // If still within dismiss duration, keep dismissed
        if (now - timestamp < REMINDER_DISMISS_DURATION) {
          setIsDismissed(true);
          return;
        }
      } catch (e) {
        // Invalid data, show reminder
      }
    }

    setIsDismissed(false);
  }, [isAuthenticated, zkEnabled, zkRecoveryEnabled]);

  const handleDismiss = () => {
    setIsDismissed(true);
    localStorage.setItem(REMINDER_DISMISS_KEY, JSON.stringify({
      timestamp: Date.now()
    }));
  };

  const handleSetupClick = () => {
    if (onSetupClick) {
      onSetupClick();
    }
  };

  // Don't render if dismissed or conditions not met
  if (isDismissed || !isAuthenticated || !zkEnabled || zkRecoveryEnabled) {
    return null;
  }

  return (
    <div className={`mb-4 rounded-xl border overflow-hidden ${
      darkMode
        ? 'bg-gradient-to-r from-purple-900/30 to-indigo-900/30 border-purple-600/40'
        : 'bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200'
    }`}>
      <div className="p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-1">
          <div className={`p-2 rounded-lg ${
            darkMode ? 'bg-purple-500/20' : 'bg-purple-100'
          }`}>
            <Shield className={`${darkMode ? 'text-purple-400' : 'text-purple-600'}`} size={20} />
          </div>

          <div className="flex-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className={`${darkMode ? 'text-yellow-400' : 'text-yellow-600'}`} size={16} />
              <h4 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Protect Your Account
              </h4>
            </div>
            <p className={`text-sm mt-0.5 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Set up your recovery phrase to ensure you never lose access to your encrypted files.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSetupClick}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all ${
              darkMode
                ? 'bg-purple-500 hover:bg-purple-600 text-white'
                : 'bg-purple-600 hover:bg-purple-700 text-white'
            }`}
          >
            Set Up Now
            <ArrowRight size={16} />
          </button>

          <button
            onClick={handleDismiss}
            className={`p-2 rounded-lg transition-colors ${
              darkMode
                ? 'hover:bg-gray-700 text-gray-400'
                : 'hover:bg-gray-100 text-gray-500'
            }`}
            aria-label="Dismiss reminder"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact version of the reminder for sidebar/narrow spaces
 */
export function RecoveryReminderCompact({ onSetupClick }) {
  const { darkMode } = useTheme();
  const { zkEnabled, zkRecoveryEnabled, isAuthenticated } = useAuth();
  const [isDismissed, setIsDismissed] = useState(true);

  useEffect(() => {
    if (!isAuthenticated || !zkEnabled || zkRecoveryEnabled) {
      setIsDismissed(true);
      return;
    }

    const dismissedData = localStorage.getItem(REMINDER_DISMISS_KEY);
    if (dismissedData) {
      try {
        const { timestamp } = JSON.parse(dismissedData);
        if (Date.now() - timestamp < REMINDER_DISMISS_DURATION) {
          setIsDismissed(true);
          return;
        }
      } catch (e) {
        // Invalid data
      }
    }

    setIsDismissed(false);
  }, [isAuthenticated, zkEnabled, zkRecoveryEnabled]);

  if (isDismissed || !isAuthenticated || !zkEnabled || zkRecoveryEnabled) {
    return null;
  }

  return (
    <button
      onClick={onSetupClick}
      className={`w-full p-3 rounded-xl text-left transition-all ${
        darkMode
          ? 'bg-yellow-900/20 hover:bg-yellow-900/30 border border-yellow-600/40'
          : 'bg-yellow-50 hover:bg-yellow-100 border border-yellow-200'
      }`}
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className={`${darkMode ? 'text-yellow-400' : 'text-yellow-600'} flex-shrink-0`} size={18} />
        <div className="flex-1 min-w-0">
          <p className={`font-medium text-sm ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}>
            Set Up Recovery
          </p>
          <p className={`text-xs truncate ${darkMode ? 'text-yellow-400' : 'text-yellow-700'}`}>
            Protect your account
          </p>
        </div>
        <ArrowRight className={`${darkMode ? 'text-yellow-400' : 'text-yellow-600'} flex-shrink-0`} size={16} />
      </div>
    </button>
  );
}
