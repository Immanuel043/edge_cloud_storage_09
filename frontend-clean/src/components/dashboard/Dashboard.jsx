import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, File, X, CheckCircle, AlertCircle, Cloud, HardDrive, 
  Share2, Download, Trash2, FolderPlus, Folder, Sun, Moon, 
  User, LogOut, Home, Search, Settings, ChevronRight, Grid, 
  List, Filter, Eye, Copy, Wifi, WifiOff, Check, Info,
  Image, FileText, Video, Music, Archive, Code, Clock,
  Zap
} from 'lucide-react';
import DeduplicationPanel from './DeduplicationPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import StorageStats from './StorageStats';
import FileGrid from './FileGrid';
import FileList from './FileList';
import UploadProgress from './UploadProgress';
import FilePreview from './FilePreview';
import ShareModal from './ShareModal';
import FilterPanel from './FilterPanel';
import KeyboardShortcuts from './KeyboardShortcuts';
import BulkActions from './BulkActions';
import { formatBytes, formatDate, getFileIcon, getFileType } from '../../utils/helpers';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

export default function Dashboard() {
  const { darkMode, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
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

  const [viewMode, setViewMode] = useState('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploads, setUploads] = useState({});
  const [isDragging, setIsDragging] = useState(false);
  const [shareModal, setShareModal] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
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

  useEffect(() => {
  loadDedupStats();
}, []);


  // Setup keyboard shortcuts
  useKeyboardShortcuts({
    'ctrl+u': () => fileInputRef.current?.click(),
    'ctrl+n': () => handleCreateFolder(),
    'ctrl+f': () => searchInputRef.current?.focus(),
    'ctrl+a': (e) => {
      e.preventDefault();
      selectAll();
    },
    'delete': () => {
      if (selectedFiles.size > 0) {
        handleBulkDelete();
      }
    },
    'escape': () => {
      clearSelection();
      setPreviewFile(null);
      setShareModal(null);
    },
    'shift+?': () => setShowShortcuts(true)
  });

  const loadDedupStats = async () => {
  try {
    const stats = await storageService.getDedupSavings(user?.token);
    setDedupStats(stats);
  } catch (error) {
    console.error('Failed to load dedup stats:', error);
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
          progress: 0,
          status: 'uploading',
          chunksUploaded: 0,
          totalChunks: 0,
          startTime
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

  const handleShare = async (fileId) => {
    const shareData = await createShareLink(fileId);
    setShareModal(shareData);
  };

  const handleBulkDelete = async () => {
    if (window.confirm(`Are you sure you want to delete ${selectedFiles.size} files?`)) {
      await bulkDelete(Array.from(selectedFiles));
      clearSelection();
    }
  };

  const handleBulkDownload = async () => {
    for (const fileId of selectedFiles) {
      const file = files.find(f => f.id === fileId);
      if (file) {
        await downloadFile(fileId, file.name);
      }
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

  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b`}>
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <h1 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                ☁️ Edge Cloud Storage
              </h1>
              <nav className="flex gap-2">
                <button
                  
                  onClick={() => navigateToFolder(null)}
                  className={`px-3 py-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                  title="Home"
                >
                  <Home size={18} />
                  </button>
                  <button
                  onClick={() => setShowDedupPanel(!showDedupPanel)}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'} ${showDedupPanel ? 'ring-2 ring-indigo-500' : ''}`}
                  title="Deduplication Analytics"
                >
                <Zap size={20} className={showDedupPanel ? 'text-indigo-500' : ''} />
                </button>
              </nav>
              
              {/* Online/Offline Indicator */}
              <div className={`flex items-center gap-1 px-2 py-1 rounded ${
                isOnline 
                  ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                  : 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
              }`}>
                {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
                <span className="text-xs">{isOnline ? 'Online' : 'Offline'}</span>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search files... (Ctrl+F)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`pl-10 pr-4 py-2 rounded-lg w-64 ${darkMode ? 'bg-gray-700 text-white' : 'bg-gray-100'}`}
                />
                <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
              </div>
              
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                  showFilters ? 'ring-2 ring-blue-500' : ''
                }`}
                title="Filters"
              >
                <Filter size={20} />
              </button>
              
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
              
              <div className="flex items-center gap-2">
                <span className={darkMode ? 'text-gray-300' : 'text-gray-600'}>
                  {user?.email}
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
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Storage Stats */}
        {storageStats && <StorageStats stats={storageStats} darkMode={darkMode} />}

        {/* Deduplication Panel - Add this */}
        {showDedupPanel && (
          <div className="mb-6">
            <DeduplicationPanel 
              darkMode={darkMode}
              token={user?.token}
              onOptimizeFile={async (fileId) => {
              const result = await storageService.optimizeFileDedup(user?.token, fileId);
              if (result.status === 'optimized') {
                refreshFiles(); // Refresh file list
                loadDedupStats(); // Reload dedup stats
              }
              return result;
              }}
            />
          </div>
    )}

        {/* Filter Panel */}
        {showFilters && (
          <FilterPanel 
            filters={filters} 
            setFilters={setFilters}
            darkMode={darkMode}
          />
        )}

        {/* Action Bar */}
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

        {/* Upload Progress */}
        {Object.keys(uploads).length > 0 && (
          <UploadProgress 
            uploads={uploads}
            onCancel={cancelUpload}
            darkMode={darkMode}
          />
        )}

        {/* File Browser */}
        <div
          className={`rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} ${
            isDragging ? 'ring-2 ring-blue-500' : ''
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
                  onFileDownload={downloadFile}
                  onFileShare={handleShare}
                  onFileDelete={deleteFile}
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
                  onFileDownload={downloadFile}
                  onFileShare={handleShare}
                  onFileDelete={deleteFile}
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
            </div>
          )}
        </div>

        {/* Modals */}
        {shareModal && (
          <ShareModal
            shareData={shareModal}
            onClose={() => setShareModal(null)}
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
      </div>
    </div>
  );
}