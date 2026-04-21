import React, { useState } from 'react';
import { Shield, ArrowUpCircle, X, CheckCircle, AlertTriangle, Lock } from 'lucide-react';
import { useStorage } from '../../contexts/StorageContext';
import { useAuth } from '../../contexts/AuthContext';
import type { MigrationProgress, MigrationResult } from './types';
import { getErrorMessage } from './types';
import { formatMigrationStats, type MigrationStats } from '../../utils/zkMigration';
import { Banner, Button, IconButton, Progress, Spinner } from '@/components/ui';

/**
 * MigrationBanner — nudges users holding V1 ZK-encrypted files to upgrade to
 * V2 (HKDF-derived keys, AEAD with AAD). Drives the migration via
 * StorageContext and surfaces progress + success/failure inline.
 */
const MigrationBanner: React.FC = () => {
  const storageContext = useStorage();
  const migrationStats = storageContext.migrationStats as MigrationStats | null;
  const migrationInProgress = storageContext.migrationInProgress as boolean;
  const migrationProgress = storageContext.migrationProgress as MigrationProgress;
  const migrateAllFiles = storageContext.migrateAllFiles as () => Promise<MigrationResult>;
  const dismissMigrationPrompt = storageContext.dismissMigrationPrompt as () => void;
  const isMigrationPromptDismissed = storageContext.isMigrationPromptDismissed as () => boolean;

  const { zkEnabled, zkSessionUnlocked } = useAuth();

  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!migrationStats?.migrationNeeded || isMigrationPromptDismissed()) {
    return null;
  }

  const isSessionLocked = zkEnabled && !zkSessionUnlocked;

  const handleMigrate = async (): Promise<void> => {
    setError(null);
    setMigrationResult(null);
    try {
      const result = await migrateAllFiles();
      setMigrationResult(result);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  };

  const handleDismiss = (): void => {
    dismissMigrationPrompt();
  };

  // Success state
  if (migrationResult) {
    return (
      <div className="mb-4">
        <Banner
          variant="success"
          icon={<CheckCircle />}
          title="Migration complete"
          onDismiss={() => setMigrationResult(null)}
        >
          {migrationResult.completed} file(s) upgraded to enhanced encryption.
          {migrationResult.failed > 0 && ` ${migrationResult.failed} file(s) failed.`}
          {migrationResult.skipped > 0 &&
            ` ${migrationResult.skipped} file(s) already up to date.`}
        </Banner>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="mb-4">
        <Banner
          variant="danger"
          icon={<AlertTriangle />}
          title="Migration failed"
          onDismiss={() => setError(null)}
        >
          {error}
        </Banner>
      </div>
    );
  }

  // In-progress state
  if (migrationInProgress) {
    const progressPercent =
      migrationProgress.total > 0
        ? Math.round((migrationProgress.current / migrationProgress.total) * 100)
        : 0;

    return (
      <div className="mb-4 rounded-xl border border-primary/30 bg-primary/10 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex-shrink-0">
            <Spinner size="sm" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-fg">Upgrading encryption...</h3>
            <p className="mt-1 text-body-sm text-fg-muted">
              Migrating file {migrationProgress.current} of {migrationProgress.total}
              {migrationProgress.currentFile && `: ${migrationProgress.currentFile}`}
            </p>
            <div className="mt-2">
              <Progress value={progressPercent} tone="primary" size="sm" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Prompt state
  return (
    <div className="mb-4 rounded-xl border border-accent/30 bg-gradient-to-r from-accent/10 to-primary/10 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 rounded-lg bg-accent/15 p-2 text-accent">
          <Shield className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="font-medium text-fg">Enhanced encryption available</h3>
          <p className="mt-1 text-body-sm text-fg-muted">
            {formatMigrationStats(migrationStats)}
          </p>

          {showDetails && (
            <div className="mt-3 rounded-lg border border-border bg-surface p-3 text-body-sm text-fg-muted">
              <p className="mb-2 font-medium text-fg">What&apos;s improved:</p>
              <ul className="list-inside list-disc space-y-1">
                <li>HKDF-based key derivation for stronger security</li>
                <li>Authenticated encryption with AAD prevents tampering</li>
                <li>Improved key isolation per file and chunk</li>
              </ul>
              <p className="mt-2 text-caption text-fg-subtle">
                Files will be re-downloaded, re-encrypted, and re-uploaded. This may take a while
                for large files.
              </p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {isSessionLocked ? (
              <div className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-surface-muted px-4 py-2 text-body-sm font-medium text-fg-subtle">
                <Lock className="h-4 w-4" />
                Unlock session to upgrade
              </div>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleMigrate()}
                leftIcon={<ArrowUpCircle className="h-4 w-4" />}
              >
                Upgrade now
              </Button>
            )}
            <Button
              variant="link"
              size="sm"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? 'Hide details' : 'Learn more'}
            </Button>
          </div>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          aria-label="Dismiss (remind me later)"
        >
          <X className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
};

export default MigrationBanner;
