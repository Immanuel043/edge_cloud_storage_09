import { X, Download, Lock, Shield, CheckCircle, AlertCircle } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';

export default function DownloadProgress({ downloads, onCancel, darkMode }) {
  if (!downloads || Object.keys(downloads).length === 0) {
    return null;
  }

  return (
    <div className={`mb-6 p-4 rounded-lg shadow-lg ${darkMode ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200'}`}>
      <h3 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Downloads
      </h3>
      {Object.entries(downloads).map(([id, download]) => (
        <div key={id} className="mb-4 last:mb-0">
          <div className="flex justify-between items-center mb-2">
            <div className="flex items-center gap-2">
              <Download size={16} className={darkMode ? 'text-blue-400' : 'text-blue-600'} />
              <span className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
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
              {download.status === 'completed' && (
                <CheckCircle className="text-green-500" size={16} />
              )}
              {download.status === 'error' && (
                <AlertCircle className="text-red-500" size={16} title={download.error} />
              )}
            </div>
          </div>

          {/* Dual progress bars for ZK downloads */}
          {download.isZK ? (
            <div className="space-y-2">
              {/* Download progress */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs text-gray-500">
                    {download.currentStage === 'downloading' ? 'Downloading...' : 'Downloaded'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {download.downloadProgress?.toFixed(0) || 0}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${
                      download.currentStage === 'downloading' ? 'bg-blue-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${download.downloadProgress || 0}%` }}
                  />
                </div>
              </div>

              {/* Decryption progress */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-1">
                    <Shield size={12} className="text-green-500" />
                    <span className="text-xs text-gray-500">
                      {download.currentStage === 'decrypting' ? 'Decrypting...' :
                       download.decryptProgress === 100 ? 'Decrypted' : 'Pending'}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {download.decryptProgress?.toFixed(0) || 0}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full bg-green-500 transition-all"
                    style={{ width: `${download.decryptProgress || 0}%` }}
                  />
                </div>
              </div>

              {/* Chunk details */}
              {download.chunksDecrypted !== undefined && (
                <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                  <span>
                    Chunk {download.currentChunk || 0} / {download.totalChunks || 0}
                  </span>
                  <span>•</span>
                  <span>
                    {formatBytes(download.bytesDownloaded || 0)} / {formatBytes(download.totalBytes || 0)}
                  </span>
                </div>
              )}

              {/* ZK encryption info */}
              {download.currentStage === 'decrypting' && (
                <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
                  <Shield size={12} className="text-green-500" />
                  <span>
                    Decrypting with AES-256-GCM on your device
                    {download.streaming && download.workersActive !== undefined && (
                      <span className="ml-1 text-blue-500 font-semibold">
                        (Streaming: {download.workersActive} workers active)
                      </span>
                    )}
                  </span>
                </div>
              )}

              {/* Streaming mode indicator */}
              {download.streaming && (
                <div className="flex items-center gap-1 text-xs text-blue-500 mt-1">
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                  </svg>
                  <span>Parallel streaming decryption enabled</span>
                </div>
              )}
            </div>
          ) : (
            /* Standard download progress */
            <div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-1">
                <div
                  className={`h-2 rounded-full transition-all ${
                    download.status === 'completed' ? 'bg-green-500' :
                    download.status === 'error' ? 'bg-red-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${download.progress || 0}%` }}
                />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-500">
                  {formatBytes(download.bytesDownloaded || 0)} / {formatBytes(download.totalBytes || 0)}
                </span>
                <span className="text-xs text-gray-500">
                  {download.progress?.toFixed(1) || 0}%
                </span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
