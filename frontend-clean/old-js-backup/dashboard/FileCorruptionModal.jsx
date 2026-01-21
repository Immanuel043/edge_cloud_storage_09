import { AlertTriangle, RefreshCw, Mail, X } from 'lucide-react';

export default function FileCorruptionModal({ isOpen, onClose, fileName, errorMessage, darkMode }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`w-full max-w-lg rounded-2xl shadow-2xl border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}>
        {/* Header */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-xl bg-gradient-to-br from-red-500 to-orange-600">
                <AlertTriangle className="text-white" size={24} />
              </div>
              <div>
                <h2 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  File Corruption Detected
                </h2>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Unable to decrypt file
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className={`p-2 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'
              }`}
            >
              <X size={20} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Error Description */}
          <div className={`p-4 rounded-xl border ${
            darkMode ? 'bg-red-900/20 border-red-600/40' : 'bg-red-50 border-red-300'
          }`}>
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={20} />
              <div>
                <p className={`text-sm font-medium ${darkMode ? 'text-red-300' : 'text-red-800'}`}>
                  The file <span className="font-semibold">"{fileName}"</span> could not be decrypted.
                </p>
                <p className={`text-xs mt-2 ${darkMode ? 'text-red-400' : 'text-red-700'}`}>
                  {errorMessage || 'The file may have been tampered with or corrupted during storage.'}
                </p>
              </div>
            </div>
          </div>

          {/* What this means */}
          <div>
            <h3 className={`text-sm font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              What does this mean?
            </h3>
            <ul className={`text-sm space-y-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              <li>• The encrypted file data failed authentication</li>
              <li>• The file may have been modified or corrupted</li>
              <li>• Network errors during upload may have occurred</li>
              <li>• Storage system issues may have affected the file</li>
            </ul>
          </div>

          {/* Suggested Actions */}
          <div>
            <h3 className={`text-sm font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              What can you do?
            </h3>

            <div className="space-y-3">
              {/* Option 1: Re-upload */}
              <div className={`p-4 rounded-xl border ${
                darkMode ? 'bg-gray-900/50 border-gray-700' : 'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-start gap-3">
                  <RefreshCw className={darkMode ? 'text-blue-400' : 'text-blue-600'} size={20} />
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Re-upload the file
                    </p>
                    <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      Delete this corrupted file and upload it again from your device.
                    </p>
                  </div>
                </div>
              </div>

              {/* Option 2: Contact Support */}
              <div className={`p-4 rounded-xl border ${
                darkMode ? 'bg-gray-900/50 border-gray-700' : 'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-start gap-3">
                  <Mail className={darkMode ? 'text-purple-400' : 'text-purple-600'} size={20} />
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Contact support
                    </p>
                    <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      If this problem persists, our team can investigate.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Technical Details (collapsible) */}
          <details className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
            <summary className="cursor-pointer font-medium">Technical Details</summary>
            <div className={`mt-2 p-3 rounded-lg font-mono ${
              darkMode ? 'bg-gray-900' : 'bg-gray-100'
            }`}>
              {errorMessage}
            </div>
          </details>
        </div>

        {/* Footer */}
        <div className={`p-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:scale-[1.02] transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
