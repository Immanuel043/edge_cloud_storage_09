import React, { useState, useRef, useMemo } from 'react';
import {
  Upload, X, CheckCircle, Cloud, Sun, Moon, LogOut, Home, Search,
  Settings, ChevronRight, Grid, List, Info, Lock, FolderPlus, Shield, Trash2,
  ArrowUpDown, AlertTriangle
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import TrashView from './TrashView';
import ZKStorageStats from './ZKStorageStats';
import ZKEncryptionStatus from './ZKEncryptionStatus';
import QuickFilters from './QuickFilters';
import FileGrid from './FileGrid';
import FileList from './FileList';
import UploadProgress from './UploadProgress';
import DownloadProgress from './DownloadProgress';
import FilePreview from './FilePreview';
import RenameModal from './RenameModal';
import FileInfoPanel from './FileInfoPanel';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import SettingsView from './SettingsView';
import KeyboardShortcuts from './KeyboardShortcuts';
import MigrationBanner from './MigrationBanner';
import FileCorruptionModal from './FileCorruptionModal';
import ShareOptionsModal from './ShareOptionsModal';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { getFileType } from '../../utils/helpers';

/**
 * ZKDashboardLayout - Simplified dashboard for Zero-Knowledge encrypted users
 *
 * Features:
 * - File browser (grid/list views)
 * - Simple storage stats (no cache/warm/cold tiers)
 * - Encryption status panel
 * - Upload/download with encryption
 * - Lock session button
 *
 * Not included:
 * - Sharing (blocked for encrypted files)
 * - Analytics
 * - Recents/Favorites views
 * - Deduplication panel
 * - AI Features
 */
export default function ZKDashboardLayout({
  // Theme
  darkMode,
  toggleTheme,
  // Auth
  user,
  logout,
  isUnlocked,
  onLock,
  // Storage
  files,
  folders,
  currentFolder,
  currentFolderName,
  storageStats,
  selectedFiles,
  // Actions
  uploadFile,
  downloadFile,
  deleteFile,
  createFolder,
  navigateToFolder,
  selectFile,
  selectAll,
  clearSelection,
  refreshFiles,
}) {
  // View state
  const [activeView, setActiveView] = useState('cloud-drive');
  const [viewMode, setViewMode] = useState('grid');
  const [searchResults, setSearchResults] = useState(null);

  // Filter and sort state
  const [quickFilter, setQuickFilter] = useState('all');
  const [sortBy, setSortBy] = useState(() =>
    localStorage.getItem('zk_sort_preference') || 'name'
  );

  // Modal state
  const [previewFile, setPreviewFile] = useState(null);
  const [renameFile, setRenameFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [shareFile, setShareFile] = useState(null); // For showing blocked message
  const [showLockConfirm, setShowLockConfirm] = useState(false);

  // Upload state
  const [uploads, setUploads] = useState({});
  const [isDragging, setIsDragging] = useState(false);
  const [showUploadCompleteToast, setShowUploadCompleteToast] = useState(false);
  const [completedUploadCount, setCompletedUploadCount] = useState(0);

  // Download state
  const [downloads, setDownloads] = useState({});
  const [corruptionError, setCorruptionError] = useState(null);

  // Refs
  const fileInputRef = useRef(null);
  const abortControllers = useRef({});

  // Handle sort change with localStorage persistence
  const handleSortChange = (e) => {
    const newSort = e.target.value;
    setSortBy(newSort);
    localStorage.setItem('zk_sort_preference', newSort);
  };

  // Filter and sort files
  const { filteredFolders, filteredFiles } = useMemo(() => {
    let resultFolders = [...folders];
    let resultFiles = [...files];

    // Apply quick filter
    switch (quickFilter) {
      case 'all':
        // Show all
        break;
      case 'recent':
        // Files from last 7 days only, no folders
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        resultFiles = files.filter(f => {
          const fileDate = new Date(f.last_accessed || f.updated_at || f.created_at);
          return fileDate >= sevenDaysAgo;
        });
        resultFolders = [];
        break;
      case 'folders':
        // Only folders, no files
        resultFiles = [];
        break;
      case 'image':
      case 'document':
      case 'video':
      case 'audio':
        // Filter files by type, show all folders
        resultFiles = files.filter(f => getFileType(f.name) === quickFilter);
        break;
      default:
        break;
    }

    // Sort files
    resultFiles.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'date':
          return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
        case 'size':
          return (b.size || 0) - (a.size || 0);
        case 'type':
          return getFileType(a.name).localeCompare(getFileType(b.name));
        default:
          return 0;
      }
    });

    // Sort folders by name (always)
    resultFolders.sort((a, b) => a.name.localeCompare(b.name));

    return { filteredFolders: resultFolders, filteredFiles: resultFiles };
  }, [files, folders, quickFilter, sortBy]);

  // Setup keyboard shortcuts
  useKeyboardShortcuts({
    'ctrl+u': () => fileInputRef.current?.click(),
    'ctrl+n': () => handleCreateFolder(),
    'ctrl+a': (e) => {
      e.preventDefault();
      selectAll();
    },
    'escape': () => {
      clearSelection();
      setPreviewFile(null);
    },
    'shift+?': () => setShowShortcuts(true)
  });

  // Handle file upload
  const handleFileUpload = async (file) => {
    const uploadId = crypto.randomUUID();
    const startTime = Date.now();

    try {
      setUploads(prev => ({
        ...prev,
        [uploadId]: {
          name: file.name,
          size: file.size,
          totalSize: file.size,
          bytesUploaded: 0,
          progress: 0,
          status: 'uploading',
          chunksUploaded: 0,
          totalChunks: 0,
          startTime,
          zkEnabled: true // Always true for ZK dashboard
        }
      }));

      const controller = new AbortController();
      abortControllers.current[uploadId] = controller;

      await uploadFile(file, (progressData) => {
        setUploads(prev => ({
          ...prev,
          [uploadId]: {
            ...prev[uploadId],
            progress: progressData.progress,
            chunksUploaded: progressData.chunksUploaded,
            totalChunks: progressData.totalChunks,
            bytesUploaded: progressData.bytesUploaded || (progressData.chunksUploaded * (file.size / progressData.totalChunks)),
            elapsedTime: Date.now() - startTime
          }
        }));
      });

      setUploads(prev => ({
        ...prev,
        [uploadId]: {
          ...prev[uploadId],
          status: 'completed',
          progress: 100
        }
      }));

      // Show completion toast
      setCompletedUploadCount(prev => prev + 1);
      setShowUploadCompleteToast(true);
      setTimeout(() => setShowUploadCompleteToast(false), 5000);

      // Remove from list after delay
      setTimeout(() => {
        setUploads(prev => {
          const newUploads = { ...prev };
          delete newUploads[uploadId];
          return newUploads;
        });
      }, 3000);

      refreshFiles();

    } catch (error) {
      if (error.name === 'AbortError') {
        setUploads(prev => ({
          ...prev,
          [uploadId]: { ...prev[uploadId], status: 'cancelled' }
        }));
      } else {
        setUploads(prev => ({
          ...prev,
          [uploadId]: { ...prev[uploadId], status: 'error', error: error.message }
        }));
      }
    } finally {
      delete abortControllers.current[uploadId];
    }
  };

  const cancelUpload = (uploadId) => {
    abortControllers.current[uploadId]?.abort();
  };

  // Handle file download with progress
  const handleFileDownload = async (fileId, fileName) => {
    const downloadId = crypto.randomUUID();
    const file = files.find(f => f.id === fileId);

    try {
      setDownloads(prev => ({
        ...prev,
        [downloadId]: {
          fileId,
          fileName,
          status: 'downloading',
          progress: 0,
          downloadProgress: 0,
          decryptProgress: 0,
          currentStage: 'downloading',
          currentChunk: 0,
          totalChunks: 1,
          bytesDownloaded: 0,
          totalBytes: file?.size || 0,
          isZK: true
        }
      }));

      await downloadFile(fileId, fileName, (progressData) => {
        setDownloads(prev => ({
          ...prev,
          [downloadId]: {
            ...prev[downloadId],
            ...progressData,
            status: 'downloading'
          }
        }));
      });

      // Mark as completed
      setDownloads(prev => ({
        ...prev,
        [downloadId]: {
          ...prev[downloadId],
          status: 'completed',
          progress: 100,
          downloadProgress: 100,
          decryptProgress: 100
        }
      }));

      // Remove after delay
      setTimeout(() => {
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
      }, 3000);

    } catch (error) {
      console.error('Download failed:', error);

      // Check for corruption
      if (error.message && (
        error.message.includes('corruption') ||
        error.message.includes('corrupted') ||
        error.message.includes('tampered')
      )) {
        setCorruptionError({ fileName, errorMessage: error.message });
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
        return;
      }

      // Show error state
      setDownloads(prev => ({
        ...prev,
        [downloadId]: {
          ...prev[downloadId],
          status: 'error',
          error: error.message
        }
      }));

      setTimeout(() => {
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
      }, 5000);
    }
  };

  const handleCreateFolder = async () => {
    const name = prompt('Enter folder name:');
    if (!name) return;
    await createFolder(name);
  };

  // Handle share attempt - show blocked message
  const handleShare = (fileId) => {
    const file = files.find(f => f.id === fileId);
    if (file) {
      setShareFile(file);
    }
  };

  const handleRenameFile = async (fileId, newName) => {
    try {
      const response = await fetch(`${API_URL}/api/v1/files/${fileId}/rename`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ name: newName }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to rename file');
      }

      // Refresh file list to show updated name
      await refreshFiles();
      setRenameFile(null);
    } catch (error) {
      console.error('Rename failed:', error);
      alert(`Failed to rename file: ${error.message}`);
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    droppedFiles.forEach(handleFileUpload);
  };

  // Render main content
  const renderMainContent = () => {
    if (activeView === 'settings') {
      return <SettingsView darkMode={darkMode} />;
    }

    if (activeView === 'trash') {
      return (
        <TrashView
          viewMode={viewMode}
          darkMode={darkMode}
          selectedFiles={selectedFiles}
          onFileClick={selectFile}
          onFilePreview={setPreviewFile}
          onFileDownload={handleFileDownload}
          onRefresh={refreshFiles}
        />
      );
    }

    return (
      <div
        className={`rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} ${isDragging ? 'ring-2 ring-blue-500' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="p-8 text-center border-2 border-dashed border-blue-500 m-4 rounded-lg">
            <Upload className="mx-auto mb-2 text-blue-500" size={48} />
            <p className="text-blue-500">Drop files here to upload (encrypted)</p>
          </div>
        )}

        {!isDragging && (
          <div className="p-4">
            {searchResults ? (
              <SearchResults
                results={searchResults}
                onClose={() => setSearchResults(null)}
                onFileClick={setPreviewFile}
                onFolderClick={navigateToFolder}
                darkMode={darkMode}
              />
            ) : (
              <>
                {/* Breadcrumb */}
                <div className="flex items-center gap-2 mb-4 text-sm">
                  <button
                    onClick={() => navigateToFolder(null)}
                    className={`flex items-center gap-1 ${currentFolder ? (darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700') : (darkMode ? 'text-white' : 'text-gray-900')} transition-colors`}
                  >
                    <Home size={16} />
                    Home
                  </button>
                  {currentFolder && (
                    <>
                      <ChevronRight size={16} className="text-gray-400" />
                      <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {currentFolderName || 'Folder'}
                      </span>
                    </>
                  )}
                </div>

                {/* Files and Folders */}
                {viewMode === 'grid' ? (
                  <FileGrid
                    folders={filteredFolders}
                    files={filteredFiles}
                    selectedFiles={selectedFiles}
                    onFolderClick={navigateToFolder}
                    onFileClick={selectFile}
                    onFilePreview={setPreviewFile}
                    onFileDownload={handleFileDownload}
                    onFileShare={handleShare}
                    onFileDelete={deleteFile}
                    onRename={setRenameFile}
                    onFileInfo={setFileInfo}
                    darkMode={darkMode}
                    isZKMode={true}
                  />
                ) : (
                  <FileList
                    folders={filteredFolders}
                    files={filteredFiles}
                    selectedFiles={selectedFiles}
                    onFolderClick={navigateToFolder}
                    onFileClick={selectFile}
                    onFilePreview={setPreviewFile}
                    onFileDownload={handleFileDownload}
                    onFileShare={handleShare}
                    onFileDelete={deleteFile}
                    onRename={setRenameFile}
                    onFileInfo={setFileInfo}
                    darkMode={darkMode}
                    isZKMode={true}
                  />
                )}

                {filteredFiles.length === 0 && filteredFolders.length === 0 && (
                  <div className="text-center py-12">
                    <div className="flex justify-center mb-4">
                      <div className={`p-4 rounded-full ${darkMode ? 'bg-green-900/30' : 'bg-green-100'}`}>
                        <Shield className={darkMode ? 'text-green-400' : 'text-green-600'} size={48} />
                      </div>
                    </div>
                    <p className={`text-lg font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      Your encrypted storage is empty
                    </p>
                    <p className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
                      Upload files to encrypt them with your password. Only you can decrypt them.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Simplified ZK Sidebar */}
      <aside className={`fixed top-0 left-0 h-full w-64 shadow-xl flex flex-col ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        {/* Logo */}
        <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center justify-center gap-3">
            <div className={`p-2 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 shadow-lg`}>
              <Shield className="text-white" size={28} />
            </div>
            <div>
              <h1 className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                ZK Storage
              </h1>
              <p className={`text-xs ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
                End-to-End Encrypted
              </p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-4 space-y-2">
          <button
            onClick={() => setActiveView('cloud-drive')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeView === 'cloud-drive'
                ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-lg'
                : darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-green-50'
            }`}
          >
            <Cloud size={20} />
            <span className="font-medium text-sm">Encrypted Files</span>
          </button>

          <button
            onClick={() => setActiveView('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeView === 'settings'
                ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-lg'
                : darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-green-50'
            }`}
          >
            <Settings size={20} />
            <span className="font-medium text-sm">Settings</span>
          </button>

          <button
            onClick={() => setActiveView('trash')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeView === 'trash'
                ? 'bg-gradient-to-r from-red-500 to-red-600 text-white shadow-lg'
                : darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-red-50'
            }`}
          >
            <Trash2 size={20} />
            <span className="font-medium text-sm">Trash</span>
          </button>
        </nav>

        {/* Encryption Status in Sidebar */}
        <div className={`p-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
            <div className="flex items-center gap-2 mb-2">
              <Lock size={14} className={darkMode ? 'text-green-400' : 'text-green-600'} />
              <span className={`text-xs font-medium ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
                Session Active
              </span>
            </div>
            <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              AES-256-GCM encryption
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="lg:ml-64 min-h-screen">
        {/* Header */}
        <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b sticky top-0 z-30`}>
          <div className="px-4 py-4">
            <div className="flex justify-end items-center gap-3">
              <div className="flex-1 max-w-2xl">
                <SearchBar
                  onSearch={setSearchResults}
                  darkMode={darkMode}
                  zkMode={true}
                  files={files}
                />
              </div>

              <button
                onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                title={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}
              >
                {viewMode === 'grid' ? <List size={20} /> : <Grid size={20} />}
              </button>

              <button
                onClick={toggleTheme}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-100'}`}
                title="Toggle theme"
              >
                {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              </button>

              <button
                onClick={() => setShowShortcuts(true)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                title="Keyboard shortcuts"
              >
                <Info size={20} />
              </button>

              {/* Lock Session Button */}
              <button
                onClick={() => setShowLockConfirm(true)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-yellow-900/50 hover:bg-yellow-900/70 text-yellow-400' : 'bg-yellow-100 hover:bg-yellow-200 text-yellow-700'} transition-all`}
                title="Lock encryption session"
              >
                <Lock size={20} />
              </button>

              <div className="flex items-center gap-2">
                <span className={darkMode ? 'text-gray-300' : 'text-gray-600'}>
                  {user?.username}
                </span>
                <button
                  onClick={logout}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                  title="Logout"
                >
                  <LogOut size={20} />
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <div
          className="px-4 py-6"
          onClick={(e) => {
            if (e.target === e.currentTarget || !e.target.closest('[data-file-card]')) {
              clearSelection();
            }
          }}
        >
          {/* ZK Storage Stats */}
          {activeView === 'cloud-drive' && (
            <ZKStorageStats stats={storageStats} darkMode={darkMode} />
          )}

          {/* ZK Encryption Status */}
          {activeView === 'cloud-drive' && (
            <ZKEncryptionStatus
              isUnlocked={isUnlocked}
              onLock={onLock}
              darkMode={darkMode}
            />
          )}

          {/* Migration Banner */}
          {activeView === 'cloud-drive' && (
            <MigrationBanner />
          )}

          {/* Quick Filters */}
          {activeView === 'cloud-drive' && (
            <QuickFilters
              activeFilter={quickFilter}
              onFilterChange={setQuickFilter}
              darkMode={darkMode}
              isZK={true}
            />
          )}

          {/* Action Bar */}
          {activeView === 'cloud-drive' && (
            <div className="flex gap-3 mb-4 items-center">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-lg hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg"
                title="Upload files (Ctrl+U)"
              >
                <Upload size={20} />
                Upload Encrypted
              </button>
              <button
                onClick={handleCreateFolder}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  darkMode
                    ? 'bg-gray-700 text-white hover:bg-gray-600'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                title="New folder (Ctrl+N)"
              >
                <FolderPlus size={20} />
                New Folder
              </button>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Sort Dropdown */}
              <div className="flex items-center gap-2">
                <ArrowUpDown size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
                <select
                  value={sortBy}
                  onChange={handleSortChange}
                  className={`px-3 py-1.5 rounded-lg border text-sm ${
                    darkMode
                      ? 'bg-gray-700 border-gray-600 text-white'
                      : 'bg-white border-gray-300 text-gray-700'
                  }`}
                >
                  <option value="name">Name</option>
                  <option value="date">Date Modified</option>
                  <option value="size">Size</option>
                  <option value="type">Type</option>
                </select>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => Array.from(e.target.files).forEach(handleFileUpload)}
                className="hidden"
              />
            </div>
          )}

          {/* Upload Progress */}
          {Object.keys(uploads).length > 0 && (
            <UploadProgress
              uploads={uploads}
              onCancel={cancelUpload}
              darkMode={darkMode}
            />
          )}

          {/* Download Progress */}
          {Object.keys(downloads).length > 0 && (
            <DownloadProgress
              downloads={downloads}
              darkMode={darkMode}
            />
          )}

          {/* Main Content View */}
          {renderMainContent()}
        </div>
      </div>

      {/* Modals */}
      {shareFile && (
        <ShareOptionsModal
          file={shareFile}
          onClose={() => setShareFile(null)}
          darkMode={darkMode}
        />
      )}

      {previewFile && (
        <FilePreview
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          darkMode={darkMode}
        />
      )}

      {showShortcuts && (
        <KeyboardShortcuts
          onClose={() => setShowShortcuts(false)}
          darkMode={darkMode}
          isZK={true}
        />
      )}

      {renameFile && (
        <RenameModal
          file={renameFile}
          onClose={() => setRenameFile(null)}
          onRename={handleRenameFile}
          darkMode={darkMode}
        />
      )}

      {fileInfo && (
        <FileInfoPanel
          file={fileInfo}
          onClose={() => setFileInfo(null)}
          onRename={setRenameFile}
          darkMode={darkMode}
        />
      )}

      {corruptionError && (
        <FileCorruptionModal
          isOpen={!!corruptionError}
          onClose={() => setCorruptionError(null)}
          fileName={corruptionError.fileName}
          errorMessage={corruptionError.errorMessage}
          darkMode={darkMode}
        />
      )}

      {/* Upload Complete Toast */}
      {showUploadCompleteToast && (
        <div className="fixed top-4 right-4 z-50 animate-slide-in">
          <div className={`flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl border ${
            darkMode
              ? 'bg-gray-800 border-gray-700'
              : 'bg-white border-gray-200'
          }`}>
            <div className="flex-shrink-0">
              <CheckCircle size={24} className="text-green-500" />
            </div>
            <div className="flex-1">
              <p className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Encrypted & Uploaded!
              </p>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {completedUploadCount} {completedUploadCount === 1 ? 'file' : 'files'} secured
              </p>
            </div>
            <button
              onClick={() => setShowUploadCompleteToast(false)}
              className={`flex-shrink-0 p-1 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'
              }`}
            >
              <X size={18} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
            </button>
          </div>
        </div>
      )}

      {/* Lock Session Confirmation Modal */}
      {showLockConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className={`w-full max-w-sm rounded-2xl shadow-2xl border ${
            darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
          }`}>
            {/* Header */}
            <div className={`p-5 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-yellow-500 to-orange-600">
                    <Lock className="text-white" size={20} />
                  </div>
                  <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Lock Session?
                  </h3>
                </div>
                <button
                  onClick={() => setShowLockConfirm(false)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
                  }`}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-5">
              <div className={`p-4 rounded-xl border ${
                darkMode ? 'bg-yellow-900/20 border-yellow-700/40' : 'bg-yellow-50 border-yellow-200'
              }`}>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="text-yellow-500 flex-shrink-0 mt-0.5" size={18} />
                  <div>
                    <p className={`text-sm font-medium ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}>
                      Your encryption keys will be cleared
                    </p>
                    <p className={`text-xs mt-1 ${darkMode ? 'text-yellow-400/80' : 'text-yellow-700'}`}>
                      You'll need to enter your password to access your encrypted files again.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className={`p-5 border-t flex gap-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <button
                onClick={() => setShowLockConfirm(false)}
                className={`flex-1 px-4 py-2.5 rounded-xl font-medium transition-colors ${
                  darkMode
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLockConfirm(false);
                  onLock();
                }}
                className="flex-1 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-yellow-500 to-orange-600 hover:from-yellow-600 hover:to-orange-700 transition-all"
              >
                Lock Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
