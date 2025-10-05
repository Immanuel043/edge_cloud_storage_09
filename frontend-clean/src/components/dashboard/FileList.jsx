import React, { useState } from 'react';
import { Folder, Download, Share2, Trash2, Eye, Check, Cloud, HardDrive, Clock, MoreVertical } from 'lucide-react';
import { formatBytes, formatDate, getFileIcon, isImageFile, sanitizeInput } from '../../utils/helpers';
import FileThumbnail from './FileThumbnail';

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
  onVersionHistory,
  darkMode
}) {
  const [openMenuId, setOpenMenuId] = useState(null);
  const [hoveredMenuId, setHoveredMenuId] = useState(null);

  return (
    <div className="space-y-1">
      {/* Table header */}
      <div className={`grid grid-cols-12 gap-4 px-4 py-3 text-xs font-semibold uppercase tracking-wider border-b ${
        darkMode ? 'text-gray-400 border-gray-700' : 'text-gray-500 border-gray-200'
      }`}>
        <div className="col-span-1"></div>
        <div className="col-span-6">Name</div>
        <div className="col-span-2">Size</div>
        <div className="col-span-2">Modified</div>
        <div className="col-span-1 text-center">Actions</div>
      </div>

      {/* Folders */}
      {folders.map(folder => (
        <div
          key={folder.id}
          onClick={() => onFolderClick(folder.id)}
          className={`group grid grid-cols-12 gap-4 px-4 py-2.5 cursor-pointer transition-all border-b ${
            darkMode
              ? 'hover:bg-gray-800/40 border-gray-800'
              : 'hover:bg-blue-50/40 border-gray-100'
          }`}
        >
          <div className="col-span-1 flex items-center">
            <div className={`p-1.5 rounded-lg transition-colors ${
              darkMode ? 'bg-blue-500/10 group-hover:bg-blue-500/20' : 'bg-blue-50 group-hover:bg-blue-100'
            }`}>
              <Folder className="text-blue-500" size={16} />
            </div>
          </div>
          <div className={`col-span-6 font-medium flex items-center ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}>
            {sanitizeInput(folder.name)}
          </div>
          <div className={`col-span-2 flex items-center text-xs ${
            darkMode ? 'text-gray-500' : 'text-gray-400'
          }`}>—</div>
          <div className={`col-span-2 flex items-center text-xs ${
            darkMode ? 'text-gray-500' : 'text-gray-400'
          }`}>{formatDate(folder.created_at)}</div>
          <div className="col-span-1"></div>
        </div>
      ))}

      {/* Files */}
      {files.map(file => (
        <div
          key={file.id}
          className={`group grid grid-cols-12 gap-4 px-4 py-2.5 transition-all border-b ${
            darkMode
              ? 'hover:bg-gray-800/40 border-gray-800'
              : 'hover:bg-gray-50/80 border-gray-100'
          } ${selectedFiles.has(file.id) ? darkMode ? 'bg-blue-900/20 border-blue-800' : 'bg-blue-50/60 border-blue-200' : ''}`}
        >
          <div className="col-span-1 flex items-center gap-3">
            <div
              onClick={(e) => {
                e.stopPropagation();
                onFileClick(file.id);
              }}
              className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer flex-shrink-0 transition-all ${
                selectedFiles.has(file.id)
                  ? 'bg-blue-500 border-blue-500 scale-110'
                  : darkMode
                    ? 'border-gray-500 hover:border-gray-400'
                    : 'border-gray-300 hover:border-gray-400'
              }`}
              title="Select file"
            >
              {selectedFiles.has(file.id) && <Check size={14} className="text-white" />}
            </div>
          </div>
          <div className={`col-span-6 font-medium flex items-center gap-3 ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}>
            <FileThumbnail
              file={file}
              size="small"
              darkMode={darkMode}
            />
            <span className="truncate">{sanitizeInput(file.name)}</span>
          </div>
          <div className={`col-span-2 flex items-center text-xs ${
            darkMode ? 'text-gray-500' : 'text-gray-500'
          }`}>{formatBytes(file.size)}</div>
          <div className={`col-span-2 flex items-center text-xs ${
            darkMode ? 'text-gray-500' : 'text-gray-500'
          }`}>{formatDate(file.created_at)}</div>
          <div className="col-span-1 flex justify-center items-center relative">
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
                <div className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded text-xs whitespace-nowrap pointer-events-none ${
                  darkMode ? 'bg-gray-800 text-white' : 'bg-gray-100 text-black'
                }`}>
                  More actions
                </div>
              )}
            </div>

            {openMenuId === file.id && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setOpenMenuId(null)}
                />
                <div className={`absolute right-0 top-10 z-20 w-52 rounded-xl shadow-2xl border overflow-hidden ${
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
      ))}
    </div>
  );
}