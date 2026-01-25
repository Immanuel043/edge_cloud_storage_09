import React, { useState } from 'react';
import {
  Folder,
  Download,
  Share2,
  Trash2,
  Eye,
  Clock,
  MoreVertical,
  Star,
  Edit2,
  Info,
  Copy,
  Shield,
  RotateCcw,
} from 'lucide-react';
import { formatBytes, formatDate, sanitizeInput } from '../../utils/helpers';
import FileThumbnail from './FileThumbnail';
import type { FileListProps, FileItem } from './types';

/**
 * FileList Component
 *
 * List view for files and folders with inline context menu.
 */
const FileList: React.FC<FileListProps> = ({
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
  // isZKMode prop available for future use
  isZKMode: _isZKMode = false,
  trashedView = false,
  onRestore,
}) => {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [hoveredMenuId, setHoveredMenuId] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      {/* Table header */}
      <div
        className={`grid grid-cols-12 gap-4 px-4 py-3 text-xs font-semibold uppercase tracking-wider border-b ${
          darkMode ? 'text-gray-400 border-gray-700' : 'text-gray-500 border-gray-200'
        }`}
      >
        <div className="col-span-1 text-center">★</div>
        <div className="col-span-5">Name</div>
        <div className="col-span-2">Size</div>
        <div className="col-span-2">Last Opened</div>
        <div className="col-span-1"></div>
        <div className="col-span-1 text-center">Actions</div>
      </div>

      {/* Folders */}
      {folders.map((folder, folderIndex) => (
        <div
          key={folder.id}
          data-file-card="true"
          onClick={(e: React.MouseEvent) => {
            onFileClick(folder.id, folderIndex, e.ctrlKey || e.metaKey, e.shiftKey);
          }}
          onDoubleClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onFolderClick(folder.id, folder.name);
          }}
          className={`group grid grid-cols-12 gap-4 px-4 py-2.5 cursor-pointer transition-all border-b ${
            darkMode
              ? 'hover:bg-gray-800/40 border-gray-800'
              : 'hover:bg-blue-50/40 border-gray-100'
          } ${
            selectedFiles.has(folder.id)
              ? darkMode
                ? 'bg-blue-900/20 border-blue-800'
                : 'bg-blue-50/60 border-blue-200'
              : ''
          }`}
        >
          <div className="col-span-1 flex items-center">
            <div
              className={`p-1.5 rounded-lg transition-colors ${
                darkMode
                  ? 'bg-blue-500/10 group-hover:bg-blue-500/20'
                  : 'bg-blue-50 group-hover:bg-blue-100'
              }`}
            >
              <Folder className="text-blue-500" size={16} />
            </div>
          </div>
          <div
            className={`col-span-5 font-medium flex items-center ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`}
          >
            {sanitizeInput(folder.name) as string}
          </div>
          <div
            className={`col-span-2 flex items-center text-xs ${
              darkMode ? 'text-gray-500' : 'text-gray-400'
            }`}
          >
            —
          </div>
          <div
            className={`col-span-2 flex items-center text-xs ${
              darkMode ? 'text-gray-500' : 'text-gray-400'
            }`}
          >
            {formatDate(folder.created_at)}
          </div>
          <div className="col-span-1"></div>
          <div className="col-span-1"></div>
        </div>
      ))}

      {/* Files */}
      {files.map((file: FileItem, fileIndex: number) => (
        <div
          key={file.id}
          data-file-card="true"
          onClick={(e: React.MouseEvent) => {
            onFileClick(file.id, folders.length + fileIndex, e.ctrlKey || e.metaKey, e.shiftKey);
          }}
          onDoubleClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onFilePreview(file);
          }}
          className={`group grid grid-cols-12 gap-4 px-4 py-2.5 transition-all border-b cursor-pointer ${
            darkMode
              ? 'hover:bg-gray-800/40 border-gray-800'
              : 'hover:bg-gray-50/80 border-gray-100'
          } ${
            selectedFiles.has(file.id)
              ? darkMode
                ? 'bg-blue-900/20 border-blue-800'
                : 'bg-blue-50/60 border-blue-200'
              : ''
          }`}
        >
          <div className="col-span-1 flex items-center justify-center">
            {onToggleFavorite && (
              <button
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onToggleFavorite(file.id);
                }}
                className={`p-1 rounded transition-all ${
                  darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'
                }`}
                title={file.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
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
          </div>
          <div
            className={`col-span-5 font-medium flex items-center gap-3 file-name-area ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`}
          >
            <FileThumbnail file={file} size="small" darkMode={darkMode} />
            <span className="truncate">{sanitizeInput(file.name) as string}</span>
            {/* Encrypted badge for ZK files */}
            {(file.is_encrypted ||
              (file as FileItem & { encryption_mode?: string }).encryption_mode ===
                'client_zk') && (
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                  darkMode ? 'bg-green-900/40 text-green-400' : 'bg-green-100 text-green-700'
                }`}
              >
                <Shield size={10} />
                ZK
              </span>
            )}
          </div>
          <div
            className={`col-span-2 flex items-center text-sm ${
              darkMode ? 'text-gray-400' : 'text-gray-600'
            }`}
          >
            {formatBytes(file.size)}
          </div>
          <div
            className={`col-span-2 flex items-center text-sm ${
              darkMode ? 'text-gray-400' : 'text-gray-600'
            }`}
          >
            {formatDate(file.last_accessed ?? file.created_at)}
          </div>
          <div className="col-span-1 flex justify-center items-center">
            {/* Spacer for alignment */}
          </div>
          <div className="col-span-1 flex justify-center items-center relative">
            <div className="relative">
              <button
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === file.id ? null : file.id);
                }}
                onMouseEnter={() => setHoveredMenuId(file.id)}
                onMouseLeave={() => setHoveredMenuId(null)}
                className={`p-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100 ${
                  darkMode ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-200 text-gray-700'
                } ${openMenuId === file.id ? (darkMode ? 'bg-gray-700' : 'bg-gray-200') + ' opacity-100' : ''}`}
              >
                <MoreVertical size={16} />
              </button>

              {/* Custom Tooltip */}
              {hoveredMenuId === file.id && (
                <div
                  className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded text-xs whitespace-nowrap pointer-events-none ${
                    darkMode ? 'bg-gray-800 text-white' : 'bg-gray-100 text-black'
                  }`}
                >
                  More actions
                </div>
              )}
            </div>

            {openMenuId === file.id && (
              <>
                <div
                  className="fixed inset-0"
                  style={{ zIndex: 99998 }}
                  onClick={() => setOpenMenuId(null)}
                />
                <div
                  className={`absolute right-0 top-10 w-52 rounded-xl shadow-2xl border overflow-hidden ${
                    darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                  }`}
                  style={{ zIndex: 99999 }}
                >
                  <div className="py-2">
                    <button
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onFilePreview(file);
                        setOpenMenuId(null);
                      }}
                      className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                        darkMode
                          ? 'hover:bg-gray-700 text-gray-200'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      <Eye size={16} className="text-blue-500" />
                      <span className="font-medium">Preview</span>
                    </button>
                    <button
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onFileDownload(file.id, file.name);
                        setOpenMenuId(null);
                      }}
                      className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                        darkMode
                          ? 'hover:bg-gray-700 text-gray-200'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      <Download size={16} className="text-green-500" />
                      <span className="font-medium">Download</span>
                    </button>
                    <button
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onFileShare(file.id);
                        setOpenMenuId(null);
                      }}
                      className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                        darkMode
                          ? 'hover:bg-gray-700 text-gray-200'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      <Share2 size={16} className="text-purple-500" />
                      <span className="font-medium">Share</span>
                    </button>
                    {onFileCopy && (
                      <button
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onFileCopy(file);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode
                            ? 'hover:bg-gray-700 text-gray-200'
                            : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Copy size={16} className="text-indigo-500" />
                        <span className="font-medium">Make a copy</span>
                      </button>
                    )}
                    {onRename && (
                      <button
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onRename(file);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode
                            ? 'hover:bg-gray-700 text-gray-200'
                            : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Edit2 size={16} className="text-amber-500" />
                        <span className="font-medium">Rename</span>
                      </button>
                    )}
                    <button
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onVersionHistory(file);
                        setOpenMenuId(null);
                      }}
                      className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                        darkMode
                          ? 'hover:bg-gray-700 text-gray-200'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      <Clock size={16} className="text-orange-500" />
                      <span className="font-medium">Version History</span>
                    </button>
                    {onFileInfo && (
                      <button
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onFileInfo(file);
                          setOpenMenuId(null);
                        }}
                        className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                          darkMode
                            ? 'hover:bg-gray-700 text-gray-200'
                            : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <Info size={16} className="text-cyan-500" />
                        <span className="font-medium">File information</span>
                      </button>
                    )}
                    {trashedView && onRestore && (
                      <>
                        <div
                          className={`my-1 h-px ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}
                        ></div>
                        <button
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            onRestore(file.id);
                            setOpenMenuId(null);
                          }}
                          className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                            darkMode
                              ? 'hover:bg-green-900/20 text-green-400'
                              : 'hover:bg-green-50 text-green-600'
                          }`}
                        >
                          <RotateCcw size={16} />
                          <span className="font-medium">Restore</span>
                        </button>
                      </>
                    )}
                    <div className={`my-1 h-px ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}></div>
                    <button
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onFileDelete(file.id, file.name);
                        setOpenMenuId(null);
                      }}
                      className={`w-full px-4 py-2.5 text-left flex items-center gap-3 text-sm transition-colors ${
                        darkMode
                          ? 'hover:bg-red-900/20 text-red-400'
                          : 'hover:bg-red-50 text-red-600'
                      }`}
                    >
                      <Trash2 size={16} />
                      <span className="font-medium">
                        {trashedView ? 'Delete Forever' : 'Delete'}
                      </span>
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
};

export default FileList;
