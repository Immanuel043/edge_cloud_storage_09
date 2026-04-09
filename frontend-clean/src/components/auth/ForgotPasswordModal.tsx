import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Shield, Mail, KeyRound, Lock, Check, X, Eye, EyeOff, RefreshCw, Clock, AlertCircle, ArrowLeft } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { authService } from '../../services/authService';
import { validateEmail, validatePassword, validatePasswordStrength, type PasswordStrengthResult } from '../../utils/security';
import PasswordStrengthMeter from './PasswordStrengthMeter';
import { getErrorMessage } from './types';

type ForgotPasswordStep = 'email' | 'method' | 'code' | 'password' | 'success';

interface ForgotPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitchToRecovery: (email: string) => void;
  onResetComplete?: () => void;
}

const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
  onSwitchToRecovery,
  onResetComplete,
}) => {
  const { darkMode } = useTheme();
  const [step, setStep] = useState<ForgotPasswordStep>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState<string[]>(['', '', '', '', '', '']);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrengthResult | null>(null);

  // Code input timers
  const [timeLeft, setTimeLeft] = useState(30 * 60); // 30 minutes
  const [canResend, setCanResend] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const emailRef = useRef<HTMLInputElement>(null);

  // Countdown timer for code expiry
  useEffect(() => {
    if (step !== 'code') return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [step]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          setCanResend(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Password strength checking
  useEffect(() => {
    if (newPassword) {
      setPasswordStrength(validatePasswordStrength(newPassword));
    } else {
      setPasswordStrength(null);
    }
  }, [newPassword]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleClose = (): void => {
    setStep('email');
    setEmail('');
    setCode(['', '', '', '', '', '']);
    setResetToken('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setLoading(false);
    setPasswordStrength(null);
    onClose();
  };

  // Step 1: Submit email
  const handleEmailSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      await authService.forgotPassword(email);
      setStep('method');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [email]);

  // Code input handlers
  const handleCodeChange = (index: number, value: string): void => {
    if (value && !/^\d$/.test(value)) return;

    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);

    if (value && index < 5) {
      codeInputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (newCode.every((d) => d) && newCode.join('').length === 6) {
      void handleCodeSubmit(newCode.join(''));
    }
  };

  const handleCodeKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      codeInputRefs.current[index - 1]?.focus();
    }
  };

  const handleCodePaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '');
    if (pastedData.length === 6) {
      const newCode = pastedData.split('');
      setCode(newCode);
      codeInputRefs.current[5]?.focus();
      void handleCodeSubmit(pastedData);
    }
  };

  // Step 3: Verify code
  const handleCodeSubmit = async (codeString: string): Promise<void> => {
    setError('');
    setLoading(true);
    try {
      const result = await authService.forgotPasswordVerify(email, codeString);
      setResetToken(result.reset_token);
      setStep('password');
    } catch (err) {
      setError(getErrorMessage(err));
      setCode(['', '', '', '', '', '']);
      codeInputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  // Resend code
  const handleResend = async (): Promise<void> => {
    setCanResend(false);
    setResendCooldown(60);
    setCode(['', '', '', '', '', '']);
    setError('');
    try {
      await authService.forgotPassword(email);
      setTimeLeft(30 * 60);
    } catch (err) {
      setError(getErrorMessage(err));
    }
    codeInputRefs.current[0]?.focus();
  };

  // Step 4: Reset password
  const handlePasswordSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!validatePassword(newPassword)) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await authService.forgotPasswordReset(email, resetToken, newPassword);
      setStep('success');
      // Auto-close after 2 seconds
      setTimeout(() => {
        handleClose();
        onResetComplete?.();
      }, 2000);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [email, resetToken, newPassword, confirmPassword, onResetComplete]);

  if (!isOpen) return null;

  const stepTitle: Record<ForgotPasswordStep, string> = {
    email: 'Reset Password',
    method: 'Check Your Email',
    code: 'Enter Verification Code',
    password: 'Set New Password',
    success: 'Password Reset!',
  };

  const stepDescription: Record<ForgotPasswordStep, string> = {
    email: 'Enter your email to receive reset instructions',
    method: 'Choose how to reset your password',
    code: `We sent a code to ${email}`,
    password: 'Choose a strong new password',
    success: 'Your password has been reset successfully',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        className={`w-full max-w-md rounded-2xl shadow-2xl border ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
      >
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`p-3 rounded-xl ${
                  step === 'success'
                    ? 'bg-gradient-to-br from-green-500 to-emerald-600'
                    : 'bg-gradient-to-br from-blue-500 to-purple-600'
                }`}
              >
                {step === 'success' ? (
                  <Check className="text-white" size={24} />
                ) : step === 'password' ? (
                  <Lock className="text-white" size={24} />
                ) : step === 'code' ? (
                  <KeyRound className="text-white" size={24} />
                ) : (
                  <Mail className="text-white" size={24} />
                )}
              </div>
              <div>
                <h2 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {stepTitle[step]}
                </h2>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {stepDescription[step]}
                </p>
              </div>
            </div>
            {!loading && step !== 'success' && (
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
          {/* Error */}
          {error && (
            <div
              className={`mb-4 p-3 rounded-xl flex items-center gap-3 text-sm ${
                darkMode
                  ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                  : 'bg-red-50 border border-red-200 text-red-600'
              }`}
            >
              <AlertCircle size={16} className="flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Step 1: Email */}
          {step === 'email' && (
            <form onSubmit={(e) => void handleEmailSubmit(e)}>
              <div className="mb-4">
                <label
                  className={`block text-sm font-medium mb-2 ${
                    darkMode ? 'text-gray-300' : 'text-gray-700'
                  }`}
                >
                  Email Address
                </label>
                <input
                  ref={emailRef}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  autoFocus
                  className={`w-full px-4 py-3 rounded-xl border outline-none transition-all ${
                    darkMode
                      ? 'bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-blue-500'
                      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500'
                  }`}
                />
              </div>
              <button
                type="submit"
                disabled={loading || !email}
                className="w-full py-3 px-4 rounded-xl font-medium text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending...' : 'Send Reset Instructions'}
              </button>
            </form>
          )}

          {/* Step 2: Method Selection */}
          {step === 'method' && (
            <div className="space-y-3">
              <div
                className={`p-4 rounded-xl border ${
                  darkMode ? 'bg-blue-900/20 border-blue-600/40' : 'bg-blue-50 border-blue-200'
                }`}
              >
                <p className={`text-sm ${darkMode ? 'text-blue-300' : 'text-blue-800'}`}>
                  If your email is registered, you'll receive instructions. Check your inbox (and spam folder).
                </p>
              </div>

              <button
                onClick={() => {
                  setStep('code');
                  setTimeLeft(30 * 60);
                  setCanResend(false);
                  setResendCooldown(60);
                  setTimeout(() => codeInputRefs.current[0]?.focus(), 100);
                }}
                className={`w-full p-4 rounded-xl border text-left transition-all ${
                  darkMode
                    ? 'border-white/10 hover:border-blue-500/50 hover:bg-white/5'
                    : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
                    <KeyRound className={darkMode ? 'text-blue-400' : 'text-blue-600'} size={20} />
                  </div>
                  <div>
                    <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      I received a verification code
                    </p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      Enter the 6-digit code from your email
                    </p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => onSwitchToRecovery(email)}
                className={`w-full p-4 rounded-xl border text-left transition-all ${
                  darkMode
                    ? 'border-white/10 hover:border-purple-500/50 hover:bg-white/5'
                    : 'border-gray-200 hover:border-purple-300 hover:bg-purple-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${darkMode ? 'bg-purple-500/10' : 'bg-purple-50'}`}>
                    <Shield className={darkMode ? 'text-purple-400' : 'text-purple-600'} size={20} />
                  </div>
                  <div>
                    <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      I have a recovery phrase
                    </p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      Use your 24-word recovery phrase (ZK accounts)
                    </p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => setStep('email')}
                className={`flex items-center gap-2 text-sm transition-colors ${
                  darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <ArrowLeft size={16} />
                Back
              </button>
            </div>
          )}

          {/* Step 3: Code Entry */}
          {step === 'code' && (
            <div>
              {/* Back button */}
              <button
                onClick={() => { setStep('method'); setError(''); setCode(['', '', '', '', '', '']); }}
                className={`mb-4 flex items-center gap-2 text-sm transition-colors ${
                  darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <ArrowLeft size={16} />
                Back
              </button>

              {/* Code input boxes */}
              <div className="flex gap-3 justify-center mb-6">
                {code.map((digit, index) => (
                  <input
                    key={index}
                    ref={(el) => { codeInputRefs.current[index] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleCodeChange(index, e.target.value)}
                    onKeyDown={(e) => handleCodeKeyDown(index, e)}
                    onPaste={handleCodePaste}
                    disabled={loading}
                    className={`w-12 h-14 text-center text-2xl font-bold rounded-xl border-2 outline-none transition-all ${
                      darkMode
                        ? 'bg-white/5 border-white/10 text-white focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20'
                        : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 shadow-sm'
                    } ${digit ? (darkMode ? 'border-blue-500/50' : 'border-blue-500') : ''} ${
                      loading ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                    autoFocus={index === 0}
                  />
                ))}
              </div>

              {/* Timer */}
              {timeLeft > 0 && (
                <div className={`flex items-center justify-center gap-2 text-sm mb-4 ${
                  darkMode ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  <Clock size={16} />
                  <span>Code expires in {formatTime(timeLeft)}</span>
                </div>
              )}

              {/* Resend */}
              <div className="text-center">
                <p className={`text-sm mb-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Didn&apos;t receive the code?
                </p>
                <button
                  onClick={() => void handleResend()}
                  disabled={!canResend && resendCooldown > 0}
                  className={`inline-flex items-center gap-2 text-sm font-medium transition-colors ${
                    darkMode
                      ? 'text-blue-400 hover:text-blue-300 disabled:text-gray-600 disabled:cursor-not-allowed'
                      : 'text-blue-600 hover:text-blue-700 disabled:text-gray-400 disabled:cursor-not-allowed'
                  }`}
                >
                  <RefreshCw size={14} />
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                </button>
              </div>

              {/* Loading */}
              {loading && (
                <div className="mt-6 flex justify-center">
                  <div className={`w-6 h-6 border-2 rounded-full animate-spin ${
                    darkMode ? 'border-blue-500/30 border-t-blue-500' : 'border-blue-300 border-t-blue-600'
                  }`} />
                </div>
              )}
            </div>
          )}

          {/* Step 4: New Password */}
          {step === 'password' && (
            <form onSubmit={(e) => void handlePasswordSubmit(e)}>
              <div className="mb-4">
                <label className={`block text-sm font-medium mb-2 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  New Password
                </label>
                <div className="relative">
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    autoFocus
                    className={`w-full px-4 py-3 pr-12 rounded-xl border outline-none transition-all ${
                      darkMode
                        ? 'bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-blue-500'
                        : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded ${
                      darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {passwordStrength && (
                  <div className="mt-2">
                    <PasswordStrengthMeter strengthData={passwordStrength} darkMode={darkMode} />
                  </div>
                )}
              </div>

              <div className="mb-6">
                <label className={`block text-sm font-medium mb-2 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Confirm New Password
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    className={`w-full px-4 py-3 pr-12 rounded-xl border outline-none transition-all ${
                      darkMode
                        ? 'bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-blue-500'
                        : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded ${
                      darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !newPassword || !confirmPassword}
                className="w-full py-3 px-4 rounded-xl font-medium text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Resetting...' : 'Reset Password'}
              </button>
            </form>
          )}

          {/* Step 5: Success */}
          {step === 'success' && (
            <div className="text-center py-6">
              <div className={`inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 ${
                darkMode ? 'bg-green-500/10' : 'bg-green-50'
              }`}>
                <Check className={`w-8 h-8 ${darkMode ? 'text-green-400' : 'text-green-600'}`} />
              </div>
              <p className={`text-lg font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Password reset successfully!
              </p>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                You can now log in with your new password. Redirecting...
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ForgotPasswordModal;
