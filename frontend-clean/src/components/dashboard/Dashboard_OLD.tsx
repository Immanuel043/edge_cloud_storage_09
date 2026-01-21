import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, Cloud, FolderPlus, Sun, Moon, 
  LogOut, Home, ChevronRight, Grid, 
  List, Info, Zap
} from 'lucide-react';
import DeduplicationPanel from './DeduplicationPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import StorageStats from './StorageStats';
import FileGrid from './FileGrid';
import FileList from './FileList';
import UploadProgressComponent from './UploadProgress';
import FilePreview from './FilePreview';
import ShareOptionsModal from './ShareOptionsModal';
import VersionHistory from './VersionHistory';
import KeyboardShortcuts from './KeyboardShortcuts';
import BulkActions from './BulkActions';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import { getFileType } from '../../utils/helpers';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { storageService } from '../../services/storageService';
import type { FileItem, UploadItem, SearchResults as SearchResultsType, DeduplicationStats, FilterPanelFilters } from './types';
import { getErrorMessage } from './types';
import type { UploadProgress } from '../../types/hooks.types';

type ViewMode = 'grid' | 'list';

const Dashboard: React.FC = () => {
  const { darkMode, toggleTheme } = useTheme();
  const { user, logout, isAuthenticated, loading: authLoading } = useAuth();
  const { 
    files, 
    folders, 
    currentFolder, 
    storageStats, 
    selectedFiles,
    uploadFile,
    downloadFile,
    deleteFile,
    bulkDelete,
    createFolder,
    navigateToFolder,
    selectFile,
    selectAll,
    clearSelection,
    refreshFiles
  } = useStorage();

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [versionFile, setVersionFile] = useState<FileItem | null>(null);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [filters] = useState<FilterPanelFilters>({
    type: 'all',
    size: 'all',
    date: 'all'
  });
  const [searchQuery] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const abortControllers = useRef<Record<string, AbortController>>({});
  const [showDedupPanel, setShowDedupPanel] = useState<boolean>(false);
  const [dedupStats, setDedupStats] = useState<DeduplicationStats | null>(null);
  const [dedupLoading, setDedupLoading] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<SearchResultsType | null>(null);
  

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

  // Setup keyboard shortcuts
  useKeyboardShortcuts({
    'ctrl+u': () => fileInputRef.current?.click(),
    'ctrl+n': () => { handleCreateFolder(); },
    'ctrl+f': () => searchInputRef.current?.focus(),
    'ctrl+a': (e: KeyboardEvent) => {
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
      setShareFile(null);
    },
    'shift+?': () => setShowShortcuts(true)
  });

  const loadDedupStats = async (): Promise<void> => {
    // Skip if already loading
    if (dedupLoading) {
      console.log('Skipping dedup load: already loading');
      return;
    }

    setDedupLoading(true);
    try {
      console.log('Loading dedup stats with cookie authentication');
      const savings = await storageService.getDedupSavings('');
      setDedupStats({ 
        savings: (savings as { savings?: unknown })?.savings as DeduplicationStats['savings'] || null, 
        analytics: null,
        error: null 
      });
      console.log('Dedup stats loaded successfully:', savings);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error('Failed to load dedup stats:', error);
      // Only set error if component is still mounted
      setDedupStats({
        savings: null,
        analytics: null,
        error: errorMessage
      });
    } finally {
      setDedupLoading(false);
    }
  };

  // Handle file upload
  const handleFileUpload = async (file: File): Promise<void> => {
    const uploadId = crypto.randomUUID();
    const startTime = Date.now();
    
    try {
      setUploads(prev => ({
        ...prev,
        [uploadId]: {
          id: uploadId,
          name: file.name,
          status: 'uploading',
          progress: 0,
          chunksUploaded: 0,
          totalChunks: 0,
          bytesUploaded: 0,
          totalBytes: file.size,
          zkEnabled: false,
          elapsedTime: 0,
        }
      }));

      const controller = new AbortController();
      abortControllers.current[uploadId] = controller;

      await uploadFile(file, (progressData: UploadProgress) => {
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: {
              ...current,
              progress: progressData.progress,
              chunksUploaded: progressData.chunksUploaded || 0,
              totalChunks: progressData.totalChunks || 0,
              bytesUploaded: progressData.bytesUploaded || 0,
              elapsedTime: Date.now() - startTime
            }
          };
        });
      });

      setUploads(prev => {
        const current = prev[uploadId];
        if (!current) return prev;
        return {
          ...prev,
          [uploadId]: {
            ...current,
            status: 'complete',
            progress: 100
          }
        };
      });

      setTimeout(() => {
        setUploads(prev => {
          const newUploads = { ...prev };
          delete newUploads[uploadId];
          return newUploads;
        });
      }, 3000);

      if (refreshFiles) await refreshFiles();
      
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: { ...current, status: 'cancelled' }
          };
        });
      } else {
        const errorMessage = getErrorMessage(error);
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: { ...current, status: 'error', error: errorMessage }
          };
        });
      }
    } finally {
      delete abortControllers.current[uploadId];
    }
  };

  const cancelUpload = (uploadId: string): void => {
    abortControllers.current[uploadId]?.abort();
  };

  const handleCreateFolder = async (): Promise<void> => {
    const name = prompt('Enter folder name:');
    if (!name) return;
    await createFolder(name);
  };

  const handleShare = (fileId: string): void => {
    const file = files.find(f => f.id === fileId);
    if (file) {
      setShareFile(file);
    }
  };

  const handleVersionHistory = (file: FileItem): void => {
    setVersionFile(file);
  };

  const handleVersionRestore = async (): Promise<void> => {
    // Reload files after restore
    if (refreshFiles) await refreshFiles();
  };

  const handleBulkDelete = async (): Promise<void> => {
    if (window.confirm(`Are you sure you want to delete ${selectedFiles.size} files?`)) {
      await bulkDelete(Array.from(selectedFiles));
      clearSelection();
    }
  };

  const handleBulkDownload = async (): Promise<void> => {
    for (const fileId of selectedFiles) {
      const file = files.find(f => f.id === fileId);
      if (file) {
        await downloadFile(fileId, file.name);
      }
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(false);
    
    const droppedFiles = Array.from(e.dataTransfer.files);
    droppedFiles.forEach(handleFileUpload);
  };

  // Filter files
  const filteredFiles = files.filter((file: FileItem): boolean => {
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
      const size = file.size || 0;
      if (filters.size === 'small' && size >= 10 * 1024 * 1024) return false;
      if (filters.size === 'medium' && (size < 10 * 1024 * 1024 || size >= 100 * 1024 * 1024)) return false;
      if (filters.size === 'large' && size < 100 * 1024 * 1024) return false;
    }

    // Date filter
    if (filters.date !== 'all') {
      const fileDate = new Date(file.created_at || file.updated_at || 0);
      const now = new Date();
      const dayDiff = (now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24);
      
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
              <h1 className={`text-xl font-bold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                <Cloud size={24} /> Edge Cloud Storage
              </h1>
              <nav className="flex gap-2">
                <button
                  onClick={() => {
                    navigateToFolder(null);
                    setShowDedupPanel(false); // Close dedup panel when going home
                  }}
                  className={`px-3 py-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                  title="Home"
                  type="button"
                >
                  <Home size={18} />
                </button>
                <button
                  onClick={() => setShowDedupPanel(!showDedupPanel)}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'} ${showDedupPanel ? 'ring-2 ring-indigo-500' : ''}`}
                  title="Deduplication Analytics"
                  type="button"
                >
                  <Zap size={20} className={showDedupPanel ? 'text-indigo-500' : ''} />
                  {dedupLoading && (
                    <span className="ml-1 text-xs">Loading...</span>
                  )}
                </button>
              </nav>
              
              {/* Add other required indicators */}
              
            </div>
            
            <div className="flex items-center gap-3">
              <div className="w-96">
                <SearchBar
                  onSearch={(results) => setSearchResults(results)}
                  darkMode={darkMode}
                />
              </div>
              
              <button
                onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                title={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}
                type="button"
              >
                {viewMode === 'grid' ? <List size={20} /> : <Grid size={20} />}
              </button>
              
              <button
                onClick={toggleTheme}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-100'}`}
                title="Toggle theme"
                type="button"
              >
                {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              </button>
              
              <button
                onClick={() => setShowShortcuts(true)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                title="Keyboard shortcuts (Shift+?)"
                type="button"
              >
                <Info size={20} />
              </button>
              
              <div className="flex items-center gap-2">
                <span className={darkMode ? 'text-gray-300' : 'text-gray-600'}>
                  {user?.username || 'User'}
                </span>
                <button
                  onClick={logout}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                  title="Logout"
                  type="button"
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
        {showDedupPanel && isAuthenticated && (
          <div className="mb-6">
            <DeduplicationPanel
              darkMode={darkMode}
              stats={dedupStats}
              loading={dedupLoading}
              onRefresh={loadDedupStats}
            />
          </div>
        )}
        {/* Show loading or error state*/}
        {showDedupPanel && !isAuthenticated && (
          <div className={`mb-6 p-4 ${darkMode ? 'bg-yellow-900/30 border-yellow-700 text-yellow-400' : 'bg-yellow-100 border-yellow-400 text-yellow-700'} border rounded`}>
            Authentication required to view deduplication stats
          </div>
        )}


        {/* Action Bar */}
        <div className="flex gap-3 mb-6">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            title="Upload files (Ctrl+U)"
            type="button"
          >
            <Upload size={20} />
            Upload Files
          </button>
          <button
            onClick={handleCreateFolder}
            className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
            title="New folder (Ctrl+N)"
            type="button"
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
              onShare={() => {}}
              onClear={clearSelection}
              darkMode={darkMode}
            />
          )}
          
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              const files = e.target.files;
              if (files) {
                Array.from(files).forEach(handleFileUpload);
              }
            }}
            className="hidden"
          />
        </div>

        {/* Upload Progress */}
        {Object.keys(uploads).length > 0 && (
          <UploadProgressComponent 
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
              {/* Search Results */}
              {searchResults ? (
                <SearchResults
                  results={searchResults}
                  onClose={() => setSearchResults(null)}
                  onFileClick={(file) => setPreviewFile(file as FileItem)}
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
                      type="button"
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
                  onVersionHistory={handleVersionHistory}
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
                  onVersionHistory={handleVersionHistory}
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
      </div>
    </div>
  );
};

export default Dashboard;
