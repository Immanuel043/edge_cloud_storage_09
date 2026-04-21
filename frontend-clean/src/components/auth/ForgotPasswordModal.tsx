import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Shield,
  Mail,
  KeyRound,
  Lock,
  Check,
  Eye,
  EyeOff,
  RefreshCw,
  Clock,
  AlertCircle,
  ArrowLeft,
} from 'lucide-react';
import { authService } from '../../services/authService';
import {
  validateEmail,
  validatePassword,
  validatePasswordStrength,
  type PasswordStrengthResult,
} from '../../utils/security';
import PasswordStrengthMeter from './PasswordStrengthMeter';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  FormField,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalHeader,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/cn';

type ForgotPasswordStep = 'email' | 'method' | 'code' | 'password' | 'success';

interface ForgotPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitchToRecovery: (email: string) => void;
  onResetComplete?: () => void;
}

/**
 * ForgotPasswordModal — multi-step password-reset flow: email → method
 * selection → 6-digit verification code → new-password form → success.
 * Users with ZK recovery can branch to the recovery-phrase unlock instead.
 */
const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
  onSwitchToRecovery,
  onResetComplete,
}) => {
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

  const [timeLeft, setTimeLeft] = useState(30 * 60);
  const [canResend, setCanResend] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (step !== 'code') return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [step]);

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

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
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
    },
    [email]
  );

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

  const handleCodeChange = (index: number, value: string): void => {
    if (value && !/^\d$/.test(value)) return;

    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);

    if (value && index < 5) {
      codeInputRefs.current[index + 1]?.focus();
    }

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

  const handlePasswordSubmit = useCallback(
    async (e: React.FormEvent) => {
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
        setTimeout(() => {
          handleClose();
          onResetComplete?.();
        }, 2000);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [email, resetToken, newPassword, confirmPassword, onResetComplete]
  );

  if (!isOpen) return null;

  const stepTitle: Record<ForgotPasswordStep, string> = {
    email: 'Reset password',
    method: 'Check your email',
    code: 'Enter verification code',
    password: 'Set new password',
    success: 'Password reset!',
  };

  const stepDescription: Record<ForgotPasswordStep, string> = {
    email: 'Enter your email to receive reset instructions',
    method: 'Choose how to reset your password',
    code: `We sent a code to ${email}`,
    password: 'Choose a strong new password',
    success: 'Your password has been reset successfully',
  };

  const headerIcon =
    step === 'success' ? (
      <Check className="text-white" size={24} />
    ) : step === 'password' ? (
      <Lock className="text-white" size={24} />
    ) : step === 'code' ? (
      <KeyRound className="text-white" size={24} />
    ) : (
      <Mail className="text-white" size={24} />
    );

  return (
    <Modal open={isOpen} onClose={handleClose} size="md">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-xl',
              step === 'success'
                ? 'bg-gradient-to-br from-success to-success/80'
                : 'bg-gradient-to-br from-primary to-accent'
            )}
          >
            {headerIcon}
          </div>
          <div>
            <h2 className="text-h2 font-bold text-fg">{stepTitle[step]}</h2>
            <p className="text-body-sm text-fg-muted">{stepDescription[step]}</p>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        {error && (
          <div className="mb-4">
            <Banner variant="danger" icon={<AlertCircle />}>
              {error}
            </Banner>
          </div>
        )}

        {step === 'email' && (
          <form onSubmit={(e) => void handleEmailSubmit(e)} className="space-y-4">
            <FormField label="Email address">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                autoFocus
              />
            </FormField>
            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={loading}
              disabled={loading || !email}
            >
              {loading ? 'Sending...' : 'Send reset instructions'}
            </Button>
          </form>
        )}

        {step === 'method' && (
          <div className="space-y-3">
            <Banner variant="info">
              If your email is registered, you&apos;ll receive instructions. Check your inbox (and
              spam folder).
            </Banner>

            <button
              type="button"
              onClick={() => {
                setStep('code');
                setTimeLeft(30 * 60);
                setCanResend(false);
                setResendCooldown(60);
                setTimeout(() => codeInputRefs.current[0]?.focus(), 100);
              }}
              className="w-full rounded-xl border border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-primary/10 p-2">
                  <KeyRound className="text-primary" size={20} />
                </div>
                <div>
                  <p className="font-medium text-fg">I received a verification code</p>
                  <p className="text-body-sm text-fg-muted">
                    Enter the 6-digit code from your email
                  </p>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onSwitchToRecovery(email)}
              className="w-full rounded-xl border border-border p-4 text-left transition-colors hover:border-accent/50 hover:bg-accent/5"
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-accent/10 p-2">
                  <Shield className="text-accent" size={20} />
                </div>
                <div>
                  <p className="font-medium text-fg">I have a recovery phrase</p>
                  <p className="text-body-sm text-fg-muted">
                    Use your 24-word recovery phrase (ZK accounts)
                  </p>
                </div>
              </div>
            </button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep('email')}
              leftIcon={<ArrowLeft size={16} />}
            >
              Back
            </Button>
          </div>
        )}

        {step === 'code' && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep('method');
                setError('');
                setCode(['', '', '', '', '', '']);
              }}
              leftIcon={<ArrowLeft size={16} />}
              className="mb-4"
            >
              Back
            </Button>

            <div className="mb-6 flex justify-center gap-3">
              {code.map((digit, index) => (
                <input
                  key={index}
                  ref={(el) => {
                    codeInputRefs.current[index] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleCodeChange(index, e.target.value)}
                  onKeyDown={(e) => handleCodeKeyDown(index, e)}
                  onPaste={handleCodePaste}
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
        )}

        {step === 'password' && (
          <form onSubmit={(e) => void handlePasswordSubmit(e)} className="space-y-4">
            <FormField label="New password">
              <div className="relative">
                <Input
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  autoFocus
                />
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                >
                  {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </IconButton>
              </div>
              {passwordStrength && (
                <PasswordStrengthMeter strengthData={passwordStrength} darkMode={false} />
              )}
            </FormField>

            <FormField label="Confirm new password">
              <div className="relative">
                <Input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                />
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                >
                  {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </IconButton>
              </div>
            </FormField>

            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={loading}
              disabled={loading || !newPassword || !confirmPassword}
            >
              {loading ? 'Resetting...' : 'Reset password'}
            </Button>
          </form>
        )}

        {step === 'success' && (
          <div className="py-6 text-center">
            <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
              <Check className="h-8 w-8 text-success" />
            </div>
            <p className="mb-2 text-h3 font-medium text-fg">Password reset successfully!</p>
            <p className="text-body-sm text-fg-muted">
              You can now log in with your new password. Redirecting...
            </p>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
};

export default ForgotPasswordModal;
