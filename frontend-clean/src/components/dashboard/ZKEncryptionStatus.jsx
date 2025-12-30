import React, { useMemo, useState } from 'react';
import { Shield, ShieldCheck, Lock, Unlock, Key, ChevronDown, ChevronUp, AlertTriangle, X } from 'lucide-react';
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
  const [showLockConfirm, setShowLockConfirm] = useState(false);

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
              onClick={() => setShowLockConfirm(true)}
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

      {/* Lock Session Confirmation Modal */}
      {showLockConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className={`w-full max-w-sm rounded-2xl shadow-2xl border ${
            darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
          }`}>
            {/* Header */}
            <div className={`p-5 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-yellow-500 to-orange-600">
                    <Lock className="text-white" size={20} />
                  </div>
                  <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Lock Session?
                  </h3>
                </div>
                <button
                  onClick={() => setShowLockConfirm(false)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
                  }`}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-5">
              <div className={`p-4 rounded-xl border ${
                darkMode ? 'bg-yellow-900/20 border-yellow-700/40' : 'bg-yellow-50 border-yellow-200'
              }`}>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={18} />
                  <div>
                    <p className={`text-sm font-medium ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}>
                      Your encryption keys will be cleared
                    </p>
                    <p className={`text-xs mt-1 ${darkMode ? 'text-yellow-400/80' : 'text-yellow-700'}`}>
                      You'll need to enter your password to access your encrypted files again.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className={`p-5 border-t flex gap-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <button
                onClick={() => setShowLockConfirm(false)}
                className={`flex-1 px-4 py-2.5 rounded-xl font-medium transition-colors ${
                  darkMode
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLockConfirm(false);
                  onLock();
                }}
                className="flex-1 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-yellow-500 to-orange-600 hover:from-yellow-600 hover:to-orange-700 transition-all"
              >
                Lock Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
