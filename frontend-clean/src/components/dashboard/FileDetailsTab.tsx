import React from 'react';
import {
  FileText, Calendar, HardDrive, MapPin,
  Edit2, Image, Video, Music, Archive, Code
} from 'lucide-react';
import { formatBytes, formatDate } from '../../utils/helpers';
import type { FileDetailsTabProps } from './types';

/**
 * FileDetailsTab - Displays detailed file information
 */
const FileDetailsTab: React.FC<FileDetailsTabProps> = ({ file, onRename, darkMode }) => {

  const getFileIcon = (): React.ReactElement => {
    const mimeType = file.mime_type || file.type || '';
    const name = file.name || '';

    if (mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name)) {
      return <Image size={20} className="text-blue-500" />;
    }
    if (mimeType.startsWith('video/') || /\.(mp4|avi|mov|wmv|webm)$/i.test(name)) {
      return <Video size={20} className="text-purple-500" />;
    }
    if (mimeType.startsWith('audio/') || /\.(mp3|wav|ogg|flac)$/i.test(name)) {
      return <Music size={20} className="text-pink-500" />;
    }
    if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar') || /\.(zip|tar|gz|rar|7z)$/i.test(name)) {
      return <Archive size={20} className="text-orange-500" />;
    }
    if (mimeType.includes('code') || mimeType.includes('javascript') || mimeType.includes('python') || /\.(js|py|java|cpp|html|css)$/i.test(name)) {
      return <Code size={20} className="text-green-500" />;
    }
    return <FileText size={20} className="text-gray-500" />;
  };

  const getFileFormat = (): string => {
    const name = file.name || '';
    const extension = name.split('.').pop();
    return extension ? extension.toUpperCase() : 'Unknown';
  };

  return (
    <div className="space-y-6">
      {/* File Name */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className={`text-sm font-semibold ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            File name
          </h3>
          {onRename && (
            <button
              onClick={() => onRename(file)}
              className={`p-1.5 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-600'
              }`}
              title="Rename file"
              type="button"
            >
              <Edit2 size={14} />
            </button>
          )}
        </div>
        <div className={`flex items-center gap-3 p-3 rounded-lg ${
          darkMode ? 'bg-gray-700/50' : 'bg-gray-50'
        }`}>
          {getFileIcon()}
          <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {file.name}
          </span>
        </div>
      </div>

      {/* File Type & Format */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Type
          </p>
          <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {file.mime_type || 'Unknown'}
          </p>
        </div>
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Format
          </p>
          <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {getFileFormat()}
          </p>
        </div>
      </div>

      {/* File Size */}
      <div>
        <p className={`text-sm font-semibold mb-2 ${
          darkMode ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Size
        </p>
        <div className={`flex items-center gap-2 text-sm ${
          darkMode ? 'text-gray-400' : 'text-gray-600'
        }`}>
          <HardDrive size={16} />
          <span>{formatBytes(file.size)}</span>
        </div>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Created
          </p>
          <div className={`flex items-center gap-2 text-sm ${
            darkMode ? 'text-gray-400' : 'text-gray-600'
          }`}>
            <Calendar size={16} />
            <span>{formatDate(file.created_at)}</span>
          </div>
        </div>
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Modified
          </p>
          <div className={`flex items-center gap-2 text-sm ${
            darkMode ? 'text-gray-400' : 'text-gray-600'
          }`}>
            <Calendar size={16} />
            <span>{formatDate(file.updated_at || file.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Pages (for PDFs) */}
      {file.pages && (
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Pages
          </p>
          <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {file.pages} {file.pages === 1 ? 'page' : 'pages'}
          </p>
        </div>
      )}

      {/* Location */}
      <div>
        <p className={`text-sm font-semibold mb-2 ${
          darkMode ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Location
        </p>
        <div className={`flex items-center gap-2 text-sm ${
          darkMode ? 'text-gray-400' : 'text-gray-600'
        }`}>
          <MapPin size={16} />
          <span>{file.folder_path || 'Cloud Drive'}</span>
        </div>
      </div>

      {/* Tags — Coming soon (no backend API yet) */}
      <div className="opacity-60">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <p className={`text-sm font-semibold ${
              darkMode ? 'text-gray-300' : 'text-gray-700'
            }`}>
              Tags
            </p>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              darkMode ? 'bg-gray-700 text-gray-400' : 'bg-gray-200 text-gray-500'
            }`}>
              Coming soon
            </span>
          </div>
        </div>
        <p className={`text-sm italic ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          File tagging will be available in a future update
        </p>
      </div>

      {/* Downloadable toggle removed — not functional (no backend support) */}
    </div>
  );
};

export default FileDetailsTab;
