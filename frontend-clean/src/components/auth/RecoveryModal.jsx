import React, { useState } from 'react';
import { Shield, Key, AlertCircle, RefreshCw, Check, X } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * RecoveryModal Component
 *
 * Allows users to recover their ZK account using their 24-word recovery phrase.
 * This is shown when clicking "Forgot password?" on the login page.
 */
export default function RecoveryModal({ isOpen, onClose, onRecoveryComplete }) {
  const { darkMode } = useTheme();
  const [step, setStep] = useState(1); // 1: Enter phrase, 2: Enter new password, 3: Success
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recovered, setRecovered] = useState(false);

  if (!isOpen) return null;

  const handlePhraseSubmit = (e) => {
    e.preventDefault();
    setError('');

    // Validate recovery phrase (should be 24 words)
    const words = recoveryPhrase.trim().split(/\s+/);
    if (words.length !== 24) {
      setError('Recovery phrase must contain exactly 24 words.');
      return;
    }

    // Validate email
    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    setStep(2);
  };

  const handlePasswordSubmit = async (e) => {
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
      // TODO: Call recovery API endpoint
      // This should:
      // 1. Derive master key from recovery phrase
      // 2. Derive new encryption key from new password
      // 3. Re-encrypt master key with new password
      // 4. Update backend with new encrypted master key

      // Simulated recovery process
      await new Promise(resolve => setTimeout(resolve, 2000));

      setRecovered(true);
      setStep(3);

      // Auto-close and notify parent after 2 seconds
      setTimeout(() => {
        onRecoveryComplete({ email, newPassword });
        handleClose();
      }, 2000);
    } catch (err) {
      setError(err.message || 'Recovery failed. Please check your recovery phrase and try again.');
      setLoading(false);
    }
  };

  const handleClose = () => {
    setStep(1);
    setRecoveryPhrase('');
    setEmail('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setRecovered(false);
    setLoading(false);
    onClose();
  };

  const handleBack = () => {
    if (step > 1 && !loading) {
      setStep(step - 1);
      setError('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`w-full max-w-lg rounded-2xl shadow-2xl border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}>
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-xl ${
                recovered
                  ? 'bg-gradient-to-br from-green-500 to-emerald-600'
                  : 'bg-gradient-to-br from-blue-500 to-purple-600'
              }`}>
                {recovered ? <Check className="text-white" size={24} /> : <Shield className="text-white" size={24} />}
              </div>
              <div>
                <h2 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
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
                  darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-600'
                }`}
              >
                <X size={20} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {!recovered && (
            <>
              {/* Warning */}
              <div className={`mb-6 p-4 rounded-xl border ${
                darkMode ? 'bg-blue-900/20 border-blue-600/40' : 'bg-blue-50 border-blue-300'
              }`}>
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-blue-500 flex-shrink-0" size={20} />
                  <p className={`text-sm ${darkMode ? 'text-blue-300' : 'text-blue-800'}`}>
                    {step === 1
                      ? 'Enter your 24-word recovery phrase to recover your account. Make sure you have it saved securely.'
                      : 'Choose a strong password. You\'ll use this to access your encrypted files.'}
                  </p>
                </div>
              </div>

              {error && (
                <div className={`mb-6 p-4 rounded-xl border-2 ${
                  darkMode ? 'bg-red-900/20 border-red-600/40' : 'bg-red-50 border-red-400'
                }`}>
                  <div className="flex items-center gap-3">
                    <AlertCircle className="text-red-500 flex-shrink-0" size={20} />
                    <p className={`text-sm font-medium ${darkMode ? 'text-red-300' : 'text-red-800'}`}>
                      {error}
                    </p>
                  </div>
                </div>
              )}

              {/* Step 1: Recovery Phrase */}
              {step === 1 && (
                <form onSubmit={handlePhraseSubmit} className="space-y-4">
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Email Address
                    </label>
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoFocus
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      }`}
                    />
                  </div>

                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      24-Word Recovery Phrase
                    </label>
                    <textarea
                      placeholder="word1 word2 word3 ... word24"
                      value={recoveryPhrase}
                      onChange={(e) => setRecoveryPhrase(e.target.value)}
                      required
                      rows={4}
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      }`}
                    />
                    <p className={`text-xs mt-2 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                      {recoveryPhrase.trim().split(/\s+/).filter(w => w).length} / 24 words entered
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all hover:scale-[1.02]"
                  >
                    Continue
                  </button>
                </form>
              )}

              {/* Step 2: New Password */}
              {step === 2 && (
                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      New Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                        <Key className={darkMode ? 'text-gray-500' : 'text-gray-400'} size={18} />
                      </div>
                      <input
                        type="password"
                        placeholder="Enter new password (min 8 characters)"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        disabled={loading}
                        required
                        minLength={8}
                        autoFocus
                        className={`w-full pl-11 pr-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                    </div>
                  </div>

                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Confirm New Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                        <Key className={darkMode ? 'text-gray-500' : 'text-gray-400'} size={18} />
                      </div>
                      <input
                        type="password"
                        placeholder="Re-enter new password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        disabled={loading}
                        required
                        minLength={8}
                        className={`w-full pl-11 pr-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                    </div>
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
                      disabled={loading}
                      className={`flex-1 px-6 py-3 rounded-xl font-semibold text-white transition-all ${
                        loading
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
              <p className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
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
              <Shield className={`flex-shrink-0 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`} size={16} />
              <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                Your recovery phrase is never sent to our servers. All decryption happens on your device.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
