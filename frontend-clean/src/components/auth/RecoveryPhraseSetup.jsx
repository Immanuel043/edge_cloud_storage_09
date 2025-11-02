import React, { useState } from 'react';
import { Shield, Copy, Check, AlertTriangle, Download, Eye, EyeOff } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * RecoveryPhraseSetup Component
 *
 * Displays the 24-word BIP39 recovery phrase to the user.
 * This is shown ONLY ONCE during initial setup.
 * The user must copy or download it before continuing.
 */
export default function RecoveryPhraseSetup({ recoveryPhrase, onConfirm, onSkip }) {
  const { darkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const words = recoveryPhrase.split(' ');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryPhrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDownload = () => {
    const content = `ZERO-KNOWLEDGE RECOVERY PHRASE
=================================

IMPORTANT: Store this recovery phrase in a safe place.
This is the ONLY way to recover your account if you forget your password.

Recovery Phrase (24 words):
${recoveryPhrase}

Generated: ${new Date().toISOString()}

⚠️ SECURITY WARNINGS:
- Never share this phrase with anyone
- Store it offline in a secure location
- Do not store it digitally (screenshots, cloud storage, etc.)
- Anyone with this phrase can access your encrypted files

=================================
Edge Cloud Storage - Zero-Knowledge Encryption
`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recovery-phrase-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleContinue = () => {
    if (!acknowledged) {
      alert('Please acknowledge that you have saved your recovery phrase.');
      return;
    }
    onConfirm();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`w-full max-w-2xl rounded-2xl shadow-2xl border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}>
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
              <Shield className="text-white" size={24} />
            </div>
            <div>
              <h2 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Save Your Recovery Phrase
              </h2>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                This is shown only once - store it safely
              </p>
            </div>
          </div>
        </div>

        {/* Warning Banner */}
        <div className={`mx-6 mt-6 p-4 rounded-xl border-2 ${
          darkMode ? 'bg-yellow-900/20 border-yellow-600/40' : 'bg-yellow-50 border-yellow-400'
        }`}>
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-yellow-500 flex-shrink-0" size={20} />
            <div>
              <p className={`font-semibold ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}>
                Critical: Save This Recovery Phrase
              </p>
              <p className={`text-sm mt-1 ${darkMode ? 'text-yellow-400' : 'text-yellow-700'}`}>
                This is the ONLY way to recover your account if you forget your password.
                We cannot help you recover it because we never see your encryption keys.
              </p>
            </div>
          </div>
        </div>

        {/* Recovery Phrase Display */}
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <label className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              24-Word Recovery Phrase
            </label>
            <button
              onClick={() => setShowPhrase(!showPhrase)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              {showPhrase ? <EyeOff size={16} /> : <Eye size={16} />}
              {showPhrase ? 'Hide' : 'Show'}
            </button>
          </div>

          <div className={`p-6 rounded-xl border-2 ${
            darkMode ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-300'
          }`}>
            {showPhrase ? (
              <div className="grid grid-cols-3 gap-3">
                {words.map((word, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded-lg ${
                      darkMode ? 'bg-gray-800' : 'bg-white'
                    } border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}
                  >
                    <span className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      {index + 1}.
                    </span>
                    <span className={`ml-2 font-mono font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {word}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <Eye className={`mx-auto mb-3 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={48} />
                <p className={`${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                  Click "Show" to reveal your recovery phrase
                </p>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <button
              onClick={handleCopy}
              disabled={!showPhrase}
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all ${
                showPhrase
                  ? darkMode
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                  : 'opacity-50 cursor-not-allowed bg-gray-700 text-gray-500'
              }`}
            >
              {copied ? <Check size={18} /> : <Copy size={18} />}
              {copied ? 'Copied!' : 'Copy to Clipboard'}
            </button>
            <button
              onClick={handleDownload}
              disabled={!showPhrase}
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all ${
                showPhrase
                  ? darkMode
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                  : 'opacity-50 cursor-not-allowed bg-gray-700 text-gray-500'
              }`}
            >
              <Download size={18} />
              Download as Text File
            </button>
          </div>

          {/* Acknowledgment Checkbox */}
          <div className={`mt-6 p-4 rounded-xl border-2 ${
            acknowledged
              ? darkMode ? 'bg-green-900/20 border-green-600/40' : 'bg-green-50 border-green-400'
              : darkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-50 border-gray-200'
          }`}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1 rounded border-gray-300 text-green-500 focus:ring-green-500"
              />
              <div className="flex-1">
                <p className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  I have safely stored my recovery phrase
                </p>
                <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  I understand that losing this phrase means permanent loss of access to my encrypted files.
                  Edge Cloud Storage cannot recover this for me.
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className={`p-6 border-t flex gap-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          {onSkip && (
            <button
              onClick={onSkip}
              className={`flex-1 px-6 py-3 rounded-xl font-medium transition-all ${
                darkMode
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              Skip for Now
            </button>
          )}
          <button
            onClick={handleContinue}
            disabled={!acknowledged}
            className={`flex-1 px-6 py-3 rounded-xl font-semibold text-white transition-all ${
              acknowledged
                ? 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02]'
                : 'bg-gray-600 cursor-not-allowed opacity-50'
            }`}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
