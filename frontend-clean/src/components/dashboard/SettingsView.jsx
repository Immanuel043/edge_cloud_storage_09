import React, { useState, useCallback, useMemo } from 'react';
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
  Database
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import { generateZKRegistrationData, unlockZKSession } from '../../services/zkEncryptionService';
import * as zkAuthService from '../../services/zkAuthService';
import { ZK_STORAGE } from '../../config/constants';

// Get KDF display string from localStorage
function getKdfDisplayString() {
  try {
    const zkDataStr = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
    if (zkDataStr) {
      const zkData = JSON.parse(zkDataStr);
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
  } catch (e) {
    console.warn('Failed to read ZK data:', e);
  }
  // Default to Argon2id (primary algorithm)
  return 'Argon2id key derivation (64MB memory, 3 iterations)';
}

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export default function SettingsView({ darkMode }) {
  const { user, zkEnabled, refreshUser } = useAuth();
  const { storageStats } = useStorage();

  // ZK Upgrade state
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeStep, setUpgradeStep] = useState(1); // 1: info, 2: password, 3: confirm, 4: processing
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const resetUpgradeModal = useCallback(() => {
    setShowUpgradeModal(false);
    setUpgradeStep(1);
    setNewPassword('');
    setConfirmPassword('');
    setUpgradeError('');
    setShowPassword(false);
  }, []);

  const validatePassword = useCallback((password) => {
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

  const handleUpgradeToZK = useCallback(async () => {
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
      const zkDataObj = {
        kdfSalt: zkRegData.kdfSalt,
        encryptedMasterKey: zkRegData.encryptedMasterKey,
        kdfAlgorithm: zkRegData.kdfAlgorithm,
        kdfIterations: zkRegData.kdfIterations,
        kdfMemory: zkRegData.kdfMemory,  // Argon2id memory parameter
        masterKeyIV: zkRegData.masterKeyIV,
      };

      console.log('Storing ZK data to localStorage...');
      localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
      localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, user?.email || '');
      localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));

      // Step 4: Unlock the session with the new credentials
      const unlocked = await unlockZKSession(newPassword, zkDataObj);

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

    } catch (error) {
      console.error('ZK upgrade failed:', error);
      setUpgradeError(error.message || 'Failed to upgrade account');
    } finally {
      setIsProcessing(false);
    }
  }, [newPassword, confirmPassword, validatePassword, resetUpgradeModal]);

  const getPasswordStrength = useCallback((password) => {
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
                  {storageStats?.files_count || storageStats?.fileCount || 0}
                </p>
              </div>
            </div>
          </div>
        </div>

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
                  onClick={upgradeStep === 1 ? resetUpgradeModal : () => setUpgradeStep(upgradeStep - 1)}
                  className={`flex-1 px-4 py-2 rounded-lg border ${
                    darkMode
                      ? 'border-gray-600 text-gray-300 hover:bg-gray-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                  disabled={isProcessing}
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
                      setUpgradeStep(upgradeStep + 1);
                    }}
                    disabled={upgradeStep === 2 && (!newPassword || !confirmPassword)}
                    className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Continue
                  </button>
                ) : (
                  <button
                    onClick={handleUpgradeToZK}
                    disabled={isProcessing}
                    className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
}
