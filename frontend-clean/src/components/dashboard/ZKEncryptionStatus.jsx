import React, { useMemo, useState } from 'react';
import { Shield, ShieldCheck, Lock, Unlock, Key, ChevronDown, ChevronUp } from 'lucide-react';
import { ZK_STORAGE } from '../../config/constants';

/**
 * ZKEncryptionStatus - Compact encryption status bar for ZK users
 *
 * Shows:
 * - Session status (locked/unlocked) as a compact inline badge
 * - Encryption algorithm and key derivation info (expandable)
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
  const [isExpanded, setIsExpanded] = useState(false);

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
    <div className={`mb-2 rounded-lg border ${
      isUnlocked
        ? darkMode ? 'bg-green-900/10 border-green-800/50' : 'bg-green-50 border-green-200'
        : darkMode ? 'bg-yellow-900/10 border-yellow-800/50' : 'bg-yellow-50 border-yellow-200'
    }`}>
      {/* Compact main bar */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Status icon */}
          <div className={`p-1.5 rounded-lg ${
            isUnlocked
              ? darkMode ? 'bg-green-900/30' : 'bg-green-100'
              : darkMode ? 'bg-yellow-900/30' : 'bg-yellow-100'
          }`}>
            <ShieldCheck size={18} className={
              isUnlocked
                ? darkMode ? 'text-green-400' : 'text-green-600'
                : darkMode ? 'text-yellow-400' : 'text-yellow-600'
            } />
          </div>

          {/* Status text */}
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${
              isUnlocked
                ? darkMode ? 'text-green-300' : 'text-green-800'
                : darkMode ? 'text-yellow-300' : 'text-yellow-800'
            }`}>
              {isUnlocked ? 'Your encryption keys are active' : 'Session locked'}
            </span>

            {/* Encryption badge */}
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'
            }`}>
              AES-256-GCM
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Session Active Badge */}
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
            isUnlocked
              ? darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
              : darkMode ? 'bg-yellow-900/30 text-yellow-400' : 'bg-yellow-100 text-yellow-700'
          }`}>
            {isUnlocked ? <Unlock size={12} /> : <Lock size={12} />}
            <span>{isUnlocked ? 'Session Active' : 'Locked'}</span>
          </div>

          {/* Expand button */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`p-1.5 rounded-lg transition-colors ${
              darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
            }`}
            title={isExpanded ? 'Hide details' : 'Show details'}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {/* Lock Session Button - only show when unlocked */}
          {isUnlocked && onLock && (
            <button
              onClick={() => {
                if (window.confirm('Lock your encryption session? You\'ll need your password to unlock it again.')) {
                  onLock();
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                darkMode
                  ? 'bg-yellow-900/30 hover:bg-yellow-900/50 text-yellow-400 border border-yellow-800/50'
                  : 'bg-yellow-100 hover:bg-yellow-200 text-yellow-700 border border-yellow-300'
              }`}
            >
              <Lock size={14} />
              Lock Session
            </button>
          )}
        </div>
      </div>

      {/* Expandable details section */}
      {isExpanded && (
        <div className={`px-4 py-3 border-t ${
          darkMode ? 'border-gray-700/50' : 'border-gray-200'
        }`}>
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <Shield size={14} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
              <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Encryption:</span>
              <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                AES-256-GCM
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Key size={14} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
              <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Key Derivation:</span>
              <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {getKdfDisplayString()}
              </span>
            </div>
          </div>
          <p className={`mt-2 text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
            {isUnlocked
              ? 'You can upload, download, and manage your encrypted files.'
              : 'Enter your password to access your encrypted files.'}
          </p>
        </div>
      )}
    </div>
  );
}
