import React, { useState } from 'react';
import { Folder, File, Download, Share2, Trash2, Eye, Check, Cloud, HardDrive, Clock, MoreVertical, Star, Edit2, Info, Lock, Shield, Copy, RotateCcw } from 'lucide-react';
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
  onToggleFavorite,
  onRename,
  onFileInfo,
  onFileCopy,
  darkMode,
  trashedView = false,
  onRestore,
}) {
  const [openMenuId, setOpenMenuId] = useState(null);
  const [hoveredMenuId, setHoveredMenuId] = useState(null);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {/* Folders */}
      {folders.map((folder, folderIndex) => (
        <div
          key={folder.id}
          data-file-card="true"
          onClick={(e) => {
            // Single click selects folder
            onFileClick(folder.id, folderIndex, e.shiftKey);
          }}
          onDoubleClick={(e) => {
            // Double click navigates into folder
            e.stopPropagation();
            onFolderClick(folder.id, folder.name);
          }}
          className={`group aspect-square p-3 rounded-xl cursor-pointer transition-all border ${
            darkMode
              ? 'bg-gray-800/50 hover:bg-gray-700/50 border-gray-700 hover:border-gray-600'
              : 'bg-white hover:bg-blue-50/30 border-gray-200 hover:border-blue-200'
          } ${selectedFiles.has(folder.id) ? 'ring-2 ring-blue-500 ring-offset-2' : ''} hover:shadow-lg`}
        >
          <div className="flex flex-col items-center justify-center h-full">
            <div className={`p-3 rounded-xl transition-colors ${
              darkMode ? 'bg-blue-500/10 group-hover:bg-blue-500/20' : 'bg-blue-50 group-hover:bg-blue-100'
            }`}>
              <Folder className="text-blue-500" size={32} />
            </div>
            <p className={`text-sm mt-2 text-center font-medium truncate w-full px-1 ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`} title={folder.name}>
              {sanitizeInput(folder.name)}
            </p>
            <p className={`text-xs mt-0.5 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              {formatDate(folder.created_at)}
            </p>
          </div>
        </div>
      ))}

      {/* Files */}
      {files.map((file, fileIndex) => (
        <div
          key={file.id}
          data-file-card="true"
          onClick={(e) => {
            // Single click selects file, pass index for shift+click range selection
            onFileClick(file.id, folders.length + fileIndex, e.shiftKey);
          }}
          onDoubleClick={(e) => {
            // Double click opens preview
            e.stopPropagation();
            onFilePreview(file);
          }}
          className={`aspect-square p-3 rounded-xl relative group transition-all border cursor-pointer flex flex-col ${
            darkMode
              ? 'bg-gray-800/50 hover:bg-gray-700/50 border-gray-700 hover:border-gray-600'
              : 'bg-white hover:bg-gray-50 border-gray-200 hover:border-gray-300'
          } ${selectedFiles.has(file.id) ? 'ring-2 ring-blue-500 ring-offset-2' : ''} hover:shadow-lg`}
        >
          {/* Favorite star - Always visible, top-left */}
          {onToggleFavorite && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(file.id);
              }}
              className={`absolute top-2 left-2 z-10 p-1.5 rounded-lg transition-all ${
                darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'
              }`}
              title={file.is_favorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Star
                size={18}
                className={`transition-all ${
                  file.is_favorite
                    ? 'fill-yellow-500 text-yellow-500'
                    : darkMode
                      ? 'text-gray-500 hover:text-yellow-500'
                      : 'text-gray-400 hover:text-yellow-500'
                }`}
              />
            </button>
          )}

          {/* Menu */}
          <div className="absolute top-2 right-2">
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
                } ${openMenuId === file.id ? (darkMode ? 'bg-gray-700' : 'bg-gray-200') : ''}`}
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
                      {onFileCopy && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onFileCopy(file);
                            setOpenMenuId(null);
                          }}
                          className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                            darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                          }`}
                        >
                          <Copy size={16} className="text-indigo-500" />
                          <span className="font-medium">Make a copy</span>
                        </button>
                      )}
                      {onRename && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRename(file);
                            setOpenMenuId(null);
                          }}
                          className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                            darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                          }`}
                        >
                          <Edit2 size={16} className="text-amber-500" />
                          <span className="font-medium">Rename</span>
                        </button>
                      )}
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
                      {onFileInfo && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onFileInfo(file);
                            setOpenMenuId(null);
                          }}
                          className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                            darkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'
                          }`}
                        >
                          <Info size={16} className="text-cyan-500" />
                          <span className="font-medium">File information</span>
                        </button>
                      )}
                      {trashedView && onRestore && (
                        <>
                          <div className={`my-1 h-px ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}></div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onRestore(file.id);
                              setOpenMenuId(null);
                            }}
                            className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                              darkMode ? 'hover:bg-green-900/20 text-green-400' : 'hover:bg-green-50 text-green-600'
                            }`}
                          >
                            <RotateCcw size={16} />
                            <span className="font-medium">Restore</span>
                          </button>
                        </>
                      )}
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

          <div className="flex flex-col items-center justify-center flex-1 mt-6 min-h-0 file-preview-area">
            <div className="flex-1 w-full flex items-center justify-center min-h-0 overflow-hidden">
              <FileThumbnail
                file={file}
                size="large"
                darkMode={darkMode}
              />
            </div>
            <div className="w-full px-1 text-center mt-1 flex-shrink-0">
              <div className="flex items-center justify-center gap-1">
                <p className={`text-xs font-medium truncate leading-tight ${
                  darkMode ? 'text-white' : 'text-gray-900'
                }`} title={file.name}>
                  {sanitizeInput(file.name)}
                </p>
                {file.is_encrypted && (
                  <span
                    className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 flex-shrink-0"
                    title="Zero-Knowledge Encrypted - Server cannot decrypt this file"
                  >
                    <Lock className="w-2.5 h-2.5" />
                  </span>
                )}
              </div>
              <div className={`flex items-center justify-center gap-1 text-xs mt-0.5 ${
                darkMode ? 'text-gray-500' : 'text-gray-500'
              }`}>
                <span className="font-normal">{formatBytes(file.size)}</span>
                <span>•</span>
                <span className="font-normal">{formatDate(file.last_accessed || file.created_at)}</span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}