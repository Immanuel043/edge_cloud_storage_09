import React, { useState, useEffect } from 'react';
import { Lock, Unlock, AlertCircle, Key, ArrowLeft, Shield } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import RecoveryPhraseInput from './RecoveryPhraseInput';
import {
  verifyRecoveryPhrase,
  recoverMasterKeyFromPhrase,
} from '../../services/zkEncryptionService';
import { getRecoveryInfo } from '../../services/zkAuthService';
import type { SessionUnlockModalProps, UnlockMode } from './types';
import { getErrorMessage } from './types';

/**
 * SessionUnlockModal Component
 *
 * Shown when the user's ZK encryption session expires or is manually locked.
 * Supports two unlock methods:
 * 1. Password - Standard unlock with user password
 * 2. Recovery Phrase - Emergency unlock using 24-word recovery phrase
 */
const SessionUnlockModal: React.FC<SessionUnlockModalProps> = ({ isOpen, onClose }) => {
  const { darkMode } = useTheme();
  const { unlockSession, user, zkRecoveryEnabled, checkZKStatus } = useAuth();

  // Mode state: 'password' or 'recovery'
  const [mode, setMode] = useState<UnlockMode>('password');

  // Local recovery status (fetched when modal opens)
  const [recoveryAvailable, setRecoveryAvailable] = useState<boolean>(zkRecoveryEnabled);
  const [checkingRecovery, setCheckingRecovery] = useState<boolean>(false);

  // Fetch recovery status when modal opens
  useEffect(() => {
    if (isOpen && !zkRecoveryEnabled) {
      const fetchRecoveryStatus = async (): Promise<void> => {
        setCheckingRecovery(true);
        try {
          const status = await checkZKStatus?.();
          if (status?.recovery_enabled) {
            setRecoveryAvailable(true);
          }
        } catch (err: unknown) {
          console.error('Failed to fetch recovery status:', getErrorMessage(err));
        } finally {
          setCheckingRecovery(false);
        }
      };
      void fetchRecoveryStatus();
    } else if (zkRecoveryEnabled) {
      setRecoveryAvailable(true);
    }
  }, [isOpen, zkRecoveryEnabled, checkZKStatus]);

  // Password unlock state
  const [password, setPassword] = useState<string>('');

  // Recovery unlock state
  const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(24).fill(''));

  // Shared state
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [unlocked, setUnlocked] = useState<boolean>(false);

  if (!isOpen) return null;

  const handlePasswordUnlock = async (
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const success = await unlockSession(password);
      if (success) {
        setUnlocked(true);
        setTimeout(() => {
          handleClose();
        }, 1000);
      } else {
        setError('Incorrect password. Please try again.');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Failed to unlock session. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRecoveryUnlock = async (
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Get recovery phrase as string
      const recoveryPhrase = recoveryWords.join(' ').toLowerCase().trim();

      // Validate recovery phrase format
      const isValidPhrase = await verifyRecoveryPhrase(recoveryPhrase);
      if (!isValidPhrase) {
        setError('Invalid recovery phrase. Please check all words are correct.');
        setLoading(false);
        return;
      }

      // Get recovery info from backend
      const email = user?.email;
      if (!email) {
        setError('Unable to determine user email.');
        setLoading(false);
        return;
      }

      const info = await getRecoveryInfo(email);

      if (!info.recovery_enabled) {
        setError('Recovery phrase is not enabled for this account.');
        setLoading(false);
        return;
      }

      // Try to recover master key client-side
      const recovered = await recoverMasterKeyFromPhrase(
        recoveryPhrase,
        info.recovery_encrypted_master_key,
        info.kdf_params?.kdf_iv ?? ''
      );

      if (!recovered) {
        setError('Invalid recovery phrase. The phrase does not match this account.');
        setLoading(false);
        return;
      }

      // Session is now unlocked (master key is in session)
      setUnlocked(true);
      setTimeout(() => {
        handleClose();
      }, 1000);
    } catch (err: unknown) {
      console.error('Recovery unlock error:', err);
      const errorMessage = getErrorMessage(err);
      if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        setError('Unable to fetch recovery information.');
      } else {
        setError(errorMessage || 'Failed to unlock with recovery phrase.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (): void => {
    onClose();
    // Reset state after close
    setTimeout(() => {
      setMode('password');
      setPassword('');
      setRecoveryWords(Array(24).fill(''));
      setUnlocked(false);
      setError('');
    }, 300);
  };

  const switchToRecovery = (): void => {
    setMode('recovery');
    setError('');
    setPassword('');
  };

  const switchToPassword = (): void => {
    setMode('password');
    setError('');
    setRecoveryWords(Array(24).fill(''));
  };

  // Check if all recovery words are filled
  const allWordsFilled = recoveryWords.every((word) => word && word.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        className={`w-full ${mode === 'recovery' ? 'max-w-2xl' : 'max-w-md'} rounded-2xl shadow-2xl border transition-all duration-300 ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
      >
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div
              className={`p-3 rounded-xl ${
                unlocked
                  ? 'bg-gradient-to-br from-green-500 to-emerald-600'
                  : 'bg-gradient-to-br from-yellow-500 to-orange-600'
              }`}
            >
              {unlocked ? (
                <Unlock className="text-white" size={24} />
              ) : (
                <Lock className="text-white" size={24} />
              )}
            </div>
            <div>
              <h2
                className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}
              >
                {unlocked ? 'Session Unlocked!' : 'Session Locked'}
              </h2>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {unlocked
                  ? 'Access granted'
                  : mode === 'password'
                    ? 'Enter password to continue'
                    : 'Enter recovery phrase to unlock'}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className={`p-6 ${mode === 'recovery' ? 'max-h-[70vh] overflow-y-auto' : ''}`}>
          {!unlocked ? (
            <>
              {/* Warning Banner */}
              <div
                className={`mb-6 p-4 rounded-xl border ${
                  darkMode
                    ? 'bg-yellow-900/20 border-yellow-600/40'
                    : 'bg-yellow-50 border-yellow-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-yellow-500 flex-shrink-0" size={20} />
                  <div>
                    <p
                      className={`text-sm font-medium ${
                        darkMode ? 'text-yellow-300' : 'text-yellow-800'
                      }`}
                    >
                      Your encryption session has been locked for security.
                    </p>
                    <p
                      className={`text-xs mt-1 ${
                        darkMode ? 'text-yellow-400' : 'text-yellow-700'
                      }`}
                    >
                      {mode === 'password'
                        ? 'Enter your password to decrypt your files and continue working.'
                        : 'Enter your 24-word recovery phrase to unlock your session.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Error Display */}
              {error && (
                <div
                  className={`mb-6 p-4 rounded-xl border-2 ${
                    darkMode
                      ? 'bg-red-900/20 border-red-600/40'
                      : 'bg-red-50 border-red-400'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <AlertCircle className="text-red-500 flex-shrink-0" size={20} />
                    <p className={`text-sm ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                      {error}
                    </p>
                  </div>
                </div>
              )}

              {/* Password Mode */}
              {mode === 'password' && (
                <form
                  onSubmit={(e) => void handlePasswordUnlock(e)}
                  className="space-y-4"
                >
                  {user && (
                    <div
                      className={`p-3 rounded-lg ${
                        darkMode ? 'bg-gray-900/50' : 'bg-gray-50'
                      }`}
                    >
                      <p
                        className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}
                      >
                        Logged in as
                      </p>
                      <p
                        className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}
                      >
                        {user.email || user.username}
                      </p>
                    </div>
                  )}

                  <div>
                    <label
                      className={`block text-sm font-medium mb-2 ${
                        darkMode ? 'text-gray-300' : 'text-gray-700'
                      }`}
                    >
                      Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                        <Key
                          className={darkMode ? 'text-gray-500' : 'text-gray-400'}
                          size={18}
                        />
                      </div>
                      <input
                        type="password"
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setPassword(e.target.value)
                        }
                        disabled={loading}
                        autoFocus
                        required
                        className={`w-full pl-11 pr-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !password}
                    className={`w-full py-3 rounded-xl font-semibold text-white transition-all ${
                      loading || !password
                        ? 'bg-gray-600 cursor-not-allowed opacity-50'
                        : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                    }`}
                  >
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Unlocking...
                      </div>
                    ) : (
                      'Unlock Session'
                    )}
                  </button>
                </form>
              )}

              {/* Recovery Mode */}
              {mode === 'recovery' && (
                <form
                  onSubmit={(e) => void handleRecoveryUnlock(e)}
                  className="space-y-4"
                >
                  {/* Back button */}
                  <button
                    type="button"
                    onClick={switchToPassword}
                    className={`flex items-center gap-2 text-sm font-medium ${
                      darkMode
                        ? 'text-gray-400 hover:text-gray-200'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <ArrowLeft size={16} />
                    Back to password
                  </button>

                  {user && (
                    <div
                      className={`p-3 rounded-lg ${
                        darkMode ? 'bg-gray-900/50' : 'bg-gray-50'
                      }`}
                    >
                      <p
                        className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}
                      >
                        Recovering session for
                      </p>
                      <p
                        className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}
                      >
                        {user.email || user.username}
                      </p>
                    </div>
                  )}

                  <div>
                    <label
                      className={`block text-sm font-medium mb-2 ${
                        darkMode ? 'text-gray-300' : 'text-gray-700'
                      }`}
                    >
                      24-Word Recovery Phrase
                    </label>
                    <RecoveryPhraseInput
                      value={recoveryWords}
                      onChange={setRecoveryWords}
                      disabled={loading}
                      darkMode={darkMode}
                      compact={true}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !allWordsFilled}
                    className={`w-full py-3 rounded-xl font-semibold text-white transition-all ${
                      loading || !allWordsFilled
                        ? 'bg-gray-600 cursor-not-allowed opacity-50'
                        : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                    }`}
                  >
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Verifying...
                      </div>
                    ) : (
                      'Unlock with Recovery Phrase'
                    )}
                  </button>
                </form>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 mb-4">
                <Unlock className="text-white" size={40} />
              </div>
              <p
                className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}
              >
                Session Unlocked!
              </p>
              <p className={`text-sm mt-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Your encryption keys are now available.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {!unlocked && mode === 'password' && (
          <div className={`p-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="text-center">
              <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                Can&apos;t remember your password?{' '}
                {checkingRecovery ? (
                  <span className="text-gray-400">Checking recovery options...</span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={switchToRecovery}
                      disabled={!recoveryAvailable}
                      className={`font-medium ${
                        recoveryAvailable
                          ? darkMode
                            ? 'text-blue-400 hover:text-blue-300'
                            : 'text-blue-600 hover:text-blue-700'
                          : 'text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      Use recovery phrase
                    </button>
                    {!recoveryAvailable && (
                      <span
                        className={`block mt-1 text-xs ${
                          darkMode ? 'text-gray-600' : 'text-gray-400'
                        }`}
                      >
                        (Recovery phrase not set up)
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {/* Recovery Mode Footer */}
        {!unlocked && mode === 'recovery' && (
          <div className={`p-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-start gap-2">
              <Shield
                className={`flex-shrink-0 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}
                size={16}
              />
              <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                Your recovery phrase is never sent to our servers. All decryption happens
                locally on your device.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionUnlockModal;
