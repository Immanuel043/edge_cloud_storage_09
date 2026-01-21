import React from 'react';
import { X, CheckCircle, AlertCircle, Clock, Lock, Shield } from 'lucide-react';
import { formatBytes, formatDuration } from '../../utils/helpers';

export default function UploadProgress({ uploads, onCancel, darkMode }) {
  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <h3 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Uploads
      </h3>
      {Object.entries(uploads).map(([id, upload]) => (
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
              {upload.elapsedTime && (
                <div className="flex items-center gap-1 text-xs text-gray-500">
                  <Clock size={12} />
                  {formatDuration(upload.elapsedTime)}
                </div>
              )}
              <span className="text-xs text-gray-500">
                {upload.chunksUploaded}/{upload.totalChunks} chunks
              </span>
              {upload.status === 'uploading' && (
                <button
                  onClick={() => onCancel(id)}
                  className="text-red-500 hover:text-red-600"
                  title="Cancel upload"
                >
                  <X size={16} />
                </button>
              )}
              {upload.status === 'completed' && (
                <CheckCircle className="text-green-500" size={16} />
              )}
              {upload.status === 'error' && (
                <AlertCircle className="text-red-500" size={16} title={upload.error} />
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-1">
            <div
              className={`h-2 rounded-full transition-all ${
                upload.status === 'completed' ? 'bg-green-500' :
                upload.status === 'error' ? 'bg-red-500' :
                upload.zkEnabled ? 'bg-green-500' : 'bg-blue-500'
              }`}
              style={{ width: `${upload.progress}%` }}
            />
          </div>

          {/* ZK encryption status */}
          {upload.zkEnabled && upload.status === 'uploading' && (
            <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
              <Shield size={12} className="text-green-500" />
              <span>Encrypting chunks with AES-256-GCM before upload</span>
            </div>
          )}

          {/* Progress details */}
          <div className="flex justify-between items-center mt-1">
            <span className="text-xs text-gray-500">
              {formatBytes(upload.bytesUploaded || 0)} / {formatBytes(upload.totalSize || 0)}
            </span>
            <span className="text-xs text-gray-500">
              {upload.progress?.toFixed(1) || 0}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}