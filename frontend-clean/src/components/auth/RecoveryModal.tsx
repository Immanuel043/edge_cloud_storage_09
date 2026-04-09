import React, { useState, useRef } from 'react';
import { Shield, Key, AlertCircle, RefreshCw, Check, X, Eye, EyeOff } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import RecoveryPhraseInput from './RecoveryPhraseInput';
import {
  verifyRecoveryPhrase,
  recoverMasterKeyFromPhrase,
  reEncryptMasterKeyWithNewPassword,
} from '../../services/zkEncryptionService';
import { getRecoveryInfo, recoverAccountWithNewPassword, type KDFParams } from '../../services/zkAuthService';
import type { RecoveryModalProps, RecoveryStep } from './types';
import { getErrorMessage } from './types';

/**
 * Recovery info from zkAuthService
 */
interface ZKRecoveryInfo {
  recovery_enabled: boolean;
  recovery_encrypted_master_key: string;
  kdf_params: KDFParams;
}

/**
 * Extended recovery info with recovery phrase for step 2
 */
interface RecoveryInfoWithPhrase extends ZKRecoveryInfo {
  recoveryPhrase: string;
}

/**
 * RecoveryModal Component
 *
 * Allows users to recover their ZK account using their 24-word recovery phrase.
 * This is shown when clicking "Forgot password?" on the login page.
 *
 * Recovery Flow:
 * 1. User enters email and recovery phrase
 * 2. Fetch recovery info (encrypted master key) from backend
 * 3. Client decrypts master key using recovery phrase
 * 4. User sets new password
 * 5. Client re-encrypts master key with new password
 * 6. Backend updates with new encrypted master key and password hash
 */
const RecoveryModal: React.FC<RecoveryModalProps> = ({
  isOpen,
  onClose,
  onRecoveryComplete,
  initialEmail,
}) => {
  const { darkMode } = useTheme();
  const [step, setStep] = useState<RecoveryStep>(1);
  const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(24).fill(''));
  const [email, setEmail] = useState<string>(initialEmail || '');
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [recovered, setRecovered] = useState<boolean>(false);
  const [showNewPassword, setShowNewPassword] = useState<boolean>(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState<boolean>(false);

  // Store recovery info for step 2
  const [recoveryInfo, setRecoveryInfo] = useState<RecoveryInfoWithPhrase | null>(null);

  // Refs for focus management
  const emailRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handlePhraseSubmit = async (
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Get recovery phrase as string
      const recoveryPhrase = recoveryWords.join(' ').toLowerCase().trim();

      // Validate recovery phrase format (24 valid BIP39 words)
      const isValidPhrase = await verifyRecoveryPhrase(recoveryPhrase);
      if (!isValidPhrase) {
        setError('Invalid recovery phrase. Please check all words are correct BIP39 words.');
        setLoading(false);
        return;
      }

      // Validate email
      if (!email || !email.includes('@')) {
        setError('Please enter a valid email address.');
        setLoading(false);
        return;
      }

      // Fetch recovery info from backend
      const info = await getRecoveryInfo(email);

      if (!info.recovery_enabled) {
        setError('Recovery phrase is not enabled for this account.');
        setLoading(false);
        return;
      }

      // Try to recover master key client-side
      const recoveredKey = await recoverMasterKeyFromPhrase(
        recoveryPhrase,
        info.recovery_encrypted_master_key,
        info.kdf_params?.kdf_iv ?? ''
      );

      if (!recoveredKey) {
        setError('Invalid recovery phrase. The phrase does not match this account.');
        setLoading(false);
        return;
      }

      // Store recovery info for step 2
      setRecoveryInfo({
        ...info,
        recoveryPhrase,
      });

      setStep(2);
    } catch (err: unknown) {
      console.error('Recovery step 1 error:', err);
      const errorMessage = getErrorMessage(err);
      if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        setError('No account found with this email address.');
      } else if (errorMessage.includes('not enabled')) {
        setError('Recovery phrase is not enabled for this account.');
      } else {
        setError(errorMessage || 'Failed to verify recovery phrase. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    e.preventDefault();
    setError('');

    // Validate passwords
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      // Re-encrypt master key with new password
      // This generates new KDF salt and encrypts the master key
      const newZkData = await reEncryptMasterKeyWithNewPassword(newPassword);

      if (!recoveryInfo) {
        throw new Error('Recovery info not available');
      }

      // Send recovery request to backend with new credentials
      // TODO: Implement client-side recovery key derivation. Currently the recovery
      // phrase is needed server-side for account recovery verification. A proper ZK
      // implementation would derive the master key from the phrase client-side and
      // only send encrypted artifacts to the server. The recovery_phrase should be
      // removed from the payload once the backend supports verification via a
      // recovery_phrase_hash instead of the raw phrase.
      const result = await recoverAccountWithNewPassword({
        email,
        recoveryPhrase: recoveryInfo.recoveryPhrase,
        newPasswordHash: newZkData.passwordHash,
        newEncryptedMasterKey: newZkData.encryptedMasterKey,
        newKdfSalt: newZkData.kdfSalt,
      });

      console.log('Account recovery successful:', result.message);

      setRecovered(true);
      setStep(3);

      // Auto-close and notify parent after 2 seconds
      setTimeout(() => {
        onRecoveryComplete?.({
          email,
          newPassword,
          accessToken: result.access_token,
        });
        handleClose();
      }, 2000);
    } catch (err: unknown) {
      console.error('Recovery step 2 error:', err);
      setError(getErrorMessage(err) || 'Recovery failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (): void => {
    setStep(1);
    setRecoveryWords(Array(24).fill(''));
    setEmail('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setRecovered(false);
    setLoading(false);
    setRecoveryInfo(null);
    onClose();
  };

  const handleBack = (): void => {
    if (step > 1 && !loading) {
      setStep((step - 1) as RecoveryStep);
      setError('');
    }
  };

  // Check if all recovery words are filled
  const allWordsFilled = recoveryWords.every((word) => word && word.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        className={`w-full max-w-2xl rounded-2xl shadow-2xl border ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
      >
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`p-3 rounded-xl ${
                  recovered
                    ? 'bg-gradient-to-br from-green-500 to-emerald-600'
                    : 'bg-gradient-to-br from-blue-500 to-purple-600'
                }`}
              >
                {recovered ? (
                  <Check className="text-white" size={24} />
                ) : (
                  <Shield className="text-white" size={24} />
                )}
              </div>
              <div>
                <h2
                  className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}
                >
                  {recovered ? 'Account Recovered!' : 'Recover Account'}
                </h2>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {recovered
                    ? 'Your account has been recovered successfully'
                    : step === 1
                      ? 'Enter your 24-word recovery phrase'
                      : 'Set a new password'}
                </p>
              </div>
            </div>
            {!loading && !recovered && (
              <button
                onClick={handleClose}
                className={`p-2 rounded-lg transition-colors ${
                  darkMode
                    ? 'hover:bg-gray-700 text-gray-400'
                    : 'hover:bg-gray-100 text-gray-600'
                }`}
              >
                <X size={20} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[70vh] overflow-y-auto">
          {!recovered && (
            <>
              {/* Warning */}
              <div
                className={`mb-6 p-4 rounded-xl border ${
                  darkMode
                    ? 'bg-blue-900/20 border-blue-600/40'
                    : 'bg-blue-50 border-blue-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-blue-500 flex-shrink-0" size={20} />
                  <p className={`text-sm ${darkMode ? 'text-blue-300' : 'text-blue-800'}`}>
                    {step === 1
                      ? 'Enter your 24-word recovery phrase to recover your account. All decryption happens locally on your device.'
                      : "Choose a strong password. You'll use this to access your encrypted files."}
                  </p>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  aria-live="polite"
                  className={`mb-6 p-4 rounded-xl border-2 ${
                    darkMode
                      ? 'bg-red-900/20 border-red-600/40'
                      : 'bg-red-50 border-red-400'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <AlertCircle className="text-red-500 flex-shrink-0" size={20} />
                    <p
                      className={`text-sm font-medium ${
                        darkMode ? 'text-red-300' : 'text-red-800'
                      }`}
                    >
                      {error}
                    </p>
                  </div>
                </div>
              )}

              {/* Step 1: Recovery Phrase */}
              {step === 1 && (
                <form onSubmit={(e) => void handlePhraseSubmit(e)} className="space-y-4">
                  <div>
                    <label
                      htmlFor="recovery-email"
                      className={`block text-sm font-medium mb-2 ${
                        darkMode ? 'text-gray-300' : 'text-gray-700'
                      }`}
                    >
                      Email Address
                    </label>
                    <input
                      ref={emailRef}
                      id="recovery-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setEmail(e.target.value)
                      }
                      required
                      autoFocus
                      disabled={loading}
                      aria-label="Email address for account recovery"
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

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
                      compact={false}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !allWordsFilled || !email}
                    className={`w-full py-3 rounded-xl font-semibold text-white transition-all ${
                      loading || !allWordsFilled || !email
                        ? 'bg-gray-500 cursor-not-allowed opacity-50'
                        : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                    }`}
                  >
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="animate-spin" size={18} />
                        Verifying...
                      </div>
                    ) : (
                      'Continue'
                    )}
                  </button>
                </form>
              )}

              {/* Step 2: New Password */}
              {step === 2 && (
                <form onSubmit={(e) => void handlePasswordSubmit(e)} className="space-y-4">
                  <div
                    className={`p-4 rounded-xl ${darkMode ? 'bg-green-900/20' : 'bg-green-50'}`}
                  >
                    <div className="flex items-center gap-2">
                      <Check className="text-green-500" size={18} />
                      <p
                        className={`text-sm font-medium ${
                          darkMode ? 'text-green-300' : 'text-green-800'
                        }`}
                      >
                        Recovery phrase verified! Your master key has been recovered.
                      </p>
                    </div>
                  </div>

                  {/* TODO: Add PasswordStrengthMeter component here (import from ./PasswordStrengthMeter)
                      to enforce strong passwords during account recovery */}
                  <div>
                    <label
                      htmlFor="newPassword"
                      className={`block text-sm font-medium mb-2 ${
                        darkMode ? 'text-gray-300' : 'text-gray-700'
                      }`}
                    >
                      New Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                        <Key
                          className={darkMode ? 'text-gray-500' : 'text-gray-400'}
                          size={18}
                        />
                      </div>
                      <input
                        ref={newPasswordRef}
                        id="newPassword"
                        type={showNewPassword ? 'text' : 'password'}
                        placeholder="Enter new password (min 8 characters)"
                        value={newPassword}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setNewPassword(e.target.value)
                        }
                        disabled={loading}
                        required
                        minLength={8}
                        autoFocus
                        aria-label="New password"
                        className={`w-full pl-11 pr-12 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        disabled={loading}
                        className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
                          darkMode
                            ? 'text-gray-400 hover:text-gray-200'
                            : 'text-gray-500 hover:text-gray-700'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                      >
                        {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="confirmNewPassword"
                      className={`block text-sm font-medium mb-2 ${
                        darkMode ? 'text-gray-300' : 'text-gray-700'
                      }`}
                    >
                      Confirm New Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                        <Key
                          className={darkMode ? 'text-gray-500' : 'text-gray-400'}
                          size={18}
                        />
                      </div>
                      <input
                        id="confirmNewPassword"
                        type={showConfirmPassword ? 'text' : 'password'}
                        placeholder="Re-enter new password"
                        value={confirmPassword}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setConfirmPassword(e.target.value)
                        }
                        disabled={loading}
                        required
                        minLength={8}
                        aria-label="Confirm new password"
                        className={`w-full pl-11 pr-12 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        disabled={loading}
                        className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
                          darkMode
                            ? 'text-gray-400 hover:text-gray-200'
                            : 'text-gray-500 hover:text-gray-700'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      >
                        {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    {/* Password match indicator */}
                    {confirmPassword && newPassword === confirmPassword && (
                      <p className="mt-1 text-sm text-green-500 flex items-center gap-1">
                        <Check size={14} /> Passwords match
                      </p>
                    )}
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={handleBack}
                      disabled={loading}
                      className={`flex-1 px-6 py-3 rounded-xl font-medium transition-all ${
                        darkMode
                          ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={loading || newPassword.length < 8 || newPassword !== confirmPassword}
                      className={`flex-1 px-6 py-3 rounded-xl font-semibold text-white transition-all ${
                        loading || newPassword.length < 8 || newPassword !== confirmPassword
                          ? 'bg-gray-600 cursor-not-allowed opacity-50'
                          : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                      }`}
                    >
                      {loading ? (
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="animate-spin" size={18} />
                          Recovering...
                        </div>
                      ) : (
                        'Recover Account'
                      )}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}

          {/* Success State */}
          {recovered && (
            <div className="text-center py-8">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 mb-4">
                <Check className="text-white" size={40} />
              </div>
              <p
                className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}
              >
                Account Recovered Successfully!
              </p>
              <p className={`text-sm mt-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                You can now log in with your new password.
              </p>
            </div>
          )}
        </div>

        {/* Footer with Security Note */}
        {!recovered && (
          <div className={`p-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-start gap-2">
              <Shield
                className={`flex-shrink-0 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}
                size={16}
              />
              <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                Your recovery phrase is never sent to our servers. All decryption happens on
                your device.
                {step === 2 &&
                  " Your new password will be used to re-encrypt your master key."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RecoveryModal;
