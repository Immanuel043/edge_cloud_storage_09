import React from 'react';
import { X, Download, Lock, Shield, CheckCircle, AlertCircle } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import type { DownloadProgressProps, DownloadItem } from './types';

/**
 * DownloadProgress - Shows download progress with ZK decryption support
 */
const DownloadProgress: React.FC<DownloadProgressProps> = ({ downloads, onCancel, darkMode }) => {
  if (!downloads || Object.keys(downloads).length === 0) {
    return null;
  }

  return (
    <div
      className={`mb-6 p-4 rounded-lg shadow-lg ${darkMode ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200'}`}
    >
      <h3 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Downloads
      </h3>
      {Object.entries(downloads).map(([id, download]: [string, DownloadItem]) => (
        <div key={id} className="mb-4 last:mb-0">
          <div className="flex justify-between items-center mb-2">
            <div className="flex items-center gap-2">
              <Download size={16} className={darkMode ? 'text-blue-400' : 'text-blue-600'} />
              <span
                className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
              >
                {download.fileName}
              </span>
              {download.isZK && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                  title="Zero-Knowledge Encrypted - Decrypting on your device"
                >
                  <Lock className="w-3 h-3" />
                  <span className="hidden sm:inline">ZK</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {download.status === 'downloading' && onCancel && (
                <button
                  onClick={() => onCancel(id)}
                  className="text-red-500 hover:text-red-600"
                  title="Cancel download"
                >
                  <X size={16} />
                </button>
              )}
              {download.status === 'complete' && (
                <CheckCircle size={16} className="text-green-500" />
              )}
              {download.status === 'error' && <AlertCircle size={16} className="text-red-500" />}
            </div>
          </div>

          {/* Progress info */}
          <div className="flex items-center justify-between mb-1">
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {download.isZK && download.status === 'decrypting'
                ? 'Decrypting...'
                : download.chunksDownloaded !== undefined && download.totalChunks !== undefined
                  ? `${download.chunksDownloaded}/${download.totalChunks} chunks`
                  : `${download.progress}%`}
            </span>
            {download.bytesDownloaded !== undefined && download.totalBytes !== undefined && (
              <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {formatBytes(download.bytesDownloaded)} / {formatBytes(download.totalBytes)}
              </span>
            )}
          </div>

          {/* Progress bar */}
          <div className={`w-full h-2 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
            <div
              className={`h-2 rounded-full transition-all duration-300 ${
                download.status === 'error'
                  ? 'bg-red-500'
                  : download.isZK
                    ? 'bg-gradient-to-r from-green-500 to-emerald-600'
                    : 'bg-gradient-to-r from-blue-500 to-purple-600'
              }`}
              style={{ width: `${download.progress}%` }}
            />
          </div>

          {/* ZK Decryption progress */}
          {download.isZK &&
            download.status === 'decrypting' &&
            download.decryptionProgress !== undefined && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Shield size={10} />
                    Client-side decryption
                  </span>
                  <span className="text-xs text-green-600 dark:text-green-400">
                    {download.decryptionProgress}%
                  </span>
                </div>
                <div className={`w-full h-1 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
                  <div
                    className="h-1 rounded-full bg-green-500 transition-all duration-300"
                    style={{ width: `${download.decryptionProgress}%` }}
                  />
                </div>
              </div>
            )}

          {/* Error message */}
          {download.error && <p className="text-xs text-red-500 mt-1">{download.error}</p>}

          {/* Success message for ZK */}
          {download.isZK && download.status === 'complete' && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
              <Shield size={10} />
              Securely decrypted on your device
            </p>
          )}
        </div>
      ))}
    </div>
  );
};

export default DownloadProgress;
