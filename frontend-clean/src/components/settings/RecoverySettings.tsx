import React, { useState, useEffect } from 'react';
import {
  Shield,
  RefreshCw,
  AlertTriangle,
  Check,
  Key,
  AlertCircle,
  Copy,
  Download,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { generateRecoveryPhraseData } from '../../services/zkEncryptionService';
import type { RecoveryPhraseData } from './types';
import { rotateRecoveryPhrase } from '../../services/zkAuthService';
import RecoveryPhraseSetup from '../auth/RecoveryPhraseSetup';

/**
 * Type guard for error with message property
 */
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Extract error message from unknown error
 */
function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
}

/**
 * RecoverySettings Component
 *
 * Settings panel for managing recovery phrase:
 * - View recovery status (enabled/disabled, last rotation date)
 * - Rotate (replace) recovery phrase
 * - Setup recovery phrase if not enabled
 */
const RecoverySettings: React.FC = () => {
  const { darkMode } = useTheme();
  const { zkRecoveryEnabled, setupRecoveryPhrase, checkZKStatus } = useAuth();
  const [statusLoading, setStatusLoading] = useState<boolean>(true);

  // Fetch latest recovery status on mount
  useEffect(() => {
    let mounted = true;
    const fetchStatus = async (): Promise<void> => {
      try {
        if (checkZKStatus) {
          await checkZKStatus();
        }
      } catch (err: unknown) {
        console.error('Failed to fetch ZK status:', getErrorMessage(err));
      } finally {
        if (mounted) {
          setStatusLoading(false);
        }
      }
    };
    void fetchStatus();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // State
  const [showRotateModal, setShowRotateModal] = useState<boolean>(false);
  const [showSetupModal, setShowSetupModal] = useState<boolean>(false);
  const [setupPhrase, setSetupPhrase] = useState<string>('');
  const [newPhrase, setNewPhrase] = useState<string>('');
  const [phraseVisible, setPhraseVisible] = useState<boolean>(false);
  const [phraseCopied, setPhraseCopied] = useState<boolean>(false);
  const [phraseDownloaded, setPhraseDownloaded] = useState<boolean>(false);
  const [confirmStep, setConfirmStep] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');

  // Handle initial setup of recovery phrase
  const handleSetupPhrase = async (): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      if (!setupRecoveryPhrase) {
        throw new Error('Recovery phrase setup is not available');
      }
      // Call the AuthContext setupRecoveryPhrase function
      const result = await setupRecoveryPhrase();
      if (result && result.recoveryPhrase) {
        setSetupPhrase(result.recoveryPhrase);
        setShowSetupModal(true);
      }
    } catch (err: unknown) {
      console.error('Failed to setup recovery phrase:', getErrorMessage(err));
      setError(getErrorMessage(err) || 'Failed to setup recovery phrase.');
    } finally {
      setLoading(false);
    }
  };

  // Handle setup confirmation (user has saved the phrase)
  const handleSetupConfirm = async (): Promise<void> => {
    setShowSetupModal(false);
    setSetupPhrase('');
    setSuccess('Recovery phrase set up successfully! Keep it safe.');
    if (checkZKStatus) {
      await checkZKStatus();
    }
  };

  // Handle setup skip (user wants to skip for now)
  const handleSetupSkip = (): void => {
    setShowSetupModal(false);
    setSetupPhrase('');
  };

  // Generate new recovery phrase and rotate
  const handleRotatePhrase = async (): Promise<void> => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      // Generate new recovery phrase data
      const recoveryData: RecoveryPhraseData = generateRecoveryPhraseData();

      // Store the new phrase to show to user
      setNewPhrase(recoveryData.recoveryPhrase);
      setConfirmStep(true);
      setLoading(false);
    } catch (err: unknown) {
      console.error('Failed to generate new recovery phrase:', getErrorMessage(err));
      setError(getErrorMessage(err) || 'Failed to generate new recovery phrase.');
      setLoading(false);
    }
  };

  // Complete the rotation after user confirms they've saved the phrase
  const handleConfirmRotation = async (): Promise<void> => {
    if (!phraseCopied && !phraseDownloaded) {
      setError('Please copy or download your recovery phrase before continuing.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Generate recovery data again (we need the encrypted key and hash)
      const recoveryData: RecoveryPhraseData = generateRecoveryPhraseData();

      // Call API to rotate the phrase
      await rotateRecoveryPhrase(
        recoveryData.recoveryEncryptedMasterKey,
        recoveryData.recoveryPhraseHash
      );

      // Refresh ZK status
      if (checkZKStatus) {
        await checkZKStatus();
      }

      setSuccess('Recovery phrase rotated successfully! Your old phrase is now invalid.');
      setShowRotateModal(false);
      resetModalState();
    } catch (err: unknown) {
      console.error('Failed to rotate recovery phrase:', getErrorMessage(err));
      setError(getErrorMessage(err) || 'Failed to rotate recovery phrase.');
    } finally {
      setLoading(false);
    }
  };

  // Copy phrase to clipboard
  const handleCopyPhrase = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(newPhrase);
      setPhraseCopied(true);
      setTimeout(() => setPhraseCopied(false), 3000);
    } catch (err: unknown) {
      console.error('Failed to copy:', getErrorMessage(err));
    }
  };

  // Download phrase as text file
  const handleDownloadPhrase = (): void => {
    const content = `Recovery Phrase - KEEP THIS SAFE!\n\n${newPhrase}\n\nGenerated: ${new Date().toISOString()}\n\nWARNING: Anyone with this phrase can access your encrypted files.\nStore this in a secure location and never share it.`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recovery-phrase-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setPhraseDownloaded(true);
  };

  // Reset modal state
  const resetModalState = (): void => {
    setNewPhrase('');
    setPhraseVisible(false);
    setPhraseCopied(false);
    setPhraseDownloaded(false);
    setConfirmStep(false);
    setError('');
  };

  // Close modal
  const handleCloseModal = (): void => {
    if (confirmStep && !loading) {
      // Warn user if they haven't saved the phrase
      if (!phraseCopied && !phraseDownloaded) {
        const confirmed: boolean = window.confirm(
          'Are you sure? You have not saved your new recovery phrase. If you close now, you will need to generate a new one.'
        );
        if (!confirmed) {
          return;
        }
      }
    }
    setShowRotateModal(false);
    resetModalState();
  };

  return (
    <div
      className={`rounded-xl border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}
    >
      {/* Header */}
      <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600">
            <Shield className="text-white" size={20} />
          </div>
          <div>
            <h3
              className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}
            >
              Recovery Phrase
            </h3>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Manage your 24-word recovery phrase
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Success Message */}
        {success && (
          <div
            className={`p-4 rounded-xl border ${
              darkMode
                ? 'bg-green-900/20 border-green-600/40'
                : 'bg-green-50 border-green-300'
            }`}
          >
            <div className="flex items-center gap-3">
              <Check className="text-green-500" size={20} />
              <p className={`text-sm ${darkMode ? 'text-green-300' : 'text-green-800'}`}>
                {success}
              </p>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && !showRotateModal && (
          <div
            className={`p-4 rounded-xl border ${
              darkMode
                ? 'bg-red-900/20 border-red-600/40'
                : 'bg-red-50 border-red-400'
            }`}
          >
            <div className="flex items-center gap-3">
              <AlertCircle className="text-red-500" size={20} />
              <p className={`text-sm ${darkMode ? 'text-red-300' : 'text-red-700'}`}>{error}</p>
            </div>
          </div>
        )}

        {/* Status Card */}
        <div className={`p-4 rounded-xl ${darkMode ? 'bg-gray-900/50' : 'bg-gray-50'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {statusLoading ? (
                <>
                  <div
                    className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}
                  >
                    <RefreshCw className="animate-spin text-gray-500" size={18} />
                  </div>
                  <div>
                    <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Checking status...
                    </p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      Loading recovery phrase status
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div
                    className={`p-2 rounded-lg ${
                      zkRecoveryEnabled
                        ? 'bg-green-500/20 text-green-500'
                        : 'bg-yellow-500/20 text-yellow-500'
                    }`}
                  >
                    {zkRecoveryEnabled ? <Check size={18} /> : <AlertTriangle size={18} />}
                  </div>
                  <div>
                    <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {zkRecoveryEnabled ? 'Recovery Enabled' : 'Recovery Not Set Up'}
                    </p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      {zkRecoveryEnabled
                        ? 'Your account can be recovered using your 24-word phrase'
                        : 'Set up a recovery phrase to protect your account'}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Warning */}
        {zkRecoveryEnabled && (
          <div
            className={`p-4 rounded-xl border ${
              darkMode
                ? 'bg-yellow-900/20 border-yellow-600/40'
                : 'bg-yellow-50 border-yellow-300'
            }`}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={18} />
              <div>
                <p
                  className={`text-sm font-medium ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}
                >
                  Important Security Information
                </p>
                <p
                  className={`text-xs mt-1 ${darkMode ? 'text-yellow-400' : 'text-yellow-700'}`}
                >
                  Your recovery phrase is the only way to recover your account if you forget your
                  password. Keep it stored securely and never share it with anyone.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-3">
          {statusLoading ? (
            <button
              disabled
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium bg-gray-600 cursor-not-allowed opacity-50 text-white"
            >
              <RefreshCw className="animate-spin" size={18} />
              Loading...
            </button>
          ) : zkRecoveryEnabled ? (
            <button
              onClick={() => setShowRotateModal(true)}
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all ${
                darkMode
                  ? 'bg-gray-700 hover:bg-gray-600 text-white'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
              }`}
            >
              <RefreshCw size={18} />
              Rotate Recovery Phrase
            </button>
          ) : (
            <button
              onClick={() => void handleSetupPhrase()}
              disabled={loading}
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-white transition-all ${
                loading
                  ? 'bg-gray-600 cursor-not-allowed opacity-50'
                  : 'bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700'
              }`}
            >
              {loading ? (
                <>
                  <RefreshCw className="animate-spin" size={18} />
                  Setting up...
                </>
              ) : (
                <>
                  <Key size={18} />
                  Set Up Recovery Phrase
                </>
              )}
            </button>
          )}
        </div>

        {/* Info */}
        <div className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
          <p>
            <strong>Why rotate?</strong> If you believe your recovery phrase may have been
            compromised, rotating it will generate a new phrase and invalidate the old one.
          </p>
        </div>
      </div>

      {/* Rotate Modal */}
      {showRotateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div
            className={`w-full max-w-lg rounded-2xl shadow-2xl border ${
              darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
            }`}
          >
            {/* Modal Header */}
            <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600">
                  <RefreshCw className="text-white" size={24} />
                </div>
                <div>
                  <h2
                    className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}
                  >
                    {confirmStep ? 'Save Your New Recovery Phrase' : 'Rotate Recovery Phrase'}
                  </h2>
                  <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    {confirmStep
                      ? 'Write down or save your new phrase securely'
                      : 'This will generate a new recovery phrase'}
                  </p>
                </div>
              </div>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-4">
              {error && (
                <div
                  className={`p-4 rounded-xl border ${
                    darkMode
                      ? 'bg-red-900/20 border-red-600/40'
                      : 'bg-red-50 border-red-400'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <AlertCircle className="text-red-500" size={18} />
                    <p className={`text-sm ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                      {error}
                    </p>
                  </div>
                </div>
              )}

              {!confirmStep ? (
                <>
                  {/* Warning before rotation */}
                  <div
                    className={`p-4 rounded-xl border ${
                      darkMode
                        ? 'bg-red-900/20 border-red-600/40'
                        : 'bg-red-50 border-red-400'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={18} />
                      <div>
                        <p
                          className={`text-sm font-medium ${darkMode ? 'text-red-300' : 'text-red-800'}`}
                        >
                          Warning: This action cannot be undone
                        </p>
                        <p
                          className={`text-xs mt-1 ${darkMode ? 'text-red-400' : 'text-red-700'}`}
                        >
                          Your current recovery phrase will become invalid immediately. Make sure
                          you&apos;re ready to save a new one.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={handleCloseModal}
                      disabled={loading}
                      className={`flex-1 px-4 py-3 rounded-xl font-medium transition-all ${
                        darkMode
                          ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleRotatePhrase()}
                      disabled={loading}
                      className={`flex-1 px-4 py-3 rounded-xl font-semibold text-white transition-all ${
                        loading
                          ? 'bg-gray-600 cursor-not-allowed opacity-50'
                          : 'bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700'
                      }`}
                    >
                      {loading ? (
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="animate-spin" size={18} />
                          Generating...
                        </div>
                      ) : (
                        'Generate New Phrase'
                      )}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* Show new phrase */}
                  <div
                    className={`p-4 rounded-xl border ${
                      darkMode ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span
                        className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
                      >
                        Your New Recovery Phrase
                      </span>
                      <button
                        onClick={() => setPhraseVisible(!phraseVisible)}
                        className={`p-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                      >
                        {phraseVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <div
                      className={`font-mono text-sm p-3 rounded-lg ${
                        darkMode ? 'bg-gray-800' : 'bg-white'
                      } ${phraseVisible ? '' : 'filter blur-sm select-none'}`}
                    >
                      {newPhrase}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => void handleCopyPhrase()}
                      className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-medium transition-all ${
                        phraseCopied
                          ? 'bg-green-500/20 text-green-500 border border-green-500'
                          : darkMode
                            ? 'bg-gray-700 hover:bg-gray-600 text-white'
                            : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                      }`}
                    >
                      {phraseCopied ? <Check size={16} /> : <Copy size={16} />}
                      {phraseCopied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={handleDownloadPhrase}
                      className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-medium transition-all ${
                        phraseDownloaded
                          ? 'bg-green-500/20 text-green-500 border border-green-500'
                          : darkMode
                            ? 'bg-gray-700 hover:bg-gray-600 text-white'
                            : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                      }`}
                    >
                      {phraseDownloaded ? <Check size={16} /> : <Download size={16} />}
                      {phraseDownloaded ? 'Downloaded!' : 'Download'}
                    </button>
                  </div>

                  {/* Confirmation */}
                  <div className="flex gap-3 pt-4">
                    <button
                      onClick={handleCloseModal}
                      disabled={loading}
                      className={`flex-1 px-4 py-3 rounded-xl font-medium transition-all ${
                        darkMode
                          ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleConfirmRotation()}
                      disabled={loading || (!phraseCopied && !phraseDownloaded)}
                      className={`flex-1 px-4 py-3 rounded-xl font-semibold text-white transition-all ${
                        loading || (!phraseCopied && !phraseDownloaded)
                          ? 'bg-gray-600 cursor-not-allowed opacity-50'
                          : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
                      }`}
                    >
                      {loading ? (
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="animate-spin" size={18} />
                          Saving...
                        </div>
                      ) : (
                        'Confirm & Save'
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Setup Modal - Shows the RecoveryPhraseSetup component */}
      {showSetupModal && setupPhrase && (
        <RecoveryPhraseSetup
          recoveryPhrase={setupPhrase}
          onConfirm={() => void handleSetupConfirm()}
          onSkip={handleSetupSkip}
        />
      )}
    </div>
  );
};

export default RecoverySettings;
