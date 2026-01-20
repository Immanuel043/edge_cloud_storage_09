import React, { useState, useRef, useEffect } from 'react';
import { CheckCircle, AlertTriangle, RefreshCw, Clock, ArrowLeft } from 'lucide-react';
import type { VerificationCodeInputProps, VerificationCode } from './types';

/**
 * VerificationCodeInput Component
 *
 * 6-digit verification code input with auto-submit and paste support.
 * Follows strict TypeScript typing with proper ref handling.
 */
const VerificationCodeInput: React.FC<VerificationCodeInputProps> = ({
  email,
  onVerify,
  onResend,
  onBack,
  darkMode = false,
  loading = false,
  error = null,
  expiryMinutes = 30,
}) => {
  const [code, setCode] = useState<VerificationCode>(['', '', '', '', '', '']);
  const [timeLeft, setTimeLeft] = useState<number>(expiryMinutes * 60);
  const [canResend, setCanResend] = useState<boolean>(false);
  const [resendCooldown, setResendCooldown] = useState<number>(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 0) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown > 0) {
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
    }
  }, [resendCooldown]);

  const handleChange = (index: number, value: string): void => {
    // Only allow digits
    if (value && !/^\d$/.test(value)) return;

    const newCode = [...code] as VerificationCode;
    newCode[index] = value;
    setCode(newCode);

    // Auto-focus next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (newCode.every((digit) => digit) && newCode.join('').length === 6) {
      void onVerify(newCode.join(''));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Backspace: clear current and move to previous
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '');
    if (pastedData.length === 6) {
      const newCode = pastedData.split('') as VerificationCode;
      setCode(newCode);
      inputRefs.current[5]?.focus();
      void onVerify(pastedData);
    }
  };

  const handleResend = async (): Promise<void> => {
    setCanResend(false);
    setResendCooldown(60); // 60 second cooldown
    setCode(['', '', '', '', '', '']);
    inputRefs.current[0]?.focus();
    await onResend();
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {/* Back button */}
      {onBack && (
        <button
          onClick={onBack}
          className={`mb-4 flex items-center gap-2 text-sm transition-colors ${
            darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <ArrowLeft size={16} />
          Back to registration
        </button>
      )}

      {/* Header */}
      <div className="text-center mb-8">
        <div
          className={`inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 ${
            darkMode ? 'bg-blue-500/10' : 'bg-blue-50'
          }`}
        >
          <CheckCircle className={`w-8 h-8 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
        </div>
        <h2 className={`text-2xl font-bold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          Check your email
        </h2>
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          We sent a verification code to{' '}
          <strong className={darkMode ? 'text-white' : 'text-gray-900'}>{email}</strong>
        </p>
      </div>

      {/* Code Input */}
      <div className="flex gap-3 justify-center mb-6">
        {code.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputRefs.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              handleChange(index, e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => handleKeyDown(index, e)}
            onPaste={handlePaste}
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
        <div
          className={`flex items-center justify-center gap-2 text-sm mb-4 ${
            darkMode ? 'text-gray-400' : 'text-gray-600'
          }`}
        >
          <Clock size={16} />
          <span>Code expires in {formatTime(timeLeft)}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className={`mb-4 p-3 rounded-xl flex items-center gap-3 text-sm ${
            darkMode
              ? 'bg-red-500/10 border border-red-500/20 text-red-400'
              : 'bg-red-50 border border-red-200 text-red-600'
          }`}
        >
          <AlertTriangle size={16} className="flex-shrink-0" />
          {error}
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

      {/* Loading State */}
      {loading && (
        <div className="mt-6 flex justify-center">
          <div
            className={`w-6 h-6 border-2 rounded-full animate-spin ${
              darkMode ? 'border-blue-500/30 border-t-blue-500' : 'border-blue-300 border-t-blue-600'
            }`}
          />
        </div>
      )}
    </div>
  );
};

export default VerificationCodeInput;
