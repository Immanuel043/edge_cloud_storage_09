import React, { useState } from 'react';
import { Shield, ArrowUpCircle, X, Loader, CheckCircle, AlertTriangle, Lock } from 'lucide-react';
import { useStorage } from '../../contexts/StorageContext';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import type { MigrationProgress, MigrationResult } from './types';
import { getErrorMessage } from './types';
import { formatMigrationStats, type MigrationStats } from '../../utils/zkMigration';

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

  const { zkEnabled, zkSessionUnlocked } = useAuth();
  const { darkMode } = useTheme();

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
      <div className={`border rounded-lg p-4 mb-4 ${darkMode ? 'bg-green-900/20 border-green-700' : 'bg-green-50 border-green-200'}`}>
        <div className="flex items-start gap-3">
          <CheckCircle className="text-green-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className={`font-medium ${darkMode ? 'text-green-400' : 'text-green-900'}`}>Migration Complete</h3>
            <p className={`text-sm mt-1 ${darkMode ? 'text-green-300' : 'text-green-700'}`}>
              {migrationResult.completed} file(s) upgraded to enhanced encryption.
              {migrationResult.failed > 0 && ` ${migrationResult.failed} file(s) failed.`}
              {migrationResult.skipped > 0 &&
                ` ${migrationResult.skipped} file(s) already up to date.`}
            </p>
          </div>
          <button onClick={() => setMigrationResult(null)} className={darkMode ? 'text-green-400 hover:text-green-300' : 'text-green-600 hover:text-green-800'}>
            <X size={18} />
          </button>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className={`border rounded-lg p-4 mb-4 ${darkMode ? 'bg-red-900/20 border-red-700' : 'bg-red-50 border-red-200'}`}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className={`font-medium ${darkMode ? 'text-red-400' : 'text-red-900'}`}>Migration Failed</h3>
            <p className={`text-sm mt-1 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>{error}</p>
          </div>
          <button onClick={() => setError(null)} className={darkMode ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-800'}>
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
      <div className={`border rounded-lg p-4 mb-4 ${darkMode ? 'bg-blue-900/20 border-blue-700' : 'bg-blue-50 border-blue-200'}`}>
        <div className="flex items-start gap-3">
          <Loader className="text-blue-600 flex-shrink-0 mt-0.5 animate-spin" size={20} />
          <div className="flex-1">
            <h3 className={`font-medium ${darkMode ? 'text-blue-400' : 'text-blue-900'}`}>Upgrading Encryption...</h3>
            <p className={`text-sm mt-1 ${darkMode ? 'text-blue-300' : 'text-blue-700'}`}>
              Migrating file {migrationProgress.current} of {migrationProgress.total}
              {migrationProgress.currentFile && `: ${migrationProgress.currentFile}`}
            </p>
            <div className={`mt-2 w-full rounded-full h-2 ${darkMode ? 'bg-blue-900' : 'bg-blue-200'}`}>
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
    <div className={`border rounded-lg p-4 mb-4 ${darkMode ? 'bg-gradient-to-r from-purple-900/20 to-blue-900/20 border-purple-700' : 'bg-gradient-to-r from-purple-50 to-blue-50 border-purple-200'}`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${darkMode ? 'bg-purple-900/30' : 'bg-purple-100'}`}>
          <Shield className="text-purple-600" size={20} />
        </div>
        <div className="flex-1">
          <h3 className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Enhanced Encryption Available</h3>
          <p className={`text-sm mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{formatMigrationStats(migrationStats)}</p>

          {showDetails && (
            <div className={`mt-3 p-3 rounded-lg text-sm ${darkMode ? 'bg-gray-800/50 text-gray-400' : 'bg-white/50 text-gray-600'}`}>
              <p className={`font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>What's improved:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>HKDF-based key derivation for stronger security</li>
                <li>Authenticated encryption with AAD prevents tampering</li>
                <li>Improved key isolation per file and chunk</li>
              </ul>
              <p className={`mt-2 text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                Files will be re-downloaded, re-encrypted, and re-uploaded. This may take a while
                for large files.
              </p>
            </div>
          )}

          <div className="mt-3 flex items-center gap-3">
            {isSessionLocked ? (
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-not-allowed ${darkMode ? 'bg-gray-700 text-gray-400' : 'bg-gray-200 text-gray-500'}`}>
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
              className={`text-sm ${darkMode ? 'text-purple-400 hover:text-purple-300' : 'text-purple-600 hover:text-purple-700'}`}
            >
              {showDetails ? 'Hide details' : 'Learn more'}
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className={darkMode ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}
          title="Dismiss (remind me later)"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
};

export default MigrationBanner;
