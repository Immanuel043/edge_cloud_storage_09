import React, { useState } from 'react';
import { Folder, File, Download, Share2, Trash2, Eye, Check, Cloud, HardDrive, Clock, MoreVertical } from 'lucide-react';
import { formatBytes, formatDate, getFileIcon, isImageFile, sanitizeInput } from '../../utils/helpers';
import FileThumbnail from './FileThumbnail';

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
  onVersionHistory,
  darkMode
}) {
  const [openMenuId, setOpenMenuId] = useState(null);
  const [hoveredMenuId, setHoveredMenuId] = useState(null);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {/* Folders */}
      {folders.map(folder => (
        <div
          key={folder.id}
          onClick={() => onFolderClick(folder.id)}
          className={`group p-5 rounded-xl cursor-pointer transition-all border ${
            darkMode
              ? 'bg-gray-800/50 hover:bg-gray-700/50 border-gray-700 hover:border-gray-600'
              : 'bg-white hover:bg-blue-50/30 border-gray-200 hover:border-blue-200'
          } hover:shadow-lg`}
        >
          <div className="flex flex-col items-center">
            <div className={`p-4 rounded-xl transition-colors ${
              darkMode ? 'bg-blue-500/10 group-hover:bg-blue-500/20' : 'bg-blue-50 group-hover:bg-blue-100'
            }`}>
              <Folder className="text-blue-500" size={36} />
            </div>
            <p className={`text-sm mt-4 text-center font-medium truncate w-full px-2 ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`} title={folder.name}>
              {sanitizeInput(folder.name)}
            </p>
            <p className={`text-xs mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              {formatDate(folder.created_at)}
            </p>
          </div>
        </div>
      ))}

      {/* Files */}
      {files.map(file => (
        <div
          key={file.id}
          className={`p-5 rounded-xl relative group transition-all border ${
            darkMode
              ? 'bg-gray-800/50 hover:bg-gray-700/50 border-gray-700 hover:border-gray-600'
              : 'bg-white hover:bg-gray-50 border-gray-200 hover:border-gray-300'
          } ${selectedFiles.has(file.id) ? 'ring-2 ring-blue-500 ring-offset-2' : ''} hover:shadow-lg`}
        >
          {/* Selection checkbox */}
          <div
            className="absolute top-3 left-3 z-10"
            onClick={(e) => {
              e.stopPropagation();
              onFileClick(file.id);
            }}
          >
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-all ${
              selectedFiles.has(file.id)
                ? 'bg-blue-500 border-blue-500 scale-110'
                : darkMode
                  ? 'border-gray-500 hover:border-gray-400'
                  : 'border-gray-300 hover:border-gray-400'
            }`}
            title="Select file">
              {selectedFiles.has(file.id) && <Check size={14} className="text-white" />}
            </div>
          </div>

          {/* Menu */}
          <div className="absolute top-3 right-3">
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === file.id ? null : file.id);
                }}
                onMouseEnter={() => setHoveredMenuId(file.id)}
                onMouseLeave={() => setHoveredMenuId(null)}
                className={`p-1.5 rounded-lg transition-all ${
                  darkMode ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-200 text-gray-700'
                } ${openMenuId === file.id ? 'bg-gray-700' : ''}`}
              >
                <MoreVertical size={16} />
              </button>

              {/* Custom Tooltip */}
              {hoveredMenuId === file.id && (
                <div className={`absolute -top-8 right-0 px-2 py-1 rounded text-xs whitespace-nowrap pointer-events-none ${
                  darkMode ? 'bg-gray-800 text-white' : 'bg-gray-100 text-black'
                }`}>
                  More actions
                </div>
              )}

              {openMenuId === file.id && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setOpenMenuId(null)}
                  />
                  <div className={`absolute right-0 top-8 z-20 w-52 rounded-xl shadow-2xl border overflow-hidden ${
                    darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                  }`}>
                    <div className="py-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFilePreview(file);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Eye size={16} className="text-blue-500" />
                        <span className="font-medium">Preview</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFileDownload(file.id, file.name);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Download size={16} className="text-green-500" />
                        <span className="font-medium">Download</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFileShare(file.id);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Share2 size={16} className="text-purple-500" />
                        <span className="font-medium">Share</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onVersionHistory(file);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Clock size={16} className="text-orange-500" />
                        <span className="font-medium">Version History</span>
                      </button>
                      <div className={`my-1 h-px ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}></div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFileDelete(file.id);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode ? 'hover:bg-red-900/20 text-red-400' : 'hover:bg-red-50 text-red-600'
                        }`}
                      >
                        <Trash2 size={16} />
                        <span className="font-medium">Delete</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col items-center mt-4">
            <div className="w-full aspect-square flex items-center justify-center mb-4">
              <FileThumbnail
                file={file}
                size="large"
                darkMode={darkMode}
              />
            </div>
            <p className={`text-sm text-center font-medium truncate w-full px-2 ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`} title={file.name}>
              {sanitizeInput(file.name)}
            </p>
            <div className={`flex items-center gap-1.5 mt-1.5 text-xs ${
              darkMode ? 'text-gray-500' : 'text-gray-400'
            }`}>
              <span>{formatBytes(file.size)}</span>
              <span>•</span>
              <span>{formatDate(file.created_at)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}