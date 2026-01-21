import React, { useState } from 'react';
import { Shield, ArrowUpCircle, X, Loader, CheckCircle, AlertTriangle, Lock } from 'lucide-react';
import { useStorage } from '../../contexts/StorageContext';
import { useAuth } from '../../contexts/AuthContext';
import type { MigrationStats, MigrationProgress, MigrationResult } from './types';
import { getErrorMessage } from './types';

/**
 * MigrationBanner Component
 *
 * Prompts users to migrate V1 encrypted files to V2.
 */
const MigrationBanner: React.FC = () => {
  const storageContext = useStorage();
  const migrationStats = storageContext.migrationStats as MigrationStats | null;
  const migrationInProgress = storageContext.migrationInProgress as boolean;
  const migrationProgress = storageContext.migrationProgress as MigrationProgress;
  const migrateAllFiles = storageContext.migrateAllFiles as () => Promise<MigrationResult>;
  const dismissMigrationPrompt = storageContext.dismissMigrationPrompt as () => void;
  const isMigrationPromptDismissed = storageContext.isMigrationPromptDismissed as () => boolean;
  const formatMigrationStats = storageContext.formatMigrationStats as (stats: unknown) => string;

  const { zkEnabled, zkSessionUnlocked } = useAuth();

  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Don't show if no migration needed or already dismissed
  if (!migrationStats?.migrationNeeded || isMigrationPromptDismissed()) {
    return null;
  }

  // Check if ZK session is locked
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

  // Show completion state
  if (migrationResult) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <CheckCircle className="text-green-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className="font-medium text-green-900">Migration Complete</h3>
            <p className="text-sm text-green-700 mt-1">
              {migrationResult.completed} file(s) upgraded to enhanced encryption.
              {migrationResult.failed > 0 && ` ${migrationResult.failed} file(s) failed.`}
              {migrationResult.skipped > 0 &&
                ` ${migrationResult.skipped} file(s) already up to date.`}
            </p>
          </div>
          <button onClick={() => setMigrationResult(null)} className="text-green-600 hover:text-green-800">
            <X size={18} />
          </button>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className="font-medium text-red-900">Migration Failed</h3>
            <p className="text-sm text-red-700 mt-1">{error}</p>
          </div>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">
            <X size={18} />
          </button>
        </div>
      </div>
    );
  }

  // Show progress state
  if (migrationInProgress) {
    const progressPercent =
      migrationProgress.total > 0
        ? Math.round((migrationProgress.current / migrationProgress.total) * 100)
        : 0;

    return (
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <Loader className="text-blue-600 flex-shrink-0 mt-0.5 animate-spin" size={20} />
          <div className="flex-1">
            <h3 className="font-medium text-blue-900">Upgrading Encryption...</h3>
            <p className="text-sm text-blue-700 mt-1">
              Migrating file {migrationProgress.current} of {migrationProgress.total}
              {migrationProgress.currentFile && `: ${migrationProgress.currentFile}`}
            </p>
            <div className="mt-2 w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show migration prompt
  return (
    <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-4 mb-4">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-purple-100 rounded-lg">
          <Shield className="text-purple-600" size={20} />
        </div>
        <div className="flex-1">
          <h3 className="font-medium text-gray-900">Enhanced Encryption Available</h3>
          <p className="text-sm text-gray-600 mt-1">{formatMigrationStats(migrationStats)}</p>

          {showDetails && (
            <div className="mt-3 p-3 bg-white/50 rounded-lg text-sm text-gray-600">
              <p className="font-medium text-gray-700 mb-2">What's improved:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>HKDF-based key derivation for stronger security</li>
                <li>Authenticated encryption with AAD prevents tampering</li>
                <li>Improved key isolation per file and chunk</li>
              </ul>
              <p className="mt-2 text-xs text-gray-500">
                Files will be re-downloaded, re-encrypted, and re-uploaded. This may take a while
                for large files.
              </p>
            </div>
          )}

          <div className="mt-3 flex items-center gap-3">
            {isSessionLocked ? (
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-500 rounded-lg text-sm font-medium cursor-not-allowed">
                <Lock size={16} />
                Unlock session to upgrade
              </div>
            ) : (
              <button
                onClick={handleMigrate}
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
              >
                <ArrowUpCircle size={16} />
                Upgrade Now
              </button>
            )}
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="text-sm text-purple-600 hover:text-purple-700"
            >
              {showDetails ? 'Hide details' : 'Learn more'}
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-gray-400 hover:text-gray-600"
          title="Dismiss (remind me later)"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
};

export default MigrationBanner;
