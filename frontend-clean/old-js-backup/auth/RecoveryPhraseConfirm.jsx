import React, { useState, useEffect } from 'react';
import { Shield, Check, X, AlertCircle } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * RecoveryPhraseConfirm Component
 *
 * Verifies that the user has correctly saved their recovery phrase
 * by asking them to enter specific words at random positions.
 */
export default function RecoveryPhraseConfirm({ recoveryPhrase, onConfirm, onCancel }) {
  const { darkMode } = useTheme();
  const [selectedWords, setSelectedWords] = useState([]);
  const [userInputs, setUserInputs] = useState({});
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);

  const words = recoveryPhrase.split(' ');

  // Generate 4 random word positions to verify
  useEffect(() => {
    const positions = [];
    while (positions.length < 4) {
      const random = Math.floor(Math.random() * 24);
      if (!positions.includes(random)) {
        positions.push(random);
      }
    }
    setSelectedWords(positions.sort((a, b) => a - b));
  }, []);

  const handleInputChange = (position, value) => {
    setUserInputs(prev => ({
      ...prev,
      [position]: value.trim().toLowerCase()
    }));
    setError('');
  };

  const handleVerify = () => {
    // Check if all inputs are correct
    const allCorrect = selectedWords.every(position => {
      const userWord = (userInputs[position] || '').toLowerCase();
      const correctWord = words[position].toLowerCase();
      return userWord === correctWord;
    });

    if (allCorrect) {
      setVerified(true);
      setError('');
      setTimeout(() => {
        onConfirm();
      }, 1000);
    } else {
      setError('Some words are incorrect. Please check your recovery phrase and try again.');
    }
  };

  const isComplete = selectedWords.every(position => userInputs[position]?.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`w-full max-w-lg rounded-2xl shadow-2xl border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}>
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-xl ${verified ? 'bg-gradient-to-br from-green-500 to-emerald-600' : 'bg-gradient-to-br from-blue-500 to-purple-600'}`}>
              {verified ? <Check className="text-white" size={24} /> : <Shield className="text-white" size={24} />}
            </div>
            <div>
              <h2 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {verified ? 'Verified!' : 'Verify Recovery Phrase'}
              </h2>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {verified ? 'Your recovery phrase is confirmed' : 'Enter the requested words to confirm'}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {!verified && (
            <>
              <div className={`mb-6 p-4 rounded-xl border ${
                darkMode ? 'bg-blue-900/20 border-blue-600/40' : 'bg-blue-50 border-blue-300'
              }`}>
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-blue-500 flex-shrink-0" size={20} />
                  <p className={`text-sm ${darkMode ? 'text-blue-300' : 'text-blue-800'}`}>
                    To verify you've saved your recovery phrase, please enter the words at the positions indicated below.
                  </p>
                </div>
              </div>

              {error && (
                <div className={`mb-6 p-4 rounded-xl border-2 ${
                  darkMode ? 'bg-red-900/20 border-red-600/40' : 'bg-red-50 border-red-400'
                }`}>
                  <div className="flex items-center gap-3">
                    <X className="text-red-500 flex-shrink-0" size={20} />
                    <p className={`text-sm font-medium ${darkMode ? 'text-red-300' : 'text-red-800'}`}>
                      {error}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {selectedWords.map((position) => (
                  <div key={position}>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Word #{position + 1}
                    </label>
                    <input
                      type="text"
                      placeholder={`Enter word #${position + 1}`}
                      value={userInputs[position] || ''}
                      onChange={(e) => handleInputChange(position, e.target.value)}
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none font-mono ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      }`}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {verified && (
            <div className="text-center py-8">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 mb-4">
                <Check className="text-white" size={40} />
              </div>
              <p className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Recovery Phrase Verified!
              </p>
              <p className={`text-sm mt-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Your account is now secured with zero-knowledge encryption.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {!verified && (
          <div className={`p-6 border-t flex gap-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <button
              onClick={onCancel}
              className={`flex-1 px-6 py-3 rounded-xl font-medium transition-all ${
                darkMode
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              Go Back
            </button>
            <button
              onClick={handleVerify}
              disabled={!isComplete}
              className={`flex-1 px-6 py-3 rounded-xl font-semibold text-white transition-all ${
                isComplete
                  ? 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                  : 'bg-gray-600 cursor-not-allowed opacity-50'
              }`}
            >
              Verify
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
