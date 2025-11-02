import React, { useState } from 'react';
import { Lock, Unlock, AlertCircle, Key } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';

/**
 * SessionUnlockModal Component
 *
 * Shown when the user's ZK encryption session expires or is manually locked.
 * Requires password re-entry to unlock and decrypt the master key.
 */
export default function SessionUnlockModal({ isOpen, onClose }) {
  const { darkMode } = useTheme();
  const { unlockSession, user } = useAuth();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unlocked, setUnlocked] = useState(false);

  if (!isOpen) return null;

  const handleUnlock = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const success = await unlockSession(password);
      if (success) {
        setUnlocked(true);
        setTimeout(() => {
          onClose();
          setPassword('');
          setUnlocked(false);
        }, 1000);
      } else {
        setError('Incorrect password. Please try again.');
      }
    } catch (err) {
      setError(err.message || 'Failed to unlock session. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`w-full max-w-md rounded-2xl shadow-2xl border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}>
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-xl ${unlocked ? 'bg-gradient-to-br from-green-500 to-emerald-600' : 'bg-gradient-to-br from-yellow-500 to-orange-600'}`}>
              {unlocked ? <Unlock className="text-white" size={24} /> : <Lock className="text-white" size={24} />}
            </div>
            <div>
              <h2 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {unlocked ? 'Session Unlocked!' : 'Session Locked'}
              </h2>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {unlocked ? 'Access granted' : 'Enter password to continue'}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {!unlocked ? (
            <>
              <div className={`mb-6 p-4 rounded-xl border ${
                darkMode ? 'bg-yellow-900/20 border-yellow-600/40' : 'bg-yellow-50 border-yellow-300'
              }`}>
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-yellow-500 flex-shrink-0" size={20} />
                  <div>
                    <p className={`text-sm font-medium ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}>
                      Your encryption session has been locked for security.
                    </p>
                    <p className={`text-xs mt-1 ${darkMode ? 'text-yellow-400' : 'text-yellow-700'}`}>
                      Enter your password to decrypt your files and continue working.
                    </p>
                  </div>
                </div>
              </div>

              {error && (
                <div className={`mb-6 p-4 rounded-xl border-2 ${
                  darkMode ? 'bg-red-900/20 border-red-600/40' : 'bg-red-50 border-red-400'
                }`}>
                  <div className="flex items-center gap-3">
                    <AlertCircle className="text-red-500 flex-shrink-0" size={20} />
                    <p className={`text-sm ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                      {error}
                    </p>
                  </div>
                </div>
              )}

              <form onSubmit={handleUnlock} className="space-y-4">
                {user && (
                  <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-900/50' : 'bg-gray-50'}`}>
                    <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                      Logged in as
                    </p>
                    <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {user.email || user.username}
                    </p>
                  </div>
                )}

                <div>
                  <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    Password
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                      <Key className={darkMode ? 'text-gray-500' : 'text-gray-400'} size={18} />
                    </div>
                    <input
                      type="password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      autoFocus
                      required
                      className={`w-full pl-11 pr-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !password}
                  className={`w-full py-3 rounded-xl font-semibold text-white transition-all ${
                    loading || !password
                      ? 'bg-gray-600 cursor-not-allowed opacity-50'
                      : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                  }`}
                >
                  {loading ? (
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      Unlocking...
                    </div>
                  ) : (
                    'Unlock Session'
                  )}
                </button>
              </form>
            </>
          ) : (
            <div className="text-center py-8">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 mb-4">
                <Unlock className="text-white" size={40} />
              </div>
              <p className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Session Unlocked!
              </p>
              <p className={`text-sm mt-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Your encryption keys are now available.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {!unlocked && (
          <div className={`p-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="text-center">
              <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                Can't remember your password?{' '}
                <button
                  type="button"
                  className={`${darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'} font-medium`}
                >
                  Use recovery phrase
                </button>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
