import React, { useState, useRef, useMemo } from 'react';
import {
  Upload, X, CheckCircle, Cloud, Sun, Moon, LogOut, Home,
  Settings, ChevronRight, Grid, List, Info, Lock, FolderPlus, Shield, Trash2,
  ArrowUpDown, AlertTriangle, CreditCard
} from 'lucide-react';
import { ZK_SERVICE_URL } from '../../config/constants';
import zkEncryptionService from '../../services/zkEncryptionService';
import { UploadError, UPLOAD_ERROR_TYPES } from '../../services/zkAuthService';
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
import SubscriptionDashboard from '../subscription/SubscriptionDashboard';
import KeyboardShortcuts from './KeyboardShortcuts';
import MigrationBanner from './MigrationBanner';
import FileCorruptionModal from './FileCorruptionModal';
import ShareOptionsModal from './ShareOptionsModal';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { getFileType } from '../../utils/helpers';
import type { ZKDashboardLayoutProps, FileItem, FolderItem, UploadItem, DownloadItem, UploadProgressData, DownloadProgressData, UploadErrorInfo, CorruptionErrorInfo, SearchResults as SearchResultsType } from './types';
import { getErrorMessage } from './types';

type ViewMode = 'grid' | 'list';
type ActiveView = 'cloud-drive' | 'settings' | 'billing' | 'trash';
type SortBy = 'name' | 'date' | 'size' | 'type';

/**
 * ZKDashboardLayout - Simplified dashboard for Zero-Knowledge encrypted users
 */
const ZKDashboardLayout: React.FC<ZKDashboardLayoutProps> = ({
  darkMode,
  toggleTheme,
  user,
  logout,
  isUnlocked,
  onLock,
  files,
  folders,
  currentFolder,
  currentFolderName,
  storageStats,
  selectedFiles,
  uploadFile,
  downloadFile,
  deleteFile,
  createFolder,
  navigateToFolder,
  selectFile,
  selectAll,
  clearSelection,
  refreshFiles,
}) => {
  // View state
  const [activeView, setActiveView] = useState<ActiveView>('cloud-drive');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchResults, setSearchResults] = useState<SearchResultsType | null>(null);

  // Filter and sort state
  const [quickFilter, setQuickFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortBy>(() =>
    (localStorage.getItem('zk_sort_preference') as SortBy) || 'name'
  );

  // Modal state
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [renameFile, setRenameFile] = useState<FileItem | null>(null);
  const [fileInfo, setFileInfo] = useState<FileItem | null>(null);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [showLockConfirm, setShowLockConfirm] = useState<boolean>(false);

  // Upload state
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [showUploadCompleteToast, setShowUploadCompleteToast] = useState<boolean>(false);
  const [completedUploadCount, setCompletedUploadCount] = useState<number>(0);
  const [uploadError, setUploadError] = useState<UploadErrorInfo | null>(null);

  // Download state
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  const [corruptionError, setCorruptionError] = useState<CorruptionErrorInfo | null>(null);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllers = useRef<Record<string, AbortController>>({});

  // Handle sort change with localStorage persistence
  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const newSort = e.target.value as SortBy;
    setSortBy(newSort);
    localStorage.setItem('zk_sort_preference', newSort);
  };

  // Filter and sort files
  const { filteredFolders, filteredFiles } = useMemo(() => {
    let resultFolders: FolderItem[] = [...folders];
    let resultFiles: FileItem[] = [...files];

    // Apply quick filter
    switch (quickFilter) {
      case 'all':
        // Show all
        break;
      case 'recent':
        // Files from last 7 days only, no folders
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        resultFiles = files.filter(f => {
          const fileDate = new Date(f.last_accessed || f.updated_at || f.created_at || 0);
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
          return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
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
    'ctrl+a': (e: KeyboardEvent) => {
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
          zkEnabled: true,
          elapsedTime: 0,
        }
      }));

      const controller = new AbortController();
      abortControllers.current[uploadId] = controller;

      await uploadFile(file, (progressData: UploadProgressData) => {
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: {
              ...current,
              progress: progressData.progress,
              chunksUploaded: progressData.chunksUploaded,
              totalChunks: progressData.totalChunks,
              bytesUploaded: progressData.bytesUploaded || (progressData.chunksUploaded * (file.size / progressData.totalChunks)),
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

      await refreshFiles();

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
        // Determine error type and show appropriate toast
        let errorType = 'unknown';
        let errorMessage = 'Upload failed. Please try again.';

        if (error instanceof UploadError) {
          errorType = error.type;
          switch (error.type) {
            case UPLOAD_ERROR_TYPES.QUOTA_EXCEEDED:
              errorMessage = 'Storage quota exceeded. Please free up space or upgrade your plan.';
              break;
            case UPLOAD_ERROR_TYPES.RATE_LIMITED:
              errorMessage = 'Upload rate limit reached. Please wait a moment and try again.';
              break;
            case UPLOAD_ERROR_TYPES.AUTH:
              errorMessage = 'Session expired. Please log in again.';
              break;
            default:
              errorMessage = getErrorMessage(error);
          }
        } else {
          errorMessage = getErrorMessage(error);
        }

        // Update upload state
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: { ...current, status: 'error', error: errorMessage }
          };
        });

        // Show error toast
        setUploadError({
          type: errorType,
          message: errorMessage,
          fileName: file.name
        });

        // Auto-hide error toast after 8 seconds
        setTimeout(() => setUploadError(null), 8000);

        // Remove failed upload from list after delay
        setTimeout(() => {
          setUploads(prev => {
            const newUploads = { ...prev };
            delete newUploads[uploadId];
            return newUploads;
          });
        }, 5000);
      }
    } finally {
      delete abortControllers.current[uploadId];
    }
  };

  const cancelUpload = (uploadId: string): void => {
    abortControllers.current[uploadId]?.abort();
  };

  // Handle file download with progress
  const handleFileDownload = async (fileId: string, fileName: string): Promise<void> => {
    const downloadId = crypto.randomUUID();
    const file = files.find(f => f.id === fileId);

    try {
      setDownloads(prev => ({
        ...prev,
        [downloadId]: {
          id: downloadId,
          fileName,
          status: 'downloading',
          progress: 0,
          bytesDownloaded: 0,
          totalBytes: file?.size || 0,
          isZK: true,
        }
      }));

      await downloadFile(fileId, fileName, (progressData: DownloadProgressData) => {
        setDownloads(prev => {
          const current = prev[downloadId];
          if (!current) return prev;
          return {
            ...prev,
            [downloadId]: {
              ...current,
              ...progressData,
              status: 'downloading'
            }
          };
        });
      });

      // Mark as completed
      setDownloads(prev => {
        const current = prev[downloadId];
        if (!current) return prev;
        return {
          ...prev,
          [downloadId]: {
            ...current,
            status: 'complete',
            progress: 100,
          }
        };
      });

      // Remove after delay
      setTimeout(() => {
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
      }, 3000);

    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error('Download failed:', error);

      // Check for corruption
      if (errorMessage.includes('corruption') || errorMessage.includes('corrupted') || errorMessage.includes('tampered')) {
        setCorruptionError({ fileName, errorMessage });
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
        return;
      }

      // Show error state
      setDownloads(prev => {
        const current = prev[downloadId];
        if (!current) return prev;
        return {
          ...prev,
          [downloadId]: {
            ...current,
            status: 'error',
            error: errorMessage
          }
        };
      });

      setTimeout(() => {
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[downloadId];
          return newDownloads;
        });
      }, 5000);
    }
  };

  const handleCreateFolder = async (): Promise<void> => {
    const name = prompt('Enter folder name:');
    if (!name) return;
    await createFolder(name);
  };

  // Handle share attempt - show blocked message
  const handleShare = (fileId: string): void => {
    const file = files.find(f => f.id === fileId);
    if (file) {
      setShareFile(file);
    }
  };

  const handleRenameFile = async (fileId: string, newName: string): Promise<void> => {
    try {
      // ZK: encrypt new filename client-side (server never sees plaintext)
      const { encryptedFilename, filenameIV } = zkEncryptionService.encryptFilename(newName);
      const response = await fetch(`${ZK_SERVICE_URL}/api/v1/zk/files/${fileId}/rename`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          encrypted_file_name: encryptedFilename,
          file_name_iv: filenameIV,
        }),
      });

      if (!response.ok) {
        const error = await response.json() as { detail?: string };
        throw new Error(error.detail || 'Failed to rename file');
      }

      // Refresh file list to show updated name
      await refreshFiles();
      setRenameFile(null);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error('Rename failed:', error);
      alert(`Failed to rename file: ${errorMessage}`);
    }
  };

  // Handle file delete with confirmation
  const handleDeleteFile = async (fileId: string, fileName?: string): Promise<void> => {
    const displayName = fileName || 'this file';
    if (!window.confirm(`Are you sure you want to delete "${displayName}"?`)) return;
    await deleteFile(fileId, fileName);
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

  // Render main content
  const renderMainContent = (): React.ReactElement => {
    if (activeView === 'settings') {
      return <SettingsView darkMode={darkMode} />;
    }

    if (activeView === 'billing') {
      return <SubscriptionDashboard />;
    }

    if (activeView === 'trash') {
      return (
        <TrashView
          viewMode={viewMode}
          darkMode={darkMode}
          selectedFiles={selectedFiles}
          onFileClick={selectFile}
          onFilePreview={(file: FileItem) => setPreviewFile(file)}
          onFileDownload={handleFileDownload}
          onVersionHistory={() => {}}
          onFileShare={() => {}}
          onFileDelete={handleDeleteFile}
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
                    className={`flex items-center gap-1 ${currentFolder ? (darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700') : (darkMode ? 'text-white' : 'text-gray-900')} transition-colors`}
                    type="button"
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
                    onFileDelete={handleDeleteFile}
                    onVersionHistory={() => {}}
                    onRename={setRenameFile}
                    onFileInfo={setFileInfo}
                    darkMode={darkMode}
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
                    onFileDelete={handleDeleteFile}
                    onVersionHistory={() => {}}
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
            type="button"
          >
            <Cloud size={20} />
            <span className="font-medium text-sm">Encrypted Files</span>
          </button>

          <button
            onClick={() => setActiveView('billing')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeView === 'billing'
                ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg'
                : darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-blue-50'
            }`}
            type="button"
          >
            <CreditCard size={20} />
            <span className="font-medium text-sm">Billing & Plans</span>
          </button>

          <button
            onClick={() => setActiveView('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeView === 'settings'
                ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-lg'
                : darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-green-50'
            }`}
            type="button"
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
            type="button"
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
                  onSearch={(results) => setSearchResults(results)}
                  darkMode={darkMode}
                  zkMode={true}
                  files={files}
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
                title="Keyboard shortcuts"
                type="button"
              >
                <Info size={20} />
              </button>

              {/* Lock Session Button */}
              <button
                onClick={() => setShowLockConfirm(true)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-yellow-900/50 hover:bg-yellow-900/70 text-yellow-400' : 'bg-yellow-100 hover:bg-yellow-200 text-yellow-700'} transition-all`}
                title="Lock encryption session"
                type="button"
              >
                <Lock size={20} />
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
        </header>

        {/* Main Content */}
        <div
          className="px-4 py-6"
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (e.target === e.currentTarget || !target.closest('[data-file-card]')) {
              clearSelection();
            }
          }}
        >
          {/* ZK Storage Stats */}
          {activeView === 'cloud-drive' && (
            <ZKStorageStats
              stats={storageStats}
              darkMode={darkMode}
              onUpgradeClick={() => setActiveView('billing')}
            />
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
                type="button"
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
                type="button"
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
                onChange={(e) => {
                  const files = e.target.files;
                  if (files) {
                    Array.from(files).forEach(handleFileUpload);
                  }
                  e.target.value = '';
                }}
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
          isZK={true}
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
              type="button"
            >
              <X size={18} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
            </button>
          </div>
        </div>
      )}

      {/* Upload Error Toast */}
      {uploadError && (
        <div className="fixed top-4 right-4 z-50 animate-slide-in">
          <div className={`flex items-start gap-3 px-6 py-4 rounded-xl shadow-2xl border max-w-md ${
            darkMode
              ? 'bg-gray-800 border-red-700/50'
              : 'bg-white border-red-200'
          }`}>
            <div className="flex-shrink-0 mt-0.5">
              <AlertTriangle size={24} className="text-red-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Upload Failed
              </p>
              <p className={`text-sm mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'} truncate`} title={uploadError.fileName}>
                {uploadError.fileName}
              </p>
              <p className={`text-sm mt-2 ${darkMode ? 'text-red-400' : 'text-red-600'}`}>
                {uploadError.message}
              </p>
              {uploadError.type === UPLOAD_ERROR_TYPES.QUOTA_EXCEEDED && (
                <p className={`text-xs mt-2 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                  Tip: Delete some files or upgrade your storage plan.
                </p>
              )}
              {uploadError.type === UPLOAD_ERROR_TYPES.RATE_LIMITED && (
                <p className={`text-xs mt-2 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                  Tip: Wait a few seconds before retrying.
                </p>
              )}
            </div>
            <button
              onClick={() => setUploadError(null)}
              className={`flex-shrink-0 p-1 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'
              }`}
              type="button"
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
                  type="button"
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
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLockConfirm(false);
                  onLock();
                }}
                className="flex-1 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-yellow-500 to-orange-600 hover:from-yellow-600 hover:to-orange-700 transition-all"
                type="button"
              >
                Lock Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ZKDashboardLayout;
