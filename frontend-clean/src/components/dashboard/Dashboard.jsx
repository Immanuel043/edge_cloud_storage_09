import React, { useState, useEffect, useRef } from 'react';
import {
  Upload, X, CheckCircle, AlertCircle, Cloud, HardDrive,
  Share2, Download, Trash2, FolderPlus, Folder, Sun, Moon,
  User, LogOut, Home, Search, Settings, ChevronRight, Grid,
  List, Filter, Eye, Copy, Wifi, WifiOff, Check, Info,
  Image, FileText, Video, Music, Archive, Code, Clock,
  Zap
} from 'lucide-react';
import Sidebar from './Sidebar';
import RecentsView from './RecentsView';
import FavoritesView from './FavoritesView';
import SharedWithMeView from './SharedWithMeView';
import TrashView from './TrashView';
import AnalyticsView from './AnalyticsView';
import DeduplicationPanel from './DeduplicationPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import StorageStats from './StorageStats';
import { API_URL } from '../../config/constants';
import FileGrid from './FileGrid';
import FileList from './FileList';
import UploadProgress from './UploadProgress';
import FilePreview from './FilePreview';
import ShareOptionsModal from './ShareOptionsModal';
import VersionHistory from './VersionHistory';
import RenameModal from './RenameModal';
import FileInfoPanel from './FileInfoPanel';
import FilterPanel from './FilterPanel';
import KeyboardShortcuts from './KeyboardShortcuts';
import BulkActions from './BulkActions';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import SessionUnlockModal from '../auth/SessionUnlockModal';
import DownloadProgress from './DownloadProgress';
import FileCorruptionModal from './FileCorruptionModal';
import { formatBytes, formatDate, getFileIcon, getFileType } from '../../utils/helpers';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { storageService } from '../../services/storageService';


export default function Dashboard() {
  const { darkMode, toggleTheme } = useTheme();
  const { user, logout, token, isAuthenticated, loading: authLoading, showUnlockModal, unlockSession, zkEnabled, zkSessionUnlocked, lockSession } = useAuth();
  const {
    files,
    folders,
    currentFolder,
    storageStats,
    isOnline,
    selectedFiles,
    uploadFile,
    downloadFile,
    deleteFile,
    bulkDelete,
    createFolder,
    createShareLink,
    navigateToFolder,
    selectFile,
    selectAll,
    clearSelection,
    refreshFiles
  } = useStorage();

  const [activeView, setActiveView] = useState('cloud-drive');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploads, setUploads] = useState({});
  const [isDragging, setIsDragging] = useState(false);
  const [shareFile, setShareFile] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [versionFile, setVersionFile] = useState(null);
  const [renameFile, setRenameFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [filters, setFilters] = useState({
    type: 'all',
    size: 'all',
    date: 'all'
  });

  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const abortControllers = useRef({});
  const [showDedupPanel, setShowDedupPanel] = useState(false);
  const [dedupStats, setDedupStats] = useState(null);
  const [dedupLoading, setDedupLoading] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [showUploadCompleteToast, setShowUploadCompleteToast] = useState(false);
  const [completedUploadCount, setCompletedUploadCount] = useState(0);
  const [downloads, setDownloads] = useState({});
  const [pendingDownload, setPendingDownload] = useState(null); // Store download info for retry after unlock
  const [corruptionError, setCorruptionError] = useState(null); // Store corruption error details


  useEffect(() => {
    // Don't attempt to load if auth is still loading or not authenticated
    if (authLoading || !isAuthenticated) {
      console.log('Auth not ready for dedup load:', {
        authLoading,
        isAuthenticated
      });
      return;
    }

    // Only load dedup stats when the panel is actually opened
    if (showDedupPanel) {
      loadDedupStats();
    }
  }, [isAuthenticated, authLoading, showDedupPanel]);

  // Watch for upload completion to show toast
  useEffect(() => {
    const uploadValues = Object.values(uploads);
    const allCompleted = uploadValues.length > 0 &&
                         uploadValues.every(u => u.status === 'completed');

    if (allCompleted) {
      setCompletedUploadCount(uploadValues.length);
      setShowUploadCompleteToast(true);

      // Auto-hide toast after 5 seconds
      setTimeout(() => {
        setShowUploadCompleteToast(false);
      }, 5000);
    }
  }, [uploads]);

  // Setup keyboard shortcuts
  useKeyboardShortcuts({
    'ctrl+u': () => fileInputRef.current?.click(),
    'ctrl+n': () => handleCreateFolder(),
    'ctrl+f': () => searchInputRef.current?.focus(),
    'ctrl+a': (e) => {
      e.preventDefault();
      selectAll();
    },
    'ctrl+1': () => setActiveView('cloud-drive'),
    'ctrl+2': () => setActiveView('recents'),
    'ctrl+3': () => setActiveView('dedup'),
    'ctrl+4': () => setActiveView('favorites'),
    'delete': () => {
      if (selectedFiles.size > 0) {
        handleBulkDelete();
      }
    },
    'escape': () => {
      clearSelection();
      setPreviewFile(null);
      setShareFile(null);
    },
    'shift+?': () => setShowShortcuts(true)
  });

  const loadDedupStats = async () => {
    // Skip if already loading
    if (dedupLoading) {
      console.log('Skipping dedup load: already loading');
      return;
    }

    setDedupLoading(true);
    try {
      console.log('Loading dedup stats with cookie authentication');
      const savings = await storageService.getDedupSavings(); // No token needed - uses cookie
      setDedupStats({ savings, error: null });
      console.log('Dedup stats loaded successfully:', savings);
    } catch (error) {
      console.error('Failed to load dedup stats:', error);
      // Only set error if component is still mounted
      setDedupStats({
        savings: null,
        error: error.message || 'Failed to load deduplication stats'
      });
    } finally {
      setDedupLoading(false);
    }
  };

  // Function to handle file optimization
  const handleOptimizeFile = async (fileId) => {
    try {
      const result = await storageService.optimizeFileDedup(null, fileId); // No token needed - uses cookie
      if (result.status === 'optimized') {
        // Refresh files and dedup stats after successful optimization
        if (refreshFiles) refreshFiles();
        await loadDedupStats();
      }
      return result;
    } catch (error) {
      console.error('Optimization failed:', error);
      return { error: error.message };
    }
  };



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
          zkEnabled: zkEnabled && zkSessionUnlocked // Track if ZK encryption is active
        }
      }));

      const controller = new AbortController();
      abortControllers.current[uploadId] = controller;

      const result = await uploadFile(file, (progressData) => {
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

  const handleCreateFolder = async () => {
    const name = prompt('Enter folder name:');
    if (!name) return;
    await createFolder(name);
  };

  const handleShare = (fileId) => {
    const file = files.find(f => f.id === fileId);
    if (file) {
      setShareFile(file);
    }
  };

  const handleVersionHistory = (file) => {
    setVersionFile(file);
  };

  const handleVersionRestore = async () => {
    // Reload files after restore
    await refreshFiles();
  };

  const handleToggleFavorite = async (fileId) => {
    try {
      await storageService.toggleFavorite(fileId);
      // Refresh files to update favorite status
      await refreshFiles();
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
      alert('Failed to update favorite status');
    }
  };

  const handleFileCopy = async (file) => {
    try {
      // Check if file is Zero-Knowledge encrypted
      if (file.is_encrypted) {
        alert('Copying Zero-Knowledge encrypted files is not currently supported. Please download and re-upload the file manually.');
        return;
      }

      // Show loading state (optional - you can add a loading indicator here)
      console.log(`Copying file: ${file.name}...`);

      // Call server-side copy endpoint
      const response = await fetch(`${API_URL}/files/${file.id}/copy`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to copy file');
      }

      const copiedFile = await response.json();
      console.log(`File copied successfully: ${copiedFile.name}`);

      // Refresh file list to show the new copy
      await refreshFiles();

    } catch (error) {
      console.error('Failed to copy file:', error);
      alert(`Failed to create a copy of the file: ${error.message}`);
    }
  };

  const handleRenameFile = async (fileId, newName) => {
    try {
      await storageService.renameFile(null, fileId, newName);
      // Refresh files to show updated name
      await refreshFiles();
    } catch (error) {
      console.error('Failed to rename file:', error);
      throw error; // Re-throw to show error in modal
    }
  };

  const handleBulkDelete = async () => {
    if (window.confirm(`Are you sure you want to delete ${selectedFiles.size} files?`)) {
      await bulkDelete(Array.from(selectedFiles));
      clearSelection();
    }
  };

  // Handle file download with progress tracking
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
          isZK: file?.is_encrypted || false
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
          decryptProgress: file?.is_encrypted ? 100 : 0
        }
      }));

      // Remove from downloads after 3 seconds
      setTimeout(() => {
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
      }, 3000);

    } catch (error) {
      console.error('Download failed:', error);

      // Check if error is due to locked session
      if (error.message && (error.message.includes('locked') || error.message.includes('unlock'))) {
        console.log('[Download] Session locked - storing pending download for retry');

        // Store download info for retry after unlock
        setPendingDownload({ fileId, fileName });

        // Remove download from progress (will be retried after unlock)
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });

        // The SessionUnlockModal will be shown automatically by AuthContext
        // We'll retry the download in the modal's onClose handler
        return;
      }

      // Check if error is due to file corruption
      if (error.message && (
        error.message.includes('corruption') ||
        error.message.includes('corrupted') ||
        error.message.includes('tampered')
      )) {
        console.error('[Download] File corruption detected');

        // Store corruption error details for modal
        setCorruptionError({
          fileName,
          errorMessage: error.message
        });

        // Remove download from progress
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });

        // Modal will be shown automatically via corruptionError state
        return;
      }

      // For other errors, show error state
      setDownloads(prev => ({
        ...prev,
        [downloadId]: {
          ...prev[downloadId],
          status: 'error',
          error: error.message
        }
      }));

      // Remove error after 5 seconds
      setTimeout(() => {
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
      }, 5000);
    }
  };

  const handleBulkDownload = async () => {
    for (const fileId of selectedFiles) {
      const file = files.find(f => f.id === fileId);
      if (file) {
        await handleFileDownload(fileId, file.name);
      }
    }
  };

  // Handle session unlock modal close - retry pending download if any
  const handleSessionUnlockClose = async () => {
    if (pendingDownload && zkSessionUnlocked) {
      console.log('[Download] Session unlocked - retrying download:', pendingDownload.fileName);

      // Retry the download
      const { fileId, fileName } = pendingDownload;
      setPendingDownload(null);

      // Small delay to allow UI to update
      setTimeout(() => {
        handleFileDownload(fileId, fileName);
      }, 500);
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

    const files = Array.from(e.dataTransfer.files);
    files.forEach(handleFileUpload);
  };

  // Filter files
  const filteredFiles = files.filter(file => {
    // Search filter
    if (searchQuery && !file.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }

    // Type filter
    if (filters.type !== 'all') {
      const fileType = getFileType(file.name);
      if (fileType !== filters.type) return false;
    }

    // Size filter
    if (filters.size !== 'all') {
      const size = file.size;
      if (filters.size === 'small' && size >= 10 * 1024 * 1024) return false;
      if (filters.size === 'medium' && (size < 10 * 1024 * 1024 || size >= 100 * 1024 * 1024)) return false;
      if (filters.size === 'large' && size < 100 * 1024 * 1024) return false;
    }

    // Date filter
    if (filters.date !== 'all') {
      const fileDate = new Date(file.created_at);
      const now = new Date();
      const dayDiff = (now - fileDate) / (1000 * 60 * 60 * 24);

      if (filters.date === 'today' && dayDiff > 1) return false;
      if (filters.date === 'week' && dayDiff > 7) return false;
      if (filters.date === 'month' && dayDiff > 30) return false;
    }

    return true;
  });

  // Render main content based on active view
  const renderMainContent = () => {
    switch (activeView) {
      case 'recents':
        return (
          <RecentsView
            viewMode={viewMode}
            darkMode={darkMode}
            selectedFiles={selectedFiles}
            onFileClick={selectFile}
            onFilePreview={setPreviewFile}
            onFileDownload={handleFileDownload}
            onFileShare={handleShare}
            onFileDelete={deleteFile}
            onVersionHistory={handleVersionHistory}
          />
        );

      case 'favorites':
        return (
          <FavoritesView
            viewMode={viewMode}
            darkMode={darkMode}
            selectedFiles={selectedFiles}
            onFileClick={selectFile}
            onFilePreview={setPreviewFile}
            onFileDownload={handleFileDownload}
            onFileShare={handleShare}
            onFileDelete={deleteFile}
            onVersionHistory={handleVersionHistory}
          />
        );

      case 'shared-with-me':
        return (
          <SharedWithMeView
            viewMode={viewMode}
            darkMode={darkMode}
            selectedFiles={selectedFiles}
            onFileClick={selectFile}
            onFilePreview={setPreviewFile}
            onFileDownload={handleFileDownload}
            onFileShare={handleShare}
            onFileDelete={deleteFile}
            onVersionHistory={handleVersionHistory}
            onToggleFavorite={handleToggleFavorite}
            onRename={setRenameFile}
          />
        );

      case 'trash':
        return (
          <TrashView
            viewMode={viewMode}
            darkMode={darkMode}
            selectedFiles={selectedFiles}
            onFileClick={selectFile}
            onFilePreview={setPreviewFile}
            onFileDownload={handleFileDownload}
            onFileShare={handleShare}
            onVersionHistory={handleVersionHistory}
            onToggleFavorite={handleToggleFavorite}
            onFileInfo={setFileInfo}
            onRefresh={refreshFiles}
          />
        );

      case 'dedup':
        return (
          <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <DeduplicationPanel
              darkMode={darkMode}
              onOptimizeFile={handleOptimizeFile}
              stats={dedupStats}
              loading={dedupLoading}
              onRefresh={loadDedupStats}
            />
          </div>
        );

      case 'analytics':
        return (
          <AnalyticsView
            darkMode={darkMode}
            storageStats={storageStats}
          />
        );

      case 'settings':
        return (
          <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <h1 className={`text-2xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Settings
            </h1>
            <p className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
              Settings panel - Coming soon
            </p>
          </div>
        );

      case 'cloud-drive':
      default:
        return (
          <div
            className={`rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} ${isDragging ? 'ring-2 ring-blue-500' : ''
              }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {isDragging && (
              <div className="p-8 text-center border-2 border-dashed border-blue-500 m-4 rounded-lg">
                <Upload className="mx-auto mb-2 text-blue-500" size={48} />
                <p className="text-blue-500">Drop files here to upload</p>
              </div>
            )}

            {!isDragging && (
              <div className="p-4">
                {/* Search Results */}
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
                        className={`${darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'}`}
                      >
                        Home
                      </button>
                      {currentFolder && (
                        <>
                          <ChevronRight size={16} className="text-gray-400" />
                          <span className={darkMode ? 'text-white' : 'text-gray-900'}>
                            Current Folder
                          </span>
                        </>
                      )}
                    </div>

                    {/* Files and Folders */}
                    {viewMode === 'grid' ? (
                      <FileGrid
                        folders={folders}
                        files={filteredFiles}
                        selectedFiles={selectedFiles}
                        onFolderClick={navigateToFolder}
                        onFileClick={selectFile}
                        onFilePreview={setPreviewFile}
                        onFileDownload={handleFileDownload}
                        onFileShare={handleShare}
                        onFileDelete={deleteFile}
                        onVersionHistory={handleVersionHistory}
                        onToggleFavorite={handleToggleFavorite}
                        onRename={setRenameFile}
                        onFileInfo={setFileInfo}
                        onFileCopy={handleFileCopy}
                        darkMode={darkMode}
                      />
                    ) : (
                      <FileList
                        folders={folders}
                        files={filteredFiles}
                        selectedFiles={selectedFiles}
                        onFolderClick={navigateToFolder}
                        onFileClick={selectFile}
                        onFilePreview={setPreviewFile}
                        onFileDownload={handleFileDownload}
                        onFileShare={handleShare}
                        onFileDelete={deleteFile}
                        onVersionHistory={handleVersionHistory}
                        onToggleFavorite={handleToggleFavorite}
                        onRename={setRenameFile}
                        onFileInfo={setFileInfo}
                        onFileCopy={handleFileCopy}
                        darkMode={darkMode}
                      />
                    )}

                    {files.length === 0 && folders.length === 0 && (
                      <div className="text-center py-12">
                        <Upload className="mx-auto mb-3 text-gray-400" size={48} />
                        <p className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
                          No files or folders yet. Upload some files or create a folder to get started!
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Sidebar */}
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        darkMode={darkMode}
        storageStats={storageStats}
        isMobileOpen={isMobileSidebarOpen}
        onMobileToggle={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
      />

      {/* Main Content Area (with left margin for sidebar) */}
      <div className="lg:ml-64 min-h-screen">
        {/* Header */}
        <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b sticky top-0 z-30`}>
          <div className="px-4 py-4">
            <div className="flex justify-end items-center gap-3">
              <div className="flex-1 max-w-2xl">
                <SearchBar
                  onSearch={setSearchResults}
                  darkMode={darkMode}
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
                title="Keyboard shortcuts (Shift+?)"
              >
                <Info size={20} />
              </button>

              {/* ZK Lock Button - only show when ZK is enabled and unlocked */}
              {zkEnabled && zkSessionUnlocked && (
                <button
                  onClick={() => {
                    if (window.confirm('Lock your encryption session? You\'ll need your password to unlock it again.')) {
                      lockSession();
                    }
                  }}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-yellow-900/50 hover:bg-yellow-900/70 text-yellow-400' : 'bg-yellow-100 hover:bg-yellow-200 text-yellow-700'} transition-all`}
                  title="Lock encryption session"
                >
                  <Lock size={20} />
                </button>
              )}

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
            // Click on empty space (not on file cards) deselects all files
            if (e.target === e.currentTarget || !e.target.closest('[data-file-card]')) {
              clearSelection();
            }
          }}
        >
          {/* Storage Stats - only show in cloud-drive view */}
          {activeView === 'cloud-drive' && storageStats && (
            <StorageStats stats={storageStats} darkMode={darkMode} />
          )}

          {/* Filter Panel */}
          {showFilters && activeView === 'cloud-drive' && (
            <FilterPanel
              filters={filters}
              setFilters={setFilters}
              darkMode={darkMode}
            />
          )}

          {/* Action Bar - only show in cloud-drive view */}
          {activeView === 'cloud-drive' && (
            <div className="flex gap-3 mb-6">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                title="Upload files (Ctrl+U)"
              >
                <Upload size={20} />
                Upload Files
              </button>
              <button
                onClick={handleCreateFolder}
                className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
                title="New folder (Ctrl+N)"
              >
                <FolderPlus size={20} />
                New Folder
              </button>

              {/* Bulk Actions */}
              {selectedFiles.size > 0 && (
                <BulkActions
                  selectedCount={selectedFiles.size}
                  onDownload={handleBulkDownload}
                  onDelete={handleBulkDelete}
                  onClear={clearSelection}
                />
              )}

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
        />
      )}

      {versionFile && (
        <VersionHistory
          file={versionFile}
          onClose={() => setVersionFile(null)}
          onRestore={handleVersionRestore}
          darkMode={darkMode}
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

      {/* Session Unlock Modal (ZK Encryption) */}
      {showUnlockModal && (
        <SessionUnlockModal
          isOpen={showUnlockModal}
          onClose={handleSessionUnlockClose}
        />
      )}

      {/* File Corruption Modal */}
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
                Upload Done!
              </p>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {completedUploadCount} {completedUploadCount === 1 ? 'file' : 'files'} uploaded successfully
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
    </div>
  );
}
