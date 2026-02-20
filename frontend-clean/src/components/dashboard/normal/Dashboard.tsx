import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Upload, X, CheckCircle, Sun, Moon,
  LogOut, Home, ChevronRight, Grid,
  List, Info, Lock, ArrowUpDown, AlertTriangle, FolderPlus
} from 'lucide-react';
import Sidebar from '../Sidebar';
import RecentsView from '../RecentsView';
import FavoritesView from '../FavoritesView';
import SharedWithMeView from '../SharedWithMeView';
import TrashView from '../TrashView';
import AnalyticsView from '../AnalyticsView';
import QuotaAlertsView from '../QuotaAlertsView';
import DeduplicationPanel from '../DeduplicationPanel';
import AutoOrganizeView from '../AutoOrganizeView';
import RecommendationsView from '../RecommendationsView';
import SettingsView from '../SettingsView';
import SubscriptionDashboard from '../../subscription/SubscriptionDashboard';
import { useTheme } from '../../../contexts/ThemeContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useStorage } from '../../../contexts/StorageContext';
import { useNotification } from '../../../contexts/NotificationContext';
import StorageStats from '../StorageStats';
import QuickFilters from '../QuickFilters';
import { API_URL } from '../../../config/constants';
import FileGrid from '../FileGrid';
import FileList from '../FileList';
import UploadProgressComponent from '../UploadProgress';
import FilePreview from '../FilePreview';
import ShareOptionsModal from '../ShareOptionsModal';
import VersionHistory from '../VersionHistory';
import RenameModal from '../RenameModal';
import FileInfoPanel from '../FileInfoPanel';
import KeyboardShortcuts from '../KeyboardShortcuts';
import BulkActions from '../BulkActions';
import SearchBar from '../SearchBar';
import SearchResults from '../SearchResults';
import DownloadProgress from '../DownloadProgress';
import MigrationBanner from '../MigrationBanner';
import PaymentReminderBanner from '../PaymentReminderBanner';
import FreeAccountUpgradeBanner from '../FreeAccountUpgradeBanner';
import FileCorruptionModal from '../FileCorruptionModal';
import ShareBundleComposer from '../ShareBundleComposer';
import ServiceModeBadge from '../ServiceModeBadge';
// ZKDashboardLayout not needed in Normal Dashboard
import { getFileType } from '../../../utils/helpers';
import { useKeyboardShortcuts } from '../../../hooks/useKeyboardShortcuts';
import { storageService } from '../../../services/storageService';
import type {
  FileItem,
  FolderItem,
  UploadItem,
  DownloadItem,
  SearchResults as SearchResultsType,
  DeduplicationStats,
  ActiveViewType,
  SortByType,
  ViewMode,
  PendingDownload,
  CorruptionErrorInfo,
  NormalDashboardProps
} from '../types';
import { getErrorMessage } from '../types';

interface ErrorWithStatus extends Error {
  status?: number;
}

/**
 * NormalDashboard - Standard file management dashboard
 * For users without Zero-Knowledge encryption
 * 
 * Props:
 * - pendingDownload: Download that was interrupted by locked session (from parent Dashboard)
 * - onPendingDownload: Callback to lift pending download state to parent Dashboard
 */
const NormalDashboard: React.FC<NormalDashboardProps> = ({
  onPendingDownload
}) => {
  const { darkMode, toggleTheme } = useTheme();
  const { user, logout, isAuthenticated, loading: authLoading, zkEnabled, zkSessionUnlocked, lockSession } = useAuth();
  const {
    files,
    folders,
    currentFolder,
    currentFolderName,
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
  const { success: showSuccess } = useNotification();

  // Wrapper around deleteFile to show toast with Undo
  const handleDeleteFile = async (fileId: string, fileName?: string): Promise<void> => {
    await deleteFile(fileId, fileName);
    showSuccess(`"${fileName || 'File'}" moved to trash`, {
      duration: 6000,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await storageService.restoreFromTrash(fileId);
            await refreshFiles();
          } catch {
            // silently fail — file may already be permanently deleted
          }
        },
      },
    });
  };

  const [activeView, setActiveView] = useState<ActiveViewType>('cloud-drive');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery] = useState<string>('');
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [versionFile, setVersionFile] = useState<FileItem | null>(null);
  const [renameFile, setRenameFile] = useState<FileItem | null>(null);
  const [fileInfo, setFileInfo] = useState<FileItem | null>(null);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [showLockConfirm, setShowLockConfirm] = useState<boolean>(false);

  // Quick filter and sort state
  const handleUpgradeClick = (): void => {
    setActiveView('billing');
  };
  const [quickFilter, setQuickFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortByType>(() =>
    (localStorage.getItem('dashboard_sort_preference') as SortByType) || 'name'
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const abortControllers = useRef<Record<string, AbortController>>({});
  const [dedupStats, setDedupStats] = useState<DeduplicationStats | null>(null);
  const [dedupLoading, setDedupLoading] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<SearchResultsType | null>(null);
  const [showUploadCompleteToast, setShowUploadCompleteToast] = useState<boolean>(false);
  const [completedUploadCount, setCompletedUploadCount] = useState<number>(0);
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  // Local pending download state setter (used when parent doesn't provide handlers)
  const [, setLocalPendingDownload] = useState<PendingDownload | null>(null);
  // Use parent's callback if available, otherwise use local state setter
  // The actual pendingDownload value is read by parent Dashboard and passed to ZKDashboard
  const setPendingDownload = onPendingDownload ?? setLocalPendingDownload;
  const [corruptionError, setCorruptionError] = useState<CorruptionErrorInfo | null>(null);
  const [showShareBundleComposer, setShowShareBundleComposer] = useState<boolean>(false);

  useEffect(() => {
    // Don't attempt to load if auth is still loading or not authenticated
    if (authLoading || !isAuthenticated) {
      return;
    }

    // Load dedup stats when the dedup view is active
    if (activeView === 'dedup') {
      loadDedupStats();
    }
  }, [isAuthenticated, authLoading, activeView]);

  // Watch for upload completion to show toast
  useEffect(() => {
    const uploadValues = Object.values(uploads);
    const allCompleted = uploadValues.length > 0 &&
                         uploadValues.every(u => u.status === 'complete');

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
    'ctrl+n': () => { handleCreateFolder(); },
    'ctrl+f': () => searchInputRef.current?.focus(),
    'ctrl+a': (e: KeyboardEvent) => {
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

  const loadDedupStats = async (): Promise<void> => {
    // Skip if already loading
    if (dedupLoading) {
      console.log('Skipping dedup load: already loading');
      return;
    }

    setDedupLoading(true);
    try {
      const [savings, analytics] = await Promise.all([
        storageService.getDedupSavings(''),
        storageService.getDedupAnalytics(''),
      ]);
      setDedupStats({
        savings: savings as DeduplicationStats['savings'],
        analytics: analytics as DeduplicationStats['analytics'],
        error: null
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error('Failed to load dedup stats:', error);
      setDedupStats({
        savings: null,
        analytics: null,
        error: errorMessage
      });
    } finally {
      setDedupLoading(false);
    }
  };

  // Function to handle file optimization
  const handleOptimizeFile = async (fileId: string): Promise<{ status?: string; error?: string }> => {
    try {
      const result = await storageService.optimizeFileDedup('', fileId) as { status?: string; error?: string };
      if (result.status === 'optimized') {
        // Refresh files and dedup stats after successful optimization
        if (refreshFiles) await refreshFiles();
        await loadDedupStats();
      }
      return result;
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      console.error('Optimization failed:', error);
      return { error: errorMessage };
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
          zkEnabled: zkEnabled && zkSessionUnlocked,
          elapsedTime: 0,
        }
      }));

      const controller = new AbortController();
      abortControllers.current[uploadId] = controller;

      await uploadFile(file, (progressData) => {
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          // Map context UploadProgress to UploadItem
          const chunksUploaded = progressData.chunksUploaded || 0;
          const totalChunks = progressData.totalChunks || 0;
          const bytesUploaded = progressData.bytesUploaded || 0;
          return {
            ...prev,
            [uploadId]: {
              ...current,
              progress: progressData.progress,
              chunksUploaded,
              totalChunks,
              bytesUploaded,
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
        // Extract user-friendly error message
        const errorWithStatus = error as ErrorWithStatus;
        let errorMessage = getErrorMessage(error);

        // For 429 errors, show specific guidance
        if (errorWithStatus.status === 429) {
          // Check if it's a bandwidth limit error
          if (errorMessage.includes('Bandwidth limit exceeded')) {
            // Show alert with guidance
            const shouldLogout = window.confirm(
              `Upload failed: ${errorMessage}\n\n` +
              'If you recently upgraded your plan, please log out and log back in to refresh your session.\n\n' +
              'Click OK to log out now, or Cancel to try again later.'
            );

            if (shouldLogout) {
              // Trigger logout
              window.location.href = '/login';
              return;
            }
          } else {
            // Generic rate limit error
            alert(`Upload temporarily blocked: ${errorMessage}`);
          }
        }

        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: {
              ...current,
              status: 'error',
              error: errorMessage
            }
          };
        });

        // Auto-clear failed upload after 10 seconds
        setTimeout(() => {
          setUploads(prev => {
            const newUploads = { ...prev };
            delete newUploads[uploadId];
            return newUploads;
          });
        }, 10000);
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

  const handleToggleFavorite = async (fileId: string): Promise<void> => {
    try {
      await storageService.toggleFavorite(fileId);
      // Refresh files to update favorite status
      if (refreshFiles) await refreshFiles();
    } catch (error: unknown) {
      console.error('Failed to toggle favorite:', error);
      alert('Failed to update favorite status');
    }
  };

  const handleFileCopy = async (file: FileItem): Promise<void> => {
    try {
      // Check if file is Zero-Knowledge encrypted
      if (file.is_encrypted) {
        alert('Copying Zero-Knowledge encrypted files is not currently supported. Please download and re-upload the file manually.');
        return;
      }

      // Show loading state (optional - you can add a loading indicator here)
      console.log(`Copying file: ${file.name}...`);

      // Call server-side copy endpoint
      const response = await fetch(`${API_URL}/api/v1/files/${file.id}/copy`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json() as { error?: string };
        throw new Error(error.error || 'Failed to copy file');
      }

      const copiedFile = await response.json() as { name: string };
      console.log(`File copied successfully: ${copiedFile.name}`);

      // Refresh file list to show the new copy
      if (refreshFiles) await refreshFiles();

    } catch (error: unknown) {
      console.error('Failed to copy file:', error);
      const errorMessage = getErrorMessage(error);
      alert(`Failed to create a copy of the file: ${errorMessage}`);
    }
  };

  const handleRenameFile = async (fileId: string, newName: string): Promise<void> => {
    try {
      await storageService.renameFile('', fileId, newName);
      // Refresh files to show updated name
      if (refreshFiles) await refreshFiles();
    } catch (error: unknown) {
      console.error('Failed to rename file:', error);
      throw error; // Re-throw to show error in modal
    }
  };

  const handleBulkDelete = async (): Promise<void> => {
    if (window.confirm(`Are you sure you want to delete ${selectedFiles.size} files?`)) {
      await bulkDelete(Array.from(selectedFiles));
      clearSelection();
    }
  };

  // Handle file download with progress tracking
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
          isZK: file?.is_encrypted || false,
        }
      }));

      await downloadFile(fileId, fileName, (progressData) => {
        setDownloads(prev => {
          const current = prev[downloadId];
          if (!current) return prev;
          return {
            ...prev,
            [downloadId]: {
              ...current,
              progress: (progressData.progress as number) || 0,
              bytesDownloaded: (progressData.bytesDownloaded as number) || 0,
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

      // Remove from downloads after 3 seconds
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

      // Check if error is due to locked session
      if (errorMessage.includes('locked') || errorMessage.includes('unlock')) {
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
      if (errorMessage.includes('corruption') || errorMessage.includes('corrupted') || errorMessage.includes('tampered')) {
        console.error('[Download] File corruption detected');

        // Store corruption error details for modal
        setCorruptionError({
          fileName,
          errorMessage
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

  const handleBulkDownload = async (): Promise<void> => {
    for (const fileId of selectedFiles) {
      const file = files.find(f => f.id === fileId);
      if (file) {
        await handleFileDownload(fileId, file.name);
      }
    }
  };

  // Note: Session unlock modal is now managed by parent Dashboard component.
  // When a ZK user with locked session tries to download, the pending download
  // is lifted to parent state. After unlock, ZKDashboard mounts and handles
  // the retry via its useEffect watching pendingDownload prop.

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

  // Handle sort change with localStorage persistence
  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const newSort = e.target.value as SortByType;
    setSortBy(newSort);
    localStorage.setItem('dashboard_sort_preference', newSort);
  };

  // Filter and sort files
  const { filteredFolders, filteredFiles } = useMemo(() => {
    let resultFolders: FolderItem[] = [...folders];
    let resultFiles: FileItem[] = [...files];

    // Apply search filter first
    if (searchQuery) {
      resultFiles = resultFiles.filter(f =>
        f.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
      resultFolders = resultFolders.filter(f =>
        f.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Apply quick filter
    switch (quickFilter) {
      case 'all':
        // Show all
        break;
      case 'recent':
        // Files from last 7 days only, no folders
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        resultFiles = resultFiles.filter(f => {
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
        resultFiles = resultFiles.filter(f => getFileType(f.name) === quickFilter);
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
  }, [files, folders, quickFilter, sortBy, searchQuery]);

  // Render main content based on active view
  const renderMainContent = (): React.ReactElement => {
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
            onFileDelete={handleDeleteFile}
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
            onFileDelete={handleDeleteFile}
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
            onFileDelete={handleDeleteFile}
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
            onFileDelete={handleDeleteFile}
            onToggleFavorite={handleToggleFavorite}
            onFileInfo={setFileInfo}
            onRefresh={refreshFiles}
            onRestore={async () => {
              await refreshFiles();
              showSuccess('File restored successfully');
            }}
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
          />
        );

      case 'auto-organize':
        return (
          <AutoOrganizeView
            darkMode={darkMode}
            onNavigate={navigateToFolder}
          />
        );

      case 'recommendations':
        return (
          <RecommendationsView
            darkMode={darkMode}
            onFileClick={setPreviewFile}
          />
        );

      case 'quota-alerts':
        return (
          <QuotaAlertsView
            darkMode={darkMode}
            storageStats={storageStats}
          />
        );

      case 'storage-optimization':
        return (
          <AnalyticsView
            darkMode={darkMode}
          />
        );

      case 'settings':
        return (
          <SettingsView darkMode={darkMode} />
        );

      case 'billing':
        return (
          <SubscriptionDashboard />
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
                        onVersionHistory={handleVersionHistory}
                        onToggleFavorite={handleToggleFavorite}
                        onRename={setRenameFile}
                        onFileInfo={setFileInfo}
                        onFileCopy={handleFileCopy}
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
                        onVersionHistory={handleVersionHistory}
                        onToggleFavorite={handleToggleFavorite}
                        onRename={setRenameFile}
                        onFileInfo={setFileInfo}
                        onFileCopy={handleFileCopy}
                        darkMode={darkMode}
                      />
                    )}

                    {filteredFiles.length === 0 && filteredFolders.length === 0 && (
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

  // Normal Dashboard - Standard file management interface
  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Sidebar */}
      <Sidebar
        activeView={activeView}
        onViewChange={(view: string) => setActiveView(view as ActiveViewType)}
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
                  onSearch={(results) => { setSearchResults(results); }}
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

              {/* ZK Lock Button - only show when ZK is enabled and unlocked */}
              {zkEnabled && zkSessionUnlocked && (
                <button
                  onClick={() => setShowLockConfirm(true)}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-yellow-900/50 hover:bg-yellow-900/70 text-yellow-400' : 'bg-yellow-100 hover:bg-yellow-200 text-yellow-700'} transition-all`}
                  title="Lock encryption session"
                  type="button"
                >
                  <Lock size={20} />
                </button>
              )}

              {/* Service Mode Badge */}
              <ServiceModeBadge isZKMode={false} darkMode={darkMode} />

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
            // Click on empty space (not on file cards) deselects all files
            const target = e.target as HTMLElement;
            if (e.target === e.currentTarget || !target.closest('[data-file-card]')) {
              clearSelection();
            }
          }}
        >
          {/* Storage Stats - only show in cloud-drive view */}
          {activeView === 'cloud-drive' && storageStats && (
            <StorageStats
              stats={storageStats}
              darkMode={darkMode}
              onUpgradeClick={handleUpgradeClick}
            />
          )}

          {/* Billing Banners */}
          {activeView === 'cloud-drive' && (
            <>
              <PaymentReminderBanner darkMode={darkMode} />
              <FreeAccountUpgradeBanner darkMode={darkMode} />
            </>
          )}

          {/* Migration Banner - show when V1 files need upgrade */}
          {activeView === 'cloud-drive' && (
            <MigrationBanner />
          )}

          {/* Quick Filters */}
          {activeView === 'cloud-drive' && (
            <QuickFilters
              activeFilter={quickFilter}
              onFilterChange={setQuickFilter}
              darkMode={darkMode}
              isZK={false}
            />
          )}

          {/* Action Bar - only show in cloud-drive view */}
          {activeView === 'cloud-drive' && (
            <div className="flex gap-3 mb-4 items-center">
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
                  onShare={() => setShowShareBundleComposer(true)}
                  onClear={clearSelection}
                  darkMode={darkMode}
                />
              )}

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
                    // Reset input value to allow uploading the same file again
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />
            </div>
          )}

          {/* Upload Progress */}
          {Object.keys(uploads).length > 0 && (
            <UploadProgressComponent
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

      {/* Session Unlock Modal is now managed by parent Dashboard component
          to survive dashboard switches when zkSessionUnlocked changes */}

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

      {/* Share Bundle Composer Modal */}
      {showShareBundleComposer && (
        <ShareBundleComposer
          selectedFiles={Array.from(selectedFiles).map(id => files.find(f => f.id === id)).filter(f => f !== undefined && f !== null) as FileItem[]}
          selectedFolders={Array.from(selectedFiles).map(id => folders.find(f => f.id === id)).filter(f => f !== undefined && f !== null) as FolderItem[]}
          onClose={() => setShowShareBundleComposer(false)}
          onSuccess={() => {
            setShowShareBundleComposer(false);
            clearSelection();
          }}
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
                  if (lockSession) lockSession();
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

export default NormalDashboard;
