import React, { useState } from 'react';
import {
  Shield,
  Copy,
  Check,
  AlertTriangle,
  Download,
  Eye,
  EyeOff,
  Printer,
} from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import type { RecoveryPhraseSetupProps } from './types';
import { getErrorMessage } from './types';

/**
 * RecoveryPhraseSetup Component
 *
 * Displays the 24-word BIP39 recovery phrase to the user.
 * This is shown ONLY ONCE during initial setup.
 * The user must copy or download it before continuing.
 */
const RecoveryPhraseSetup: React.FC<RecoveryPhraseSetupProps> = ({
  recoveryPhrase,
  onConfirm,
  onSkip,
}) => {
  const { darkMode } = useTheme();
  const [copied, setCopied] = useState<boolean>(false);
  const [showPhrase, setShowPhrase] = useState<boolean>(false);
  const [acknowledged, setAcknowledged] = useState<boolean>(false);

  const words = recoveryPhrase.split(' ');

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(recoveryPhrase);
      // Clear clipboard after 60 seconds for security
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, 60000);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.error('Failed to copy:', getErrorMessage(err));
    }
  };

  const handleDownload = (): void => {
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

  const handlePrint = (): void => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow pop-ups to print your recovery phrase.');
      return;
    }

    const date = new Date().toLocaleString();
    const wordsHtml = words
      .map(
        (word, index) => `<div class="word"><span class="num">${index + 1}.</span> ${word}</div>`
      )
      .join('');

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Recovery Phrase - Edge Cloud Storage</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            padding: 40px;
            max-width: 800px;
            margin: 0 auto;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #333;
          }
          .header h1 {
            font-size: 24px;
            margin-bottom: 8px;
          }
          .header p {
            color: #666;
            font-size: 14px;
          }
          .warning {
            background: #fff3cd;
            border: 2px solid #ffc107;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 30px;
          }
          .warning h2 {
            color: #856404;
            font-size: 16px;
            margin-bottom: 8px;
          }
          .warning p {
            color: #856404;
            font-size: 13px;
          }
          .words-container {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 30px;
          }
          .word {
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 12px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
          }
          .word .num {
            color: #999;
            margin-right: 8px;
          }
          .security-notes {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 20px;
          }
          .security-notes h3 {
            font-size: 14px;
            margin-bottom: 10px;
          }
          .security-notes ul {
            font-size: 12px;
            color: #666;
            padding-left: 20px;
          }
          .security-notes li {
            margin-bottom: 4px;
          }
          .footer {
            text-align: center;
            color: #999;
            font-size: 12px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
          }
          @media print {
            body { padding: 20px; }
            .warning { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Zero-Knowledge Recovery Phrase</h1>
          <p>Edge Cloud Storage - Generated: ${date}</p>
        </div>

        <div class="warning">
          <h2>CRITICAL: Keep This Document Safe</h2>
          <p>This recovery phrase is the ONLY way to recover your account if you forget your password.
          Store it in a secure location. We cannot help you recover it.</p>
        </div>

        <div class="words-container">
          ${wordsHtml}
        </div>

        <div class="security-notes">
          <h3>Security Guidelines:</h3>
          <ul>
            <li>Never share this phrase with anyone</li>
            <li>Store this document in a secure, offline location</li>
            <li>Consider storing copies in multiple secure locations</li>
            <li>Do not take photos or store digitally</li>
            <li>Anyone with this phrase can access your encrypted files</li>
          </ul>
        </div>

        <div class="footer">
          <p>Edge Cloud Storage - Zero-Knowledge Encryption</p>
        </div>
      </body>
      </html>
    `);

    printWindow.document.close();

    // Wait for content to load then print
    setTimeout(() => {
      printWindow.print();
    }, 250);
  };

  const handleContinue = (): void => {
    if (!acknowledged) {
      alert('Please acknowledge that you have saved your recovery phrase.');
      return;
    }
    onConfirm();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm overflow-y-auto">
      <div
        className={`w-full max-w-2xl max-h-[95vh] flex flex-col my-auto rounded-2xl shadow-2xl border ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
      >
        {/* Header - Fixed */}
        <div
          className={`p-3 sm:p-5 border-b flex-shrink-0 ${
            darkMode ? 'border-gray-700' : 'border-gray-200'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
              <Shield className="text-white" size={20} />
            </div>
            <div>
              <h2
                className={`text-lg sm:text-xl font-bold ${
                  darkMode ? 'text-white' : 'text-gray-900'
                }`}
              >
                Save Your Recovery Phrase
              </h2>
              <p className={`text-xs sm:text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                This is shown only once - store it safely
              </p>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Warning Banner */}
          <div
            className={`mx-3 sm:mx-5 mt-3 sm:mt-4 p-3 rounded-xl border-2 ${
              darkMode ? 'bg-yellow-900/20 border-yellow-600/40' : 'bg-yellow-50 border-yellow-400'
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={16} />
              <div>
                <p
                  className={`font-semibold text-sm ${
                    darkMode ? 'text-yellow-300' : 'text-yellow-800'
                  }`}
                >
                  Critical: Save This Recovery Phrase
                </p>
                <p
                  className={`text-xs mt-1 ${darkMode ? 'text-yellow-400' : 'text-yellow-700'}`}
                >
                  This is the ONLY way to recover your account if you forget your password.
                </p>
              </div>
            </div>
          </div>

          {/* Recovery Phrase Display */}
          <div className="p-3 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <label
                className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
              >
                24-Word Recovery Phrase
              </label>
              <button
                onClick={() => setShowPhrase(!showPhrase)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs sm:text-sm transition-colors ${
                  darkMode
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                {showPhrase ? <EyeOff size={14} /> : <Eye size={14} />}
                {showPhrase ? 'Hide' : 'Show'}
              </button>
            </div>

            <div
              className={`p-3 sm:p-4 rounded-xl border-2 ${
                darkMode ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-300'
              }`}
            >
              {showPhrase ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {words.map((word, index) => (
                    <div
                      key={index}
                      className={`p-2 rounded-lg text-center ${
                        darkMode ? 'bg-gray-800' : 'bg-white'
                      } border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}
                    >
                      <span
                        className={`text-[10px] block ${
                          darkMode ? 'text-gray-500' : 'text-gray-400'
                        }`}
                      >
                        {index + 1}
                      </span>
                      <span
                        className={`font-mono text-xs sm:text-sm font-medium ${
                          darkMode ? 'text-white' : 'text-gray-900'
                        }`}
                      >
                        {word}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <Eye
                    className={`mx-auto mb-2 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`}
                    size={36}
                  />
                  <p className={`text-sm ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    Click &quot;Show&quot; to reveal your recovery phrase
                  </p>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-2 mt-3">
              <button
                onClick={() => void handleCopy()}
                disabled={!showPhrase}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg font-medium text-sm transition-all ${
                  showPhrase
                    ? darkMode
                      ? 'bg-gray-700 hover:bg-gray-600 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                    : 'opacity-50 cursor-not-allowed bg-gray-700 text-gray-500'
                }`}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>
              </button>
              <button
                onClick={handleDownload}
                disabled={!showPhrase}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg font-medium text-sm transition-all ${
                  showPhrase
                    ? darkMode
                      ? 'bg-gray-700 hover:bg-gray-600 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                    : 'opacity-50 cursor-not-allowed bg-gray-700 text-gray-500'
                }`}
              >
                <Download size={16} />
                <span className="hidden sm:inline">Download</span>
              </button>
              <button
                onClick={handlePrint}
                disabled={!showPhrase}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg font-medium text-sm transition-all ${
                  showPhrase
                    ? darkMode
                      ? 'bg-gray-700 hover:bg-gray-600 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
                    : 'opacity-50 cursor-not-allowed bg-gray-700 text-gray-500'
                }`}
              >
                <Printer size={16} />
                <span className="hidden sm:inline">Print</span>
              </button>
            </div>

            {/* Acknowledgment Checkbox */}
            <div
              className={`mt-4 p-3 rounded-xl border-2 ${
                acknowledged
                  ? darkMode
                    ? 'bg-green-900/20 border-green-600/40'
                    : 'bg-green-50 border-green-400'
                  : darkMode
                    ? 'bg-gray-800/50 border-gray-700'
                    : 'bg-gray-50 border-gray-200'
              }`}
            >
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setAcknowledged(e.target.checked)
                  }
                  className="mt-0.5 rounded border-gray-300 text-green-500 focus:ring-green-500"
                />
                <div className="flex-1">
                  <p
                    className={`font-medium text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}
                  >
                    I have safely stored my recovery phrase
                  </p>
                  <p
                    className={`text-xs mt-0.5 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}
                  >
                    I understand that losing this phrase means permanent loss of access to my
                    encrypted files.
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Footer - Fixed */}
        <div
          className={`p-3 sm:p-4 border-t flex gap-2 flex-shrink-0 ${
            darkMode ? 'border-gray-700' : 'border-gray-200'
          }`}
        >
          {onSkip && (
            <button
              onClick={onSkip}
              className={`flex-1 px-4 py-2.5 rounded-xl font-medium text-sm transition-all ${
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
            className={`flex-1 px-4 py-2.5 rounded-xl font-semibold text-sm text-white transition-all ${
              acknowledged
                ? 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700'
                : 'bg-gray-600 cursor-not-allowed opacity-50'
            }`}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecoveryPhraseSetup;
