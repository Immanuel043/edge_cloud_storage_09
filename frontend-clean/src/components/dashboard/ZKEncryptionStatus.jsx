import React, { useMemo } from 'react';
import { Shield, ShieldCheck, Lock, Unlock, Key, AlertTriangle } from 'lucide-react';
import { ZK_STORAGE } from '../../config/constants';

/**
 * ZKEncryptionStatus - Displays encryption information for ZK users
 *
 * Shows:
 * - Session status (locked/unlocked)
 * - Encryption algorithm
 * - Key derivation info
 * - Lock session button
 */
export default function ZKEncryptionStatus({
  isUnlocked,
  onLock,
  darkMode,
  kdfAlgorithm: propKdfAlgorithm,
  kdfIterations: propKdfIterations,
  kdfMemory: propKdfMemory,
}) {
  // Get KDF info from localStorage if not provided as props
  const { kdfAlgorithm, kdfIterations, kdfMemory } = useMemo(() => {
    // Use props if provided
    if (propKdfAlgorithm) {
      return {
        kdfAlgorithm: propKdfAlgorithm,
        kdfIterations: propKdfIterations || 3,
        kdfMemory: propKdfMemory || 65536,
      };
    }

    // Otherwise try to get from localStorage
    try {
      const zkDataStr = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
      if (zkDataStr) {
        const zkData = JSON.parse(zkDataStr);
        return {
          kdfAlgorithm: zkData.kdfAlgorithm || 'argon2id',
          kdfIterations: zkData.kdfIterations || 3,
          kdfMemory: zkData.kdfMemory || 65536,
        };
      }
    } catch (e) {
      console.warn('Failed to read ZK data from localStorage:', e);
    }

    // Default to Argon2id (primary algorithm)
    return {
      kdfAlgorithm: 'argon2id',
      kdfIterations: 3,
      kdfMemory: 65536,
    };
  }, [propKdfAlgorithm, propKdfIterations, propKdfMemory]);

  // Format KDF display string based on algorithm
  const getKdfDisplayString = () => {
    if (kdfAlgorithm === 'argon2id') {
      const memoryMB = Math.round(kdfMemory / 1024);
      return `Argon2id (${memoryMB}MB, ${kdfIterations} iterations)`;
    } else {
      // PBKDF2 fallback for low-memory devices
      const iterationsK = Math.round(kdfIterations / 1000);
      return `PBKDF2 (${iterationsK}K iterations)`;
    }
  };
  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          Encryption Status
        </h2>
        {isUnlocked ? (
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
            darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
          }`}>
            <Unlock size={12} />
            <span>Session Active</span>
          </div>
        ) : (
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
            darkMode ? 'bg-yellow-900/30 text-yellow-400' : 'bg-yellow-100 text-yellow-700'
          }`}>
            <Lock size={12} />
            <span>Session Locked</span>
          </div>
        )}
      </div>

      {/* Status Card */}
      <div className={`p-4 rounded-lg mb-4 ${
        isUnlocked
          ? darkMode ? 'bg-green-900/20 border border-green-800' : 'bg-green-50 border border-green-200'
          : darkMode ? 'bg-yellow-900/20 border border-yellow-800' : 'bg-yellow-50 border border-yellow-200'
      }`}>
        <div className="flex items-start gap-3">
          {isUnlocked ? (
            <ShieldCheck className={darkMode ? 'text-green-400' : 'text-green-600'} size={24} />
          ) : (
            <AlertTriangle className={darkMode ? 'text-yellow-400' : 'text-yellow-600'} size={24} />
          )}
          <div>
            <p className={`font-medium ${
              isUnlocked
                ? darkMode ? 'text-green-300' : 'text-green-800'
                : darkMode ? 'text-yellow-300' : 'text-yellow-800'
            }`}>
              {isUnlocked
                ? 'Your encryption keys are active'
                : 'Your encryption session is locked'}
            </p>
            <p className={`text-sm mt-1 ${
              isUnlocked
                ? darkMode ? 'text-green-400' : 'text-green-700'
                : darkMode ? 'text-yellow-400' : 'text-yellow-700'
            }`}>
              {isUnlocked
                ? 'You can upload, download, and manage your encrypted files.'
                : 'Enter your password to access your encrypted files.'}
            </p>
          </div>
        </div>
      </div>

      {/* Encryption Details */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
            <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Encryption
            </span>
          </div>
          <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            AES-256-GCM
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
            <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Key Derivation
            </span>
          </div>
          <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {getKdfDisplayString()}
          </span>
        </div>
      </div>

      {/* Lock Button - only show when unlocked */}
      {isUnlocked && onLock && (
        <button
          onClick={() => {
            if (window.confirm('Lock your encryption session? You\'ll need your password to unlock it again.')) {
              onLock();
            }
          }}
          className={`mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            darkMode
              ? 'bg-yellow-900/30 hover:bg-yellow-900/50 text-yellow-400 border border-yellow-800'
              : 'bg-yellow-50 hover:bg-yellow-100 text-yellow-700 border border-yellow-300'
          }`}
        >
          <Lock size={16} />
          Lock Session
        </button>
      )}
    </div>
  );
}
