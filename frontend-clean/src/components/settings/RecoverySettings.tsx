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
import { useAuth } from '../../contexts/AuthContext';
import { generateRecoveryPhraseData } from '../../services/zkEncryptionService';
import type { RecoveryPhraseData } from './types';
import { rotateRecoveryPhrase } from '../../services/zkAuthService';
import RecoveryPhraseSetup from '../auth/RecoveryPhraseSetup';
import {
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  IconButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';
import { cn } from '@/lib/cn';

function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

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
 * RecoverySettings — settings panel for the ZK recovery phrase. Shows the
 * current recovery status, allows the user to set up a phrase if not yet
 * enabled, and to rotate (replace) an existing one.
 */
const RecoverySettings: React.FC = () => {
  const { zkRecoveryEnabled, setupRecoveryPhrase, checkZKStatus } = useAuth();
  const [statusLoading, setStatusLoading] = useState<boolean>(true);

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

  const handleSetupPhrase = async (): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      if (!setupRecoveryPhrase) {
        throw new Error('Recovery phrase setup is not available');
      }
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

  const handleSetupConfirm = async (): Promise<void> => {
    setShowSetupModal(false);
    setSetupPhrase('');
    setSuccess('Recovery phrase set up successfully! Keep it safe.');
    if (checkZKStatus) {
      await checkZKStatus();
    }
  };

  const handleSetupSkip = (): void => {
    setShowSetupModal(false);
    setSetupPhrase('');
  };

  const handleRotatePhrase = async (): Promise<void> => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const recoveryData: RecoveryPhraseData = generateRecoveryPhraseData();
      setNewPhrase(recoveryData.recoveryPhrase);
      setConfirmStep(true);
      setLoading(false);
    } catch (err: unknown) {
      console.error('Failed to generate new recovery phrase:', getErrorMessage(err));
      setError(getErrorMessage(err) || 'Failed to generate new recovery phrase.');
      setLoading(false);
    }
  };

  const handleConfirmRotation = async (): Promise<void> => {
    if (!phraseCopied && !phraseDownloaded) {
      setError('Please copy or download your recovery phrase before continuing.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const recoveryData: RecoveryPhraseData = generateRecoveryPhraseData();

      await rotateRecoveryPhrase(
        recoveryData.recoveryEncryptedMasterKey,
        recoveryData.recoveryPhraseHash
      );

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

  const handleCopyPhrase = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(newPhrase);
      setPhraseCopied(true);
      setTimeout(() => setPhraseCopied(false), 3000);
    } catch (err: unknown) {
      console.error('Failed to copy:', getErrorMessage(err));
    }
  };

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

  const resetModalState = (): void => {
    setNewPhrase('');
    setPhraseVisible(false);
    setPhraseCopied(false);
    setPhraseDownloaded(false);
    setConfirmStep(false);
    setError('');
  };

  const handleCloseModal = (): void => {
    if (confirmStep && !loading) {
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
    <Card variant="bordered">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
            <Shield className="text-white" size={20} />
          </div>
          <div>
            <h3 className="text-h3 font-semibold text-fg">Recovery phrase</h3>
            <p className="text-body-sm text-fg-muted">Manage your 24-word recovery phrase</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {success && (
          <Banner variant="success" icon={<Check />}>
            {success}
          </Banner>
        )}

        {error && !showRotateModal && (
          <Banner variant="danger" icon={<AlertCircle />}>
            {error}
          </Banner>
        )}

        <div className="rounded-xl bg-surface-muted p-4">
          <div className="flex items-center gap-3">
            {statusLoading ? (
              <>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-elevated">
                  <RefreshCw className="animate-spin text-fg-muted" size={18} />
                </div>
                <div>
                  <p className="font-medium text-fg">Checking status...</p>
                  <p className="text-body-sm text-fg-muted">
                    Loading recovery phrase status
                  </p>
                </div>
              </>
            ) : (
              <>
                <div
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg',
                    zkRecoveryEnabled
                      ? 'bg-success/10 text-success'
                      : 'bg-warning/10 text-warning'
                  )}
                >
                  {zkRecoveryEnabled ? <Check size={18} /> : <AlertTriangle size={18} />}
                </div>
                <div>
                  <p className="font-medium text-fg">
                    {zkRecoveryEnabled ? 'Recovery enabled' : 'Recovery not set up'}
                  </p>
                  <p className="text-body-sm text-fg-muted">
                    {zkRecoveryEnabled
                      ? 'Your account can be recovered using your 24-word phrase'
                      : 'Set up a recovery phrase to protect your account'}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        {zkRecoveryEnabled && (
          <Banner
            variant="warning"
            icon={<AlertTriangle />}
            title="Important security information"
          >
            Your recovery phrase is the only way to recover your account if you forget your
            password. Keep it stored securely and never share it with anyone.
          </Banner>
        )}

        <div className="flex flex-col gap-3">
          {statusLoading ? (
            <Button variant="secondary" loading disabled fullWidth>
              Loading...
            </Button>
          ) : zkRecoveryEnabled ? (
            <Button
              variant="secondary"
              fullWidth
              leftIcon={<RefreshCw size={18} />}
              onClick={() => setShowRotateModal(true)}
            >
              Rotate recovery phrase
            </Button>
          ) : (
            <Button
              variant="primary"
              fullWidth
              loading={loading}
              disabled={loading}
              leftIcon={!loading ? <Key size={18} /> : undefined}
              onClick={() => void handleSetupPhrase()}
            >
              {loading ? 'Setting up...' : 'Set up recovery phrase'}
            </Button>
          )}
        </div>

        <p className="text-caption text-fg-subtle">
          <strong className="text-fg-muted">Why rotate?</strong> If you believe your recovery
          phrase may have been compromised, rotating it will generate a new phrase and invalidate
          the old one.
        </p>
      </CardContent>

      <Modal open={showRotateModal} onClose={handleCloseModal} size="md">
        <ModalHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent">
              <RefreshCw className="text-white" size={24} />
            </div>
            <div>
              <h2 className="text-h2 font-bold text-fg">
                {confirmStep ? 'Save your new recovery phrase' : 'Rotate recovery phrase'}
              </h2>
              <p className="text-body-sm text-fg-muted">
                {confirmStep
                  ? 'Write down or save your new phrase securely'
                  : 'This will generate a new recovery phrase'}
              </p>
            </div>
          </div>
        </ModalHeader>

        <ModalBody>
          <div className="space-y-4">
            {error && (
              <Banner variant="danger" icon={<AlertCircle />}>
                {error}
              </Banner>
            )}

            {!confirmStep ? (
              <Banner
                variant="danger"
                icon={<AlertTriangle />}
                title="Warning: this action cannot be undone"
              >
                Your current recovery phrase will become invalid immediately. Make sure
                you&apos;re ready to save a new one.
              </Banner>
            ) : (
              <>
                <div className="rounded-xl border border-border bg-surface-muted p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-body-sm font-medium text-fg">
                      Your new recovery phrase
                    </span>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={phraseVisible ? 'Hide phrase' : 'Show phrase'}
                      onClick={() => setPhraseVisible(!phraseVisible)}
                    >
                      {phraseVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </IconButton>
                  </div>
                  <div
                    className={cn(
                      'rounded-lg bg-surface p-3 font-mono text-body-sm text-fg',
                      !phraseVisible && 'select-none blur-sm'
                    )}
                  >
                    {newPhrase}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant={phraseCopied ? 'primary' : 'secondary'}
                    leftIcon={phraseCopied ? <Check size={16} /> : <Copy size={16} />}
                    onClick={() => void handleCopyPhrase()}
                  >
                    {phraseCopied ? 'Copied!' : 'Copy'}
                  </Button>
                  <Button
                    variant={phraseDownloaded ? 'primary' : 'secondary'}
                    leftIcon={phraseDownloaded ? <Check size={16} /> : <Download size={16} />}
                    onClick={handleDownloadPhrase}
                  >
                    {phraseDownloaded ? 'Downloaded!' : 'Download'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={handleCloseModal} disabled={loading}>
            Cancel
          </Button>
          {!confirmStep ? (
            <Button
              variant="primary"
              loading={loading}
              disabled={loading}
              onClick={() => void handleRotatePhrase()}
            >
              {loading ? 'Generating...' : 'Generate new phrase'}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={loading}
              disabled={loading || (!phraseCopied && !phraseDownloaded)}
              onClick={() => void handleConfirmRotation()}
            >
              {loading ? 'Saving...' : 'Confirm & save'}
            </Button>
          )}
        </ModalFooter>
      </Modal>

      {showSetupModal && setupPhrase && (
        <RecoveryPhraseSetup
          recoveryPhrase={setupPhrase}
          onConfirm={() => void handleSetupConfirm()}
          onSkip={handleSetupSkip}
        />
      )}
    </Card>
  );
};

export default RecoverySettings;
