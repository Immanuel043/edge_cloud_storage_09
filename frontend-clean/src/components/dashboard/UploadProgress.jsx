import React from 'react';
import { X, CheckCircle, AlertCircle, Clock } from 'lucide-react';
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
            <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              {upload.name}
            </span>
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
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                upload.status === 'completed' ? 'bg-green-500' :
                upload.status === 'error' ? 'bg-red-500' : 'bg-blue-500'
              }`}
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}