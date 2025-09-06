import React from 'react';
import { Folder, Download, Share2, Trash2, Eye, Check, Cloud, HardDrive } from 'lucide-react';
import { formatBytes, formatDate, getFileIcon, isImageFile, sanitizeInput } from '../../utils/helpers';

export default function FileList({ 
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
    <div className="space-y-2">
      {/* Table header */}
      <div className={`grid grid-cols-12 gap-4 px-3 py-2 text-sm font-medium ${
        darkMode ? 'text-gray-400' : 'text-gray-600'
      }`}>
        <div className="col-span-1"></div>
        <div className="col-span-5">Name</div>
        <div className="col-span-2">Size</div>
        <div className="col-span-2">Modified</div>
        <div className="col-span-1">Tier</div>
        <div className="col-span-1">Actions</div>
      </div>

      {/* Folders */}
      {folders.map(folder => (
        <div
          key={folder.id}
          onClick={() => onFolderClick(folder.id)}
          className={`grid grid-cols-12 gap-4 p-3 rounded-lg cursor-pointer transition-all ${
            darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'
          }`}
        >
          <div className="col-span-1">
            <Folder className="text-blue-500" size={24} />
          </div>
          <div className={`col-span-5 font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {sanitizeInput(folder.name)}
          </div>
          <div className="col-span-2 text-gray-500">-</div>
          <div className="col-span-2 text-gray-500">{formatDate(folder.created_at)}</div>
          <div className="col-span-2"></div>
        </div>
      ))}

      {/* Files */}
      {files.map(file => (
        <div
          key={file.id}
          className={`grid grid-cols-12 gap-4 p-3 rounded-lg transition-all ${
            darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'
          } ${selectedFiles.has(file.id) ? 'ring-2 ring-blue-500' : ''}`}
        >
          <div className="col-span-1 flex items-center gap-2">
            <div
              onClick={(e) => {
                e.stopPropagation();
                onFileClick(file.id);
              }}
              className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer ${
                selectedFiles.has(file.id) 
                  ? 'bg-blue-500 border-blue-500' 
                  : darkMode ? 'border-gray-500 bg-gray-600' : 'border-gray-300 bg-white'
              }`}
            >
              {selectedFiles.has(file.id) && <Check size={14} className="text-white" />}
            </div>
            {getFileIcon(file.name, 24)}
          </div>
          <div className={`col-span-5 font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {sanitizeInput(file.name)}
          </div>
          <div className="col-span-2 text-gray-500">{formatBytes(file.size)}</div>
          <div className="col-span-2 text-gray-500">{formatDate(file.created_at)}</div>
          <div className="col-span-1 flex justify-center">
            {file.storage_tier === 'cache' && <Cloud size={16} className="text-blue-400" />}
            {file.storage_tier === 'warm' && <HardDrive size={16} className="text-green-400" />}
            {file.storage_tier === 'cold' && <HardDrive size={16} className="text-gray-400" />}
          </div>
          <div className="col-span-1 flex gap-1">
            {isImageFile(file.name) && (
              <button
                onClick={() => onFilePreview(file)}
                className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
                title="Preview"
              >
                <Eye size={16} />
              </button>
            )}
            <button
              onClick={() => onFileDownload(file.id, file.name)}
              className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
              title="Download"
            >
              <Download size={16} />
            </button>
            <button
              onClick={() => onFileShare(file.id)}
              className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
              title="Share"
            >
              <Share2 size={16} />
            </button>
            <button
              onClick={() => onFileDelete(file.id)}
              className={`p-1 rounded ${darkMode ? 'hover:bg-gray-500' : 'hover:bg-gray-200'}`}
              title="Delete"
            >
              <Trash2 size={16} className="text-red-500" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}