import React, { useState, useRef, useEffect } from 'react';
import { CheckCircle, AlertTriangle, RefreshCw, Clock, ArrowLeft } from 'lucide-react';
import type { VerificationCodeInputProps, VerificationCode } from './types';
import { Banner, Button, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * VerificationCodeInput — 6-digit one-time-code input with auto-submit,
 * paste support, resend cooldown, and a live expiry countdown.
 */
const VerificationCodeInput: React.FC<VerificationCodeInputProps> = ({
  email,
  onVerify,
  onResend,
  onBack,
  loading = false,
  error = null,
  expiryMinutes = 30,
}) => {
  const [code, setCode] = useState<VerificationCode>(['', '', '', '', '', '']);
  const [timeLeft, setTimeLeft] = useState<number>(expiryMinutes * 60);
  const [canResend, setCanResend] = useState<boolean>(false);
  const [resendCooldown, setResendCooldown] = useState<number>(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
    if (value && !/^\d$/.test(value)) return;

    const newCode = [...code] as VerificationCode;
    newCode[index] = value;
    setCode(newCode);

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newCode.every((digit) => digit) && newCode.join('').length === 6) {
      void onVerify(newCode.join(''));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
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
    setResendCooldown(60);
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
    <div className="mx-auto w-full max-w-md">
      {onBack && (
        <button
          onClick={onBack}
          className="mb-4 flex items-center gap-2 text-body-sm text-fg-muted transition-colors hover:text-fg"
          type="button"
        >
          <ArrowLeft size={16} />
          Back to registration
        </button>
      )}

      <div className="mb-8 text-center">
        <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle className="h-8 w-8 text-primary" />
        </div>
        <h2 className="mb-2 text-h2 font-bold text-fg">Check your email</h2>
        <p className="text-body-sm text-fg-muted">
          We sent a verification code to <strong className="text-fg">{email}</strong>
        </p>
      </div>

      <div className="mb-6 flex justify-center gap-3">
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
            onChange={(e) => handleChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            disabled={loading}
            className={cn(
              'h-14 w-12 rounded-xl border-2 bg-surface text-center text-h2 font-bold text-fg outline-none transition-all',
              'focus:border-border-focus focus:ring-2 focus:ring-primary/20',
              digit ? 'border-primary' : 'border-border',
              loading && 'cursor-not-allowed opacity-50'
            )}
            autoFocus={index === 0}
          />
        ))}
      </div>

      {timeLeft > 0 && (
        <div className="mb-4 flex items-center justify-center gap-2 text-body-sm text-fg-muted">
          <Clock size={16} />
          <span>Code expires in {formatTime(timeLeft)}</span>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Banner variant="danger" icon={<AlertTriangle />}>
            {error}
          </Banner>
        </div>
      )}

      <div className="text-center">
        <p className="mb-2 text-body-sm text-fg-muted">Didn&apos;t receive the code?</p>
        <Button
          variant="link"
          size="sm"
          onClick={() => void handleResend()}
          disabled={!canResend && resendCooldown > 0}
          leftIcon={<RefreshCw size={14} />}
        >
          {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
        </Button>
      </div>

      {loading && (
        <div className="mt-6 flex justify-center">
          <Spinner size="md" />
        </div>
      )}
    </div>
  );
};

export default VerificationCodeInput;
