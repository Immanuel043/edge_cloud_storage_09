import React, { useState, useEffect } from 'react';
import {
  Shield,
  ShieldCheck,
  Lock,
  User,
  Mail,
  Key,
  AlertTriangle,
  CheckCircle,
  Loader2,
  HardDrive,
  Database,
  Search,
  RefreshCw
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import { ZK_STORAGE } from '../../config/constants';
import RecoverySettings from '../settings/RecoverySettings';
import type { SettingsViewProps, IndexStatus, ReindexResult } from './types';
import { getErrorMessage } from './types';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';

interface ZKData {
  kdfSalt?: string;
  encryptedMasterKey?: string;
  kdfAlgorithm?: string;
  kdfIterations?: number;
  kdfMemory?: number;
  masterKeyIV?: string;
}

// Get KDF display string from localStorage
function getKdfDisplayString(): string {
  try {
    const zkDataStr = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
    if (zkDataStr) {
      const zkData = JSON.parse(zkDataStr) as ZKData;
      const algorithm = zkData.kdfAlgorithm || 'argon2id';
      const iterations = zkData.kdfIterations || 3;
      const memory = zkData.kdfMemory || 65536;

      if (algorithm === 'argon2id') {
        const memoryMB = Math.round(memory / 1024);
        return `Argon2id key derivation (${memoryMB}MB memory, ${iterations} iterations)`;
      } else {
        const iterationsK = Math.round(iterations / 1000);
        return `PBKDF2 key derivation (${iterationsK.toLocaleString()}K iterations)`;
      }
    }
  } catch (e: unknown) {
    console.warn('Failed to read ZK data:', e);
  }
  // Default to Argon2id (primary algorithm)
  return 'Argon2id key derivation (64MB memory, 3 iterations)';
}


const SettingsView: React.FC<SettingsViewProps> = ({ darkMode }) => {
  const { user, zkEnabled } = useAuth();
  const { storageStats } = useStorage();

  // Search indexing state
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [isReindexing, setIsReindexing] = useState<boolean>(false);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);

  // Fetch search index status
  useEffect(() => {
    const fetchIndexStatus = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_URL}/api/v1/search/reindex/status`, {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json() as IndexStatus;
          setIndexStatus(data);
        }
      } catch (e: unknown) {
        console.error('Failed to fetch index status:', e);
      }
    };
    fetchIndexStatus();
  }, [reindexResult]);

  // Handle re-indexing
  const handleReindex = async (): Promise<void> => {
    setIsReindexing(true);
    setReindexResult(null);
    try {
      const response = await fetch(`${API_URL}/api/v1/search/reindex`, {
        method: 'POST',
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json() as ReindexResult;
        setReindexResult(data);
      } else {
        const error = await response.json() as { detail?: string };
        setReindexResult({ success: false, message: error.detail || 'Re-indexing failed' });
      }
    } catch (e: unknown) {
      const errorMessage = getErrorMessage(e);
      setReindexResult({ success: false, message: errorMessage });
    } finally {
      setIsReindexing(false);
    }
  };

  return (
    <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <h1 className={`text-2xl font-bold mb-6 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Settings
      </h1>

      {/* Account Section */}
      <div className="space-y-6">
        {/* User Info */}
        <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}`}>
          <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            <User size={20} />
            Account Information
          </h2>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Mail size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
              <span className={darkMode ? 'text-gray-300' : 'text-gray-700'}>{user?.email}</span>
            </div>
            <div className="flex items-center gap-3">
              <User size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
              <span className={darkMode ? 'text-gray-300' : 'text-gray-700'}>{user?.username}</span>
            </div>
          </div>
        </div>

        {/* Storage Usage Section */}
        <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}`}>
          <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            <HardDrive size={20} />
            Storage Usage
          </h2>
          <div className="space-y-4">
            {/* Storage Progress Bar */}
            <div>
              <div className="flex justify-between mb-2">
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {formatBytes(storageStats?.used || 0)} used
                </span>
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {formatBytes(storageStats?.total || 107374182400)} total
                </span>
              </div>
              <div className={`h-3 rounded-full overflow-hidden ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    ((storageStats?.used || 0) / (storageStats?.total || 107374182400)) > 0.9
                      ? 'bg-red-500'
                      : ((storageStats?.used || 0) / (storageStats?.total || 107374182400)) > 0.7
                        ? 'bg-yellow-500'
                        : 'bg-blue-500'
                  }`}
                  style={{
                    width: `${Math.min(100, ((storageStats?.used || 0) / (storageStats?.total || 107374182400)) * 100)}%`
                  }}
                />
              </div>
            </div>

            {/* Storage Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <Database size={14} className={darkMode ? 'text-blue-400' : 'text-blue-500'} />
                  <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Available</span>
                </div>
                <p className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {formatBytes((storageStats?.total || 107374182400) - (storageStats?.used || 0))}
                </p>
              </div>
              <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <HardDrive size={14} className={darkMode ? 'text-green-400' : 'text-green-500'} />
                  <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Files</span>
                </div>
                <p className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {String(storageStats?.files_count || storageStats?.fileCount || 0)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Search & Indexing Section - Only for non-ZK users */}
        {!zkEnabled && (
          <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}`}>
            <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              <Search size={20} />
              Search & Indexing
            </h2>
            <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Manage search indexing for your files. Re-index if search is not finding your files.
            </p>

            {/* Index Status */}
            {indexStatus && (
              <div className={`p-3 rounded-lg mb-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Elasticsearch Status:</span>
                    <span className={`ml-2 font-medium ${
                      indexStatus.elasticsearch_status === 'connected' 
                        ? 'text-green-500' 
                        : 'text-red-500'
                    }`}>
                      {indexStatus.elasticsearch_status === 'connected' ? '● Connected' : '● Disconnected'}
                    </span>
                  </div>
                  <div>
                    <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Sync Status:</span>
                    <span className={`ml-2 font-medium ${
                      indexStatus.sync_status === 'synced' 
                        ? 'text-green-500' 
                        : 'text-yellow-500'
                    }`}>
                      {indexStatus.sync_status === 'synced' ? '✓ Synced' : '⚠ Out of sync'}
                    </span>
                  </div>
                  <div>
                    <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Files in Database:</span>
                    <span className={`ml-2 font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {String(indexStatus.database_files)}
                    </span>
                  </div>
                  <div>
                    <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Files Indexed:</span>
                    <span className={`ml-2 font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {String(indexStatus.indexed_files)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Re-index Button */}
            <button
              onClick={handleReindex}
              disabled={isReindexing}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                isReindexing
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
              }`}
              type="button"
            >
              {isReindexing ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Re-indexing...
                </>
              ) : (
                <>
                  <RefreshCw size={18} />
                  Re-index All Files
                </>
              )}
            </button>

            {/* Re-index Result */}
            {reindexResult && (
              <div className={`mt-4 p-3 rounded-lg ${
                reindexResult.success 
                  ? darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-50 text-green-700'
                  : darkMode ? 'bg-red-900/30 text-red-400' : 'bg-red-50 text-red-700'
              }`}>
                <div className="flex items-center gap-2">
                  {reindexResult.success ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
                  <span className="font-medium">{reindexResult.message}</span>
                </div>
                {reindexResult.success && reindexResult.indexed !== undefined && (
                  <div className="text-sm mt-1">
                    Indexed: {reindexResult.indexed} | Failed: {reindexResult.failed || 0} | Total: {reindexResult.total || 0}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Security Section */}
        <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}`}>
          <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            <Shield size={20} />
            Security & Encryption
          </h2>

          {zkEnabled ? (
            // ZK Enabled - Show status
            <div className="space-y-4">
              <div className={`flex items-center gap-3 p-3 rounded-lg ${darkMode ? 'bg-green-900/30' : 'bg-green-50'}`}>
                <ShieldCheck className="text-green-500" size={24} />
                <div>
                  <p className={`font-medium ${darkMode ? 'text-green-400' : 'text-green-700'}`}>
                    Zero-Knowledge Encryption Enabled
                  </p>
                  <p className={`text-sm ${darkMode ? 'text-green-300' : 'text-green-600'}`}>
                    Your files are encrypted end-to-end. Only you can decrypt them.
                  </p>
                </div>
              </div>
              <div className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                <p className="flex items-center gap-2">
                  <Lock size={14} />
                  Client-side encryption with AES-256-GCM
                </p>
                <p className="flex items-center gap-2 mt-1">
                  <Key size={14} />
                  {getKdfDisplayString()}
                </p>
              </div>
            </div>
          ) : (
            // ZK Not Enabled - Show server-side encryption status
            <div className="space-y-4">
              <div className={`flex items-center gap-3 p-3 rounded-lg ${darkMode ? 'bg-green-900/30' : 'bg-green-50'}`}>
                <ShieldCheck className="text-green-500" size={24} />
                <div>
                  <p className={`font-medium ${darkMode ? 'text-green-400' : 'text-green-700'}`}>
                    Server-Side Encryption Active
                  </p>
                  <p className={`text-sm ${darkMode ? 'text-green-300' : 'text-green-600'}`}>
                    Your files are encrypted at rest with AES-256.
                  </p>
                </div>
              </div>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                For Zero-Knowledge end-to-end encryption, create a separate ZK account from the registration page.
              </p>
            </div>
          )}
        </div>

        {/* Recovery Phrase Settings - Only for ZK users */}
        {zkEnabled && (
          <RecoverySettings />
        )}
      </div>

      {/* Upgrade Modal */}
    </div>
  );
};

export default SettingsView;
