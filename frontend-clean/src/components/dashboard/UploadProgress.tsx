import React from 'react';
import { CheckCircle, AlertCircle, Clock, Lock, Shield, RefreshCw } from 'lucide-react';
import { formatDuration, formatBytes } from '../../utils/helpers';
import type { UploadProgressProps, UploadItem } from './types';

/**
 * UploadProgress - Shows upload progress with ZK encryption support
 */
const UploadProgress: React.FC<UploadProgressProps> = ({ uploads, onCancel, onRetry, darkMode }) => {
  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <h3 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Uploads
      </h3>
      {Object.entries(uploads).map(([id, upload]: [string, UploadItem]) => (
        <div key={id} className="mb-3">
          <div className="flex justify-between items-center mb-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                {upload.name}
              </span>
              {upload.zkEnabled && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                  title="Zero-Knowledge Encrypted - Encrypting on your device"
                >
                  <Lock className="w-3 h-3" />
                  <span className="hidden sm:inline">Encrypting</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {upload.elapsedTime !== undefined && (
                <div className="flex items-center gap-1 text-xs text-gray-500">
                  <Clock size={12} />
                  {formatDuration(upload.elapsedTime)}
                </div>
              )}
              <span className="text-xs text-gray-500">
                {upload.totalChunks != null && upload.totalChunks > 0
                  ? `${upload.chunksUploaded ?? 0}/${upload.totalChunks} chunks`
                  : `${formatBytes(upload.bytesUploaded)} / ${formatBytes(upload.totalBytes)}`}
              </span>
              {upload.status === 'uploading' && (
                <button
                  onClick={() => onCancel(id)}
                  className="text-red-500 hover:text-red-600 text-xs font-medium"
                  title="Cancel upload"
                >
                  Cancel
                </button>
              )}
              {upload.status === 'complete' && (
                <CheckCircle size={16} className="text-green-500" />
              )}
              {upload.status === 'error' && <AlertCircle size={16} className="text-red-500" />}
              {upload.status === 'error' && onRetry && upload.canRetry && (
                <button
                  onClick={() => onRetry(id)}
                  className="text-blue-500 hover:text-blue-600 flex items-center gap-1 text-xs"
                  title="Retry upload"
                >
                  <RefreshCw size={14} />
                  Retry
                </button>
              )}
            </div>
          </div>
          <div
            className={`w-full h-2 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}
          >
            <div
              className={`h-2 rounded-full transition-all duration-300 ${
                upload.status === 'error'
                  ? 'bg-red-500'
                  : upload.zkEnabled
                    ? 'bg-gradient-to-r from-green-500 to-emerald-600'
                    : 'bg-gradient-to-r from-blue-500 to-purple-600'
              }`}
              style={{ width: `${upload.progress}%` }}
            />
          </div>
          {upload.error && (
            <p className="text-xs text-red-500 mt-1">{upload.error}</p>
          )}
          {upload.zkEnabled && upload.status === 'uploading' && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
              <Shield size={10} />
              Client-side encryption active
            </p>
          )}
        </div>
      ))}
    </div>
  );
};

export default UploadProgress;
