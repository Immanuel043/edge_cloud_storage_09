import React, { useState, useCallback, useEffect } from 'react';
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
  Eye,
  EyeOff,
  ChevronRight,
  HardDrive,
  Database,
  Video,
  Search,
  RefreshCw
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import { generateZKRegistrationData, unlockZKSession } from '../../services/zkEncryptionService';
import * as zkAuthService from '../../services/zkAuthService';
import { ZK_STORAGE } from '../../config/constants';
import RecoverySettings from '../settings/RecoverySettings';
import type { SettingsViewProps, IndexStatus, ReindexResult, VideoOptimizationMode, VideoSettingsResponse } from './types';
import { getErrorMessage } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

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

// Helper function to format bytes
function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

type UpgradeStep = 1 | 2 | 3 | 4;

const SettingsView: React.FC<SettingsViewProps> = ({ darkMode }) => {
  const { user, zkEnabled } = useAuth();
  const { storageStats } = useStorage();

  // ZK Upgrade state
  const [showUpgradeModal, setShowUpgradeModal] = useState<boolean>(false);
  const [upgradeStep, setUpgradeStep] = useState<UpgradeStep>(1);
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [upgradeError, setUpgradeError] = useState<string>('');
  const [upgradeSuccess, setUpgradeSuccess] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // Video optimization settings
  const [videoMode, setVideoMode] = useState<VideoOptimizationMode>('keep_both');
  const [videoModeLoading, setVideoModeLoading] = useState<boolean>(false);
  const [videoModeError, setVideoModeError] = useState<string>('');

  // Search indexing state
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [isReindexing, setIsReindexing] = useState<boolean>(false);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);

  // Fetch current video optimization setting
  useEffect(() => {
    const fetchVideoSettings = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/users/settings/video-optimization`, {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json() as VideoSettingsResponse;
          setVideoMode(data.mode);
        }
      } catch (e: unknown) {
        console.error('Failed to fetch video settings:', e);
      }
    };
    fetchVideoSettings();
  }, []);

  // Fetch search index status
  useEffect(() => {
    const fetchIndexStatus = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/search/reindex/status`, {
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
      const response = await fetch(`${API_BASE_URL}/api/v1/search/reindex`, {
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

  const handleVideoModeChange = async (newMode: VideoOptimizationMode): Promise<void> => {
    setVideoModeLoading(true);
    setVideoModeError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/users/settings/video-optimization`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ mode: newMode })
      });
      if (response.ok) {
        setVideoMode(newMode);
      } else {
        throw new Error('Failed to update setting');
      }
    } catch (e: unknown) {
      const errorMessage = getErrorMessage(e);
      setVideoModeError(errorMessage);
    } finally {
      setVideoModeLoading(false);
    }
  };

  const resetUpgradeModal = useCallback((): void => {
    setShowUpgradeModal(false);
    setUpgradeStep(1);
    setNewPassword('');
    setConfirmPassword('');
    setUpgradeError('');
    setShowPassword(false);
  }, []);

  const validatePassword = useCallback((password: string): string | null => {
    if (password.length < 12) {
      return 'Password must be at least 12 characters';
    }
    if (!/[A-Z]/.test(password)) {
      return 'Password must contain at least one uppercase letter';
    }
    if (!/[a-z]/.test(password)) {
      return 'Password must contain at least one lowercase letter';
    }
    if (!/[0-9]/.test(password)) {
      return 'Password must contain at least one number';
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return 'Password must contain at least one special character';
    }
    return null;
  }, []);

  const handleUpgradeToZK = useCallback(async (): Promise<void> => {
    setUpgradeError('');
    setIsProcessing(true);

    try {
      // Validate passwords match
      if (newPassword !== confirmPassword) {
        throw new Error('Passwords do not match');
      }

      // Validate password strength
      const passwordError = validatePassword(newPassword);
      if (passwordError) {
        throw new Error(passwordError);
      }

      // Step 1: Generate ZK credentials using Argon2id
      console.log('Generating ZK credentials with Argon2id...');
      const zkRegData = await generateZKRegistrationData(newPassword);

      // Step 2: Call upgrade endpoint (includes Argon2id parameters)
      console.log('Upgrading account to ZK...');
      const response = await zkAuthService.upgradeToZK({
        passwordHash: zkRegData.passwordHash,
        encryptedMasterKey: zkRegData.encryptedMasterKey,
        masterKeyIV: zkRegData.masterKeyIV,
        kdfSalt: zkRegData.kdfSalt,
        kdfAlgorithm: zkRegData.kdfAlgorithm,
        kdfIterations: zkRegData.kdfIterations,
        kdfMemory: zkRegData.kdfMemory,
        kdfParallelism: zkRegData.kdfParallelism,
      });

      console.log('Upgrade successful:', response);

      // Step 3: Store zkData to localStorage for session persistence
      const zkDataObj: ZKData = {
        kdfSalt: zkRegData.kdfSalt,
        encryptedMasterKey: zkRegData.encryptedMasterKey,
        kdfAlgorithm: zkRegData.kdfAlgorithm,
        kdfIterations: zkRegData.kdfIterations,
        kdfMemory: zkRegData.kdfMemory,
        masterKeyIV: zkRegData.masterKeyIV,
      };

      console.log('Storing ZK data to localStorage...');
      localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
      localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, user?.email || '');
      localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));

      // Step 4: Unlock the session with the new credentials
      const unlocked = await unlockZKSession(newPassword, zkDataObj as Parameters<typeof unlockZKSession>[1]);

      if (!unlocked) {
        console.warn('Could not unlock session after upgrade, user will need to re-login');
      } else {
        console.log('ZK session unlocked successfully after upgrade');
      }

      setUpgradeSuccess(true);
      setUpgradeStep(4);

      // Auto-close after 3 seconds and reload
      setTimeout(() => {
        resetUpgradeModal();
        setUpgradeSuccess(false);
        // Reload the page to fully reflect the new state
        window.location.reload();
      }, 3000);

    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error('ZK upgrade failed:', error);
      setUpgradeError(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [newPassword, confirmPassword, validatePassword, resetUpgradeModal, user?.email]);

  const getPasswordStrength = useCallback((password: string): number => {
    let strength = 0;
    if (password.length >= 12) strength += 20;
    if (password.length >= 16) strength += 10;
    if (/[A-Z]/.test(password)) strength += 20;
    if (/[a-z]/.test(password)) strength += 20;
    if (/[0-9]/.test(password)) strength += 15;
    if (/[^A-Za-z0-9]/.test(password)) strength += 15;
    return Math.min(100, strength);
  }, []);

  const passwordStrength = getPasswordStrength(newPassword);

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

        {/* Video Optimization Settings - Only for non-ZK users */}
        {!zkEnabled && (
          <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}`}>
            <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              <Video size={20} />
              Video Optimization
            </h2>
            <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Choose how videos are processed after upload. Optimized videos use H.264 codec for better browser compatibility.
            </p>

            <div className="space-y-3">
              {([
                { value: 'keep_both' as VideoOptimizationMode, label: 'Keep Both Versions', desc: 'Store original + optimized (recommended)' },
                { value: 'replace_original' as VideoOptimizationMode, label: 'Replace Original', desc: 'Only keep optimized version (saves storage)' },
                { value: 'no_optimization' as VideoOptimizationMode, label: 'No Optimization', desc: 'Keep original only, skip processing' }
              ]).map(option => (
                <label
                  key={option.value}
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                    videoMode === option.value
                      ? darkMode ? 'border-blue-500 bg-blue-900/20' : 'border-blue-500 bg-blue-50'
                      : darkMode ? 'border-gray-700 hover:bg-gray-800' : 'border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  <input
                    type="radio"
                    name="videoMode"
                    value={option.value}
                    checked={videoMode === option.value}
                    onChange={() => handleVideoModeChange(option.value)}
                    disabled={videoModeLoading}
                    className="mt-1"
                  />
                  <div>
                    <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{option.label}</p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{option.desc}</p>
                  </div>
                </label>
              ))}
            </div>

            {videoModeError && (
              <p className="text-red-500 text-sm mt-2">{videoModeError}</p>
            )}
          </div>
        )}

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
            // ZK Not Enabled - Show upgrade option
            <div className="space-y-4">
              <div className={`flex items-center gap-3 p-3 rounded-lg ${darkMode ? 'bg-yellow-900/30' : 'bg-yellow-50'}`}>
                <AlertTriangle className="text-yellow-500" size={24} />
                <div>
                  <p className={`font-medium ${darkMode ? 'text-yellow-400' : 'text-yellow-700'}`}>
                    Standard Encryption
                  </p>
                  <p className={`text-sm ${darkMode ? 'text-yellow-300' : 'text-yellow-600'}`}>
                    Your files are encrypted at rest, but you can upgrade to zero-knowledge encryption for maximum security.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setShowUpgradeModal(true)}
                className="w-full flex items-center justify-between p-4 rounded-lg border-2 border-dashed border-blue-500 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all"
                type="button"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600">
                    <ShieldCheck className="text-white" size={24} />
                  </div>
                  <div className="text-left">
                    <p className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Upgrade to Zero-Knowledge Encryption
                    </p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      Enable end-to-end encryption for maximum privacy
                    </p>
                  </div>
                </div>
                <ChevronRight className={darkMode ? 'text-gray-400' : 'text-gray-500'} size={20} />
              </button>
            </div>
          )}
        </div>

        {/* Recovery Phrase Settings - Only for ZK users */}
        {zkEnabled && (
          <RecoverySettings />
        )}
      </div>

      {/* Upgrade Modal */}
      {showUpgradeModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className={`max-w-md w-full rounded-xl shadow-2xl ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            {/* Modal Header */}
            <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600">
                  <ShieldCheck className="text-white" size={24} />
                </div>
                <div>
                  <h3 className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Upgrade to Zero-Knowledge Encryption
                  </h3>
                  <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    Step {upgradeStep} of 4
                  </p>
                </div>
              </div>
            </div>

            {/* Modal Content */}
            <div className="p-6">
              {upgradeStep === 1 && (
                <div className="space-y-4">
                  <div className={`p-4 rounded-lg ${darkMode ? 'bg-blue-900/30' : 'bg-blue-50'}`}>
                    <h4 className={`font-semibold mb-2 ${darkMode ? 'text-blue-300' : 'text-blue-700'}`}>
                      What is Zero-Knowledge Encryption?
                    </h4>
                    <ul className={`text-sm space-y-2 ${darkMode ? 'text-blue-200' : 'text-blue-600'}`}>
                      <li>Your files are encrypted before leaving your device</li>
                      <li>Only you hold the encryption keys</li>
                      <li>Even we cannot read your files</li>
                      <li>Uses AES-256-GCM military-grade encryption</li>
                    </ul>
                  </div>
                  <div className={`p-4 rounded-lg ${darkMode ? 'bg-yellow-900/30' : 'bg-yellow-50'}`}>
                    <h4 className={`font-semibold mb-2 flex items-center gap-2 ${darkMode ? 'text-yellow-300' : 'text-yellow-700'}`}>
                      <AlertTriangle size={16} />
                      Important
                    </h4>
                    <ul className={`text-sm space-y-1 ${darkMode ? 'text-yellow-200' : 'text-yellow-600'}`}>
                      <li>You will need to set a new password</li>
                      <li>If you forget this password, your files cannot be recovered</li>
                      <li>We recommend setting up recovery phrase after upgrade</li>
                    </ul>
                  </div>
                </div>
              )}

              {upgradeStep === 2 && (
                <div className="space-y-4">
                  <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                    Create a strong password for your encrypted account. This password will be used to derive your encryption keys.
                  </p>

                  {/* New Password */}
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      New Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className={`w-full px-4 py-3 rounded-lg border ${
                          darkMode
                            ? 'bg-gray-700 border-gray-600 text-white'
                            : 'bg-white border-gray-300 text-gray-900'
                        } focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                        placeholder="Enter new password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2"
                      >
                        {showPassword ? (
                          <EyeOff size={20} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
                        ) : (
                          <Eye size={20} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
                        )}
                      </button>
                    </div>

                    {/* Password Strength */}
                    {newPassword && (
                      <div className="mt-2">
                        <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              passwordStrength < 40 ? 'bg-red-500' :
                              passwordStrength < 70 ? 'bg-yellow-500' : 'bg-green-500'
                            }`}
                            style={{ width: `${passwordStrength}%` }}
                          />
                        </div>
                        <p className={`text-xs mt-1 ${
                          passwordStrength < 40 ? 'text-red-500' :
                          passwordStrength < 70 ? 'text-yellow-500' : 'text-green-500'
                        }`}>
                          {passwordStrength < 40 ? 'Weak' :
                           passwordStrength < 70 ? 'Fair' : 'Strong'}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Confirm Password */}
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Confirm Password
                    </label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={`w-full px-4 py-3 rounded-lg border ${
                        darkMode
                          ? 'bg-gray-700 border-gray-600 text-white'
                          : 'bg-white border-gray-300 text-gray-900'
                      } focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                      placeholder="Confirm password"
                    />
                    {confirmPassword && newPassword !== confirmPassword && (
                      <p className="text-red-500 text-xs mt-1">Passwords do not match</p>
                    )}
                  </div>
                </div>
              )}

              {upgradeStep === 3 && (
                <div className="space-y-4">
                  <div className={`p-4 rounded-lg ${darkMode ? 'bg-red-900/30' : 'bg-red-50'}`}>
                    <h4 className={`font-semibold mb-2 flex items-center gap-2 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                      <AlertTriangle size={16} />
                      Final Confirmation
                    </h4>
                    <p className={`text-sm ${darkMode ? 'text-red-200' : 'text-red-600'}`}>
                      By proceeding, you acknowledge that:
                    </p>
                    <ul className={`text-sm space-y-1 mt-2 ${darkMode ? 'text-red-200' : 'text-red-600'}`}>
                      <li>Your old password will no longer work</li>
                      <li>You must remember your new encryption password</li>
                      <li>Lost passwords cannot be recovered without a recovery phrase</li>
                    </ul>
                  </div>

                  {upgradeError && (
                    <div className={`p-3 rounded-lg ${darkMode ? 'bg-red-900/50' : 'bg-red-100'} text-red-500`}>
                      {upgradeError}
                    </div>
                  )}
                </div>
              )}

              {upgradeStep === 4 && upgradeSuccess && (
                <div className="text-center py-8">
                  <div className="mx-auto w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
                    <CheckCircle className="text-green-500" size={40} />
                  </div>
                  <h4 className={`text-xl font-bold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Upgrade Successful!
                  </h4>
                  <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    Your account now uses zero-knowledge encryption.
                    The page will reload momentarily...
                  </p>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            {upgradeStep < 4 && (
              <div className={`p-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'} flex gap-3`}>
                <button
                  onClick={upgradeStep === 1 ? resetUpgradeModal : () => setUpgradeStep((upgradeStep - 1) as UpgradeStep)}
                  className={`flex-1 px-4 py-2 rounded-lg border ${
                    darkMode
                      ? 'border-gray-600 text-gray-300 hover:bg-gray-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                  disabled={isProcessing}
                  type="button"
                >
                  {upgradeStep === 1 ? 'Cancel' : 'Back'}
                </button>

                {upgradeStep < 3 ? (
                  <button
                    onClick={() => {
                      if (upgradeStep === 2) {
                        const error = validatePassword(newPassword);
                        if (error) {
                          setUpgradeError(error);
                          return;
                        }
                        if (newPassword !== confirmPassword) {
                          setUpgradeError('Passwords do not match');
                          return;
                        }
                        setUpgradeError('');
                      }
                      setUpgradeStep((upgradeStep + 1) as UpgradeStep);
                    }}
                    disabled={upgradeStep === 2 && (!newPassword || !confirmPassword)}
                    className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    type="button"
                  >
                    Continue
                  </button>
                ) : (
                  <button
                    onClick={handleUpgradeToZK}
                    disabled={isProcessing}
                    className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    type="button"
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="animate-spin" size={16} />
                        Upgrading...
                      </>
                    ) : (
                      'Upgrade Now'
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsView;
