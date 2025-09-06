import React from 'react';
import { Folder, File, Download, Share2, Trash2, Eye, Check, Cloud, HardDrive } from 'lucide-react';
import { formatBytes, formatDate, getFileIcon, isImageFile, sanitizeInput } from '../../utils/helpers';

export default function FileGrid({ 
  folders, 
  files, 
  selectedFiles,
  onFolderClick, 
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  darkMode 
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {/* Folders */}
      {folders.map(folder => (
        <div
          key={folder.id}
          onClick={() => onFolderClick(folder.id)}
          className={`p-4 rounded-lg cursor-pointer transition-all ${
            darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'
          }`}
        >
          <div className="flex flex-col items-center">
            <Folder className="text-blue-500" size={48} />
            <p className={`text-sm mt-2 text-center font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {sanitizeInput(folder.name)}
            </p>
            <p className="text-xs text-gray-500 mt-1">{formatDate(folder.created_at)}</p>
          </div>
        </div>
      ))}

      {/* Files */}
      {files.map(file => (
        <div
          key={file.id}
          className={`p-4 rounded-lg relative group ${
            darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'
          } ${selectedFiles.has(file.id) ? 'ring-2 ring-blue-500' : ''}`}
        >
          {/* Selection checkbox */}
          <div
            className="absolute top-2 left-2 z-10"
            onClick={(e) => {
              e.stopPropagation();
              onFileClick(file.id);
            }}
          >
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
              selectedFiles.has(file.id) 
                ? 'bg-blue-500 border-blue-500' 
                : darkMode ? 'border-gray-500 bg-gray-600' : 'border-gray-300 bg-white'
            }`}>
              {selectedFiles.has(file.id) && <Check size={14} className="text-white" />}
            </div>
          </div>

          {/* Storage tier indicator */}
          <div className="absolute top-2 right-2">
            {file.storage_tier === 'cache' && <Cloud size={16} className="text-blue-400" />}
            {file.storage_tier === 'warm' && <HardDrive size={16} className="text-green-400" />}
            {file.storage_tier === 'cold' && <HardDrive size={16} className="text-gray-400" />}
          </div>

          <div className="flex flex-col items-center">
            {getFileIcon(file.name, 48)}
            <p className={`text-sm mt-2 text-center font-medium truncate w-full ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`} title={file.name}>
              {sanitizeInput(file.name)}
            </p>
            <p className="text-xs text-gray-500">
              {formatBytes(file.size)}
            </p>
            <p className="text-xs text-gray-500">
              {formatDate(file.created_at)}
            </p>
          </div>
          
          {/* Actions */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {isImageFile(file.name) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onFilePreview(file);
                }}
                className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
                title="Preview"
              >
                <Eye size={14} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileDownload(file.id, file.name);
              }}
              className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
              title="Download"
            >
              <Download size={14} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileShare(file.id);
              }}
              className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
              title="Share"
            >
              <Share2 size={14} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileDelete(file.id);
              }}
              className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
              title="Delete"
            >
              <Trash2 size={14} className="text-red-500" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}