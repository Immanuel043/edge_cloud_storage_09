import React, { useState, useEffect, useRef } from 'react';
import { Lock, Unlock, AlertCircle, Key, ArrowLeft, Shield } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import RecoveryPhraseInput from './RecoveryPhraseInput';
import {
  verifyRecoveryPhrase,
  recoverMasterKeyFromPhrase,
} from '../../services/zkEncryptionService';
import { getRecoveryInfo } from '../../services/zkAuthService';
import type { SessionUnlockModalProps, UnlockMode } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  FormField,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * SessionUnlockModal — shown when the ZK session has expired or is locked.
 * Offers two unlock paths: (1) password (default) and (2) 24-word recovery
 * phrase, falling back only if the account has recovery enabled.
 */
const SessionUnlockModal: React.FC<SessionUnlockModalProps> = ({ isOpen, onClose }) => {
  const { unlockSession, user, zkRecoveryEnabled, checkZKStatus } = useAuth();

  const [mode, setMode] = useState<UnlockMode>('password');
  const [recoveryAvailable, setRecoveryAvailable] = useState<boolean>(zkRecoveryEnabled);
  const [checkingRecovery, setCheckingRecovery] = useState<boolean>(false);

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

  const [password, setPassword] = useState<string>('');
  const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(24).fill(''));

  const [failedAttempts, setFailedAttempts] = useState<number>(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);
  const lockoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [unlocked, setUnlocked] = useState<boolean>(false);

  useEffect(() => {
    if (lockoutUntil) {
      lockoutTimerRef.current = setInterval(() => {
        if (Date.now() >= lockoutUntil) {
          setLockoutUntil(null);
          setFailedAttempts(0);
        }
      }, 1000);
      return () => {
        if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
      };
    }
  }, [lockoutUntil]);

  if (!isOpen) return null;

  const handleClose = (): void => {
    setPassword('');
    setRecoveryWords(Array(24).fill(''));
    setError('');
    onClose();
    setTimeout(() => {
      setMode('password');
      setUnlocked(false);
    }, 300);
  };

  const handlePasswordUnlock = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');

    if (lockoutUntil && Date.now() < lockoutUntil) {
      const remaining = Math.ceil((lockoutUntil - Date.now()) / 1000);
      setError(`Too many failed attempts. Please wait ${remaining} seconds.`);
      return;
    }

    setLoading(true);
    try {
      if (!unlockSession) {
        setError('Session unlock is not available');
        setLoading(false);
        return;
      }
      const success = await unlockSession(password);
      if (success) {
        setUnlocked(true);
        setFailedAttempts(0);
        setTimeout(() => handleClose(), 1000);
      } else {
        const newAttempts = failedAttempts + 1;
        setFailedAttempts(newAttempts);
        if (newAttempts >= 5) {
          setLockoutUntil(Date.now() + 60000);
          setError('Too many failed attempts. Please wait 60 seconds.');
        } else {
          setError('Incorrect password. Please try again.');
        }
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Failed to unlock session. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRecoveryUnlock = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const recoveryPhrase = recoveryWords.join(' ').toLowerCase().trim();

      const isValidPhrase = await verifyRecoveryPhrase(recoveryPhrase);
      if (!isValidPhrase) {
        setError('Invalid recovery phrase. Please check all words are correct.');
        setLoading(false);
        return;
      }

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

      setUnlocked(true);
      setTimeout(() => handleClose(), 1000);
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

  const allWordsFilled = recoveryWords.every((word) => word && word.trim().length > 0);

  return (
    <Modal open={isOpen} onClose={handleClose} size={mode === 'recovery' ? 'lg' : 'md'}>
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-xl text-white',
              unlocked
                ? 'bg-gradient-to-br from-success to-success/80'
                : 'bg-gradient-to-br from-warning to-danger'
            )}
          >
            {unlocked ? <Unlock size={24} /> : <Lock size={24} />}
          </div>
          <div>
            <h2 className="text-h2 font-bold text-fg">
              {unlocked ? 'Session unlocked!' : 'Session locked'}
            </h2>
            <p className="text-body-sm text-fg-muted">
              {unlocked
                ? 'Access granted'
                : mode === 'password'
                ? 'Enter password to continue'
                : 'Enter recovery phrase to unlock'}
            </p>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        {unlocked ? (
          <div className="py-8 text-center">
            <div className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-success to-success/80 text-white">
              <Unlock size={40} />
            </div>
            <p className="text-h3 font-semibold text-fg">Session unlocked!</p>
            <p className="mt-2 text-body-sm text-fg-muted">
              Your encryption keys are now available.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <Banner
              variant="warning"
              icon={<AlertCircle />}
              title="Your encryption session has been locked for security."
            >
              {mode === 'password'
                ? 'Enter your password to decrypt your files and continue working.'
                : 'Enter your 24-word recovery phrase to unlock your session.'}
            </Banner>

            {error && <Banner variant="danger">{error}</Banner>}

            {mode === 'password' && (
              <form onSubmit={(e) => void handlePasswordUnlock(e)} className="space-y-4">
                {user && (
                  <div className="rounded-lg bg-surface-muted p-3">
                    <p className="text-caption text-fg-subtle">Logged in as</p>
                    <p className="font-medium text-fg">{user.email || user.username}</p>
                  </div>
                )}

                <FormField label="Password">
                  <Input
                    type="password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    autoFocus
                    required
                    leftAddon={<Key size={18} />}
                  />
                </FormField>

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  loading={loading}
                  disabled={loading || !password}
                >
                  {loading ? 'Unlocking...' : 'Unlock session'}
                </Button>
              </form>
            )}

            {mode === 'recovery' && (
              <form onSubmit={(e) => void handleRecoveryUnlock(e)} className="space-y-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={switchToPassword}
                  leftIcon={<ArrowLeft size={16} />}
                >
                  Back to password
                </Button>

                {user && (
                  <div className="rounded-lg bg-surface-muted p-3">
                    <p className="text-caption text-fg-subtle">Recovering session for</p>
                    <p className="font-medium text-fg">{user.email || user.username}</p>
                  </div>
                )}

                <FormField label="24-word recovery phrase">
                  <RecoveryPhraseInput
                    value={recoveryWords}
                    onChange={setRecoveryWords}
                    disabled={loading}
                    compact
                  />
                </FormField>

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  loading={loading}
                  disabled={loading || !allWordsFilled}
                >
                  {loading ? 'Verifying...' : 'Unlock with recovery phrase'}
                </Button>
              </form>
            )}
          </div>
        )}
      </ModalBody>

      {!unlocked && mode === 'password' && (
        <ModalFooter>
          <div className="w-full text-center">
            <p className="text-caption text-fg-subtle">
              Can&apos;t remember your password?{' '}
              {checkingRecovery ? (
                <span className="text-fg-muted">Checking recovery options...</span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={switchToRecovery}
                    disabled={!recoveryAvailable}
                    className={cn(
                      'font-medium transition-colors',
                      recoveryAvailable
                        ? 'text-primary hover:text-primary/80'
                        : 'cursor-not-allowed text-fg-subtle'
                    )}
                  >
                    Use recovery phrase
                  </button>
                  {!recoveryAvailable && (
                    <span className="mt-1 block text-caption text-fg-subtle">
                      (Recovery phrase not set up)
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
        </ModalFooter>
      )}

      {!unlocked && mode === 'recovery' && (
        <ModalFooter>
          <div className="flex w-full items-start gap-2">
            <Shield className="shrink-0 text-fg-subtle" size={16} />
            <p className="text-caption text-fg-subtle">
              Your recovery phrase is never sent to our servers. All decryption happens locally on
              your device.
            </p>
          </div>
        </ModalFooter>
      )}
    </Modal>
  );
};

export default SessionUnlockModal;
