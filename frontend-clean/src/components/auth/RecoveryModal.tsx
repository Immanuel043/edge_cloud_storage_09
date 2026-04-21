import React, { useState } from 'react';
import { Shield, Key, AlertCircle, Check, Eye, EyeOff } from 'lucide-react';
import RecoveryPhraseInput from './RecoveryPhraseInput';
import {
  verifyRecoveryPhrase,
  recoverMasterKeyFromPhrase,
  reEncryptMasterKeyWithNewPassword,
} from '../../services/zkEncryptionService';
import {
  getRecoveryInfo,
  recoverAccountWithNewPassword,
  type KDFParams,
} from '../../services/zkAuthService';
import type { RecoveryModalProps, RecoveryStep } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  FormField,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';
import { cn } from '@/lib/cn';

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
 * RecoveryModal — ZK account recovery via 24-word phrase.
 *
 * Step 1: user enters email + phrase; we fetch recovery info, decrypt the
 * master key client-side to prove ownership, then advance.
 * Step 2: user sets a new password; we re-encrypt the master key and call
 * the backend recovery endpoint. Step 3: success toast before closing.
 */
const RecoveryModal: React.FC<RecoveryModalProps> = ({
  isOpen,
  onClose,
  onRecoveryComplete,
  initialEmail,
}) => {
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
  const [recoveryInfo, setRecoveryInfo] = useState<RecoveryInfoWithPhrase | null>(null);

  if (!isOpen) return null;

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

  const handlePhraseSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const recoveryPhrase = recoveryWords.join(' ').toLowerCase().trim();

      const isValidPhrase = await verifyRecoveryPhrase(recoveryPhrase);
      if (!isValidPhrase) {
        setError('Invalid recovery phrase. Please check all words are correct BIP39 words.');
        setLoading(false);
        return;
      }

      if (!email || !email.includes('@')) {
        setError('Please enter a valid email address.');
        setLoading(false);
        return;
      }

      const info = await getRecoveryInfo(email);

      if (!info.recovery_enabled) {
        setError('Recovery phrase is not enabled for this account.');
        setLoading(false);
        return;
      }

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

      setRecoveryInfo({ ...info, recoveryPhrase });
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

  const handlePasswordSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');

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
      const newZkData = await reEncryptMasterKeyWithNewPassword(newPassword);

      if (!recoveryInfo) {
        throw new Error('Recovery info not available');
      }

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

  const allWordsFilled = recoveryWords.every((word) => word && word.trim().length > 0);
  const passwordsMatch = Boolean(confirmPassword) && newPassword === confirmPassword;

  const headerTitle = recovered
    ? 'Account recovered!'
    : 'Recover account';
  const headerDescription = recovered
    ? 'Your account has been recovered successfully'
    : step === 1
      ? 'Enter your 24-word recovery phrase'
      : 'Set a new password';

  return (
    <Modal open={isOpen} onClose={handleClose} size="lg">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-xl',
              recovered
                ? 'bg-gradient-to-br from-success to-success/80'
                : 'bg-gradient-to-br from-primary to-accent'
            )}
          >
            {recovered ? (
              <Check className="text-white" size={24} />
            ) : (
              <Shield className="text-white" size={24} />
            )}
          </div>
          <div>
            <h2 className="text-h2 font-bold text-fg">{headerTitle}</h2>
            <p className="text-body-sm text-fg-muted">{headerDescription}</p>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        {recovered ? (
          <div className="py-8 text-center">
            <div className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-success to-success/80">
              <Check className="text-white" size={40} />
            </div>
            <p className="text-h3 font-semibold text-fg">Account recovered successfully!</p>
            <p className="mt-2 text-body-sm text-fg-muted">
              You can now log in with your new password.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <Banner variant="info" icon={<AlertCircle />}>
              {step === 1
                ? 'Enter your 24-word recovery phrase to recover your account. All decryption happens locally on your device.'
                : "Choose a strong password. You'll use this to access your encrypted files."}
            </Banner>

            {error && (
              <Banner variant="danger" icon={<AlertCircle />}>
                {error}
              </Banner>
            )}

            {step === 1 && (
              <form onSubmit={(e) => void handlePhraseSubmit(e)} className="space-y-4">
                <FormField label="Email address">
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    required
                    autoFocus
                    aria-label="Email address for account recovery"
                  />
                </FormField>

                <FormField label="24-word recovery phrase">
                  <RecoveryPhraseInput
                    value={recoveryWords}
                    onChange={setRecoveryWords}
                    disabled={loading}
                    compact={false}
                  />
                </FormField>

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  loading={loading}
                  disabled={loading || !allWordsFilled || !email}
                >
                  {loading ? 'Verifying...' : 'Continue'}
                </Button>
              </form>
            )}

            {step === 2 && (
              <form onSubmit={(e) => void handlePasswordSubmit(e)} className="space-y-4">
                <Banner variant="success" icon={<Check />}>
                  Recovery phrase verified! Your master key has been recovered.
                </Banner>

                <FormField label="New password">
                  <div className="relative">
                    <Input
                      type={showNewPassword ? 'text' : 'password'}
                      placeholder="Enter new password (min 8 characters)"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={loading}
                      required
                      minLength={8}
                      autoFocus
                      leftAddon={<Key size={18} />}
                      aria-label="New password"
                    />
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      disabled={loading}
                      aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                    >
                      {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </IconButton>
                  </div>
                </FormField>

                <FormField label="Confirm new password">
                  <div className="relative">
                    <Input
                      type={showConfirmPassword ? 'text' : 'password'}
                      placeholder="Re-enter new password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={loading}
                      required
                      minLength={8}
                      leftAddon={<Key size={18} />}
                      aria-label="Confirm new password"
                    />
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      disabled={loading}
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                    >
                      {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </IconButton>
                  </div>
                  {passwordsMatch && (
                    <p className="mt-1 flex items-center gap-1 text-body-sm text-success">
                      <Check size={14} /> Passwords match
                    </p>
                  )}
                </FormField>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleBack}
                    disabled={loading}
                    className="flex-1"
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={loading}
                    disabled={loading || newPassword.length < 8 || newPassword !== confirmPassword}
                    className="flex-1"
                  >
                    {loading ? 'Recovering...' : 'Recover account'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </ModalBody>

      {!recovered && (
        <ModalFooter>
          <div className="flex w-full items-start gap-2">
            <Shield className="shrink-0 text-fg-subtle" size={16} />
            <p className="text-caption text-fg-subtle">
              Your recovery phrase is never sent to our servers. All decryption happens on your
              device.
              {step === 2 && ' Your new password will be used to re-encrypt your master key.'}
            </p>
          </div>
        </ModalFooter>
      )}
    </Modal>
  );
};

export default RecoveryModal;
