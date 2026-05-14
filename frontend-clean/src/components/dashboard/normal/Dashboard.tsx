import React, { Suspense, useState, useEffect, useRef, useMemo } from 'react';
import {
  Upload, X, CheckCircle, Home, ChevronRight,
  ArrowUpDown, FolderPlus, Clock, FolderOpen, Image,
  FileText, Video, Music
} from 'lucide-react';
// Eager imports — always visible on default cloud-drive view
import Sidebar from '../Sidebar';
import { DashboardTopBar } from '../shared/DashboardTopBar';
import { LockSessionDialog } from '../shared/LockSessionDialog';
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
import BulkActions from '../BulkActions';
import SearchBar from '../SearchBar';
import DownloadProgress from '../DownloadProgress';
import MigrationBanner from '../MigrationBanner';
import PaymentReminderBanner from '../PaymentReminderBanner';
import FreeAccountUpgradeBanner from '../FreeAccountUpgradeBanner';
import { TransientUploadError } from '../../../utils/uploadErrors';
import { normalUploadService } from '../../../services/normalUploadService';

// Lazy-loaded views — only one renders at a time via switch
const RecentsView = React.lazy(() => import('../RecentsView'));
const FavoritesView = React.lazy(() => import('../FavoritesView'));
const SharedWithMeView = React.lazy(() => import('../SharedWithMeView'));
const TrashView = React.lazy(() => import('../TrashView'));
const AnalyticsView = React.lazy(() => import('../AnalyticsView'));
const QuotaAlertsView = React.lazy(() => import('../QuotaAlertsView'));
const DeduplicationPanel = React.lazy(() => import('../DeduplicationPanel'));
const AutoOrganizeView = React.lazy(() => import('../AutoOrganizeView'));
const RecommendationsView = React.lazy(() => import('../RecommendationsView'));
const SettingsView = React.lazy(() => import('../SettingsView'));
const SecurityAlertsView = React.lazy(() => import('../SecurityAlertsView'));
const ShareLinkManager = React.lazy(() => import('../ShareLinkManager'));
const ShareAnalyticsDashboard = React.lazy(() => import('../ShareAnalyticsDashboard'));
const SubscriptionDashboard = React.lazy(() => import('../../subscription/SubscriptionDashboard'));
const PaymentPortal = React.lazy(() => import('../../payment/PaymentPortal'));
const SearchResults = React.lazy(() => import('../SearchResults'));

// Lazy-loaded modals — render only on user action
const FilePreview = React.lazy(() => import('../FilePreview'));
const ShareOptionsModal = React.lazy(() => import('../ShareOptionsModal'));
const VersionHistory = React.lazy(() => import('../VersionHistory'));
const RenameModal = React.lazy(() => import('../RenameModal'));
const NewFolderModal = React.lazy(() => import('../NewFolderModal'));
const FileInfoPanel = React.lazy(() => import('../FileInfoPanel'));
const KeyboardShortcuts = React.lazy(() => import('../KeyboardShortcuts'));
const ShareBundleComposer = React.lazy(() => import('../ShareBundleComposer'));
const FileCorruptionModal = React.lazy(() => import('../FileCorruptionModal'));
import { getFileType } from '../../../utils/helpers';
import { useKeyboardShortcuts } from '../../../hooks/useKeyboardShortcuts';
import { storageService } from '../../../services/storageService';
import { Button, ConfirmModal, EmptyState } from '@/components/ui';
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
  NormalDashboardProps,
  NameSuggestionEntry,
} from '../types';
import { getErrorMessage } from '../types';
import {
  getPendingSuggestions,
  acceptNameSuggestion as apiAcceptSuggestion,
  dismissNameSuggestion as apiDismissSuggestion,
  getAnalysisStatus,
} from '../../../services/nameSuggestionService';

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
  const { success: showSuccess, info: showInfo, error: showError } = useNotification();

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

  const [activeView, setActiveView] = useState<ActiveViewType>(() => {
    // Honor ?view=<name> deep links (e.g. /?view=shared-with-me from share emails)
    const viewParam = new URLSearchParams(window.location.search).get('view');
    const validViews: ReadonlySet<string> = new Set([
      'cloud-drive', 'recents', 'favorites', 'shared-with-me', 'trash',
      'dedup', 'analytics', 'auto-organize', 'recommendations', 'quota-alerts',
      'storage-optimization', 'settings', 'billing', 'payment-portal',
      'security-alerts', 'my-share-links', 'share-analytics',
    ]);
    return viewParam && validViews.has(viewParam) ? (viewParam as ActiveViewType) : 'cloud-drive';
  });
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery] = useState<string>('');
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [versionFile, setVersionFile] = useState<FileItem | null>(null);
  const [renameFile, setRenameFile] = useState<FileItem | null>(null);
  const [showNewFolder, setShowNewFolder] = useState<boolean>(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<{
    ids: string[];
    fileCount: number;
    folderCount: number;
    needsForce: boolean;
  } | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState<boolean>(false);
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
  const fileRefs = useRef<Record<string, File>>({});
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

  // Name suggestion state
  const [nameSuggestions, setNameSuggestions] = useState<Record<string, NameSuggestionEntry>>({});

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

  // Fetch pending name suggestions when the SET of file ids changes.
  // Depending directly on `files` would re-fire every time the array
  // reference changes — which happens twice per upload (optimistic insert +
  // server reconcile both call setFiles with new arrays containing the same
  // ids) — and produce a redundant batch fetch. The memoised id key collapses
  // those two updates into one effect run.
  const fileIdsKey = useMemo(
    () => (files || []).map(f => f.id).sort().join(','),
    [files],
  );
  useEffect(() => {
    if (!fileIdsKey) return;
    const fileIds = fileIdsKey.split(',');
    getPendingSuggestions(fileIds)
      .then(res => setNameSuggestions(res.suggestions))
      .catch(() => setNameSuggestions({}));
  }, [fileIdsKey]);

  // Watch for upload completion to show toast + poll for name suggestions
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

      // Poll analysis status for recently uploaded files (name suggestion polling)
      // Use file names to match against recently loaded files since UploadItem doesn't store server file ID
      const uploadedNames = new Set(uploadValues.map(u => u.name));
      const recentFileIds = (files || [])
        .filter(f => uploadedNames.has(f.name))
        .map(f => f.id);
      if (recentFileIds.length > 0) {
        pollAnalysisStatus(recentFileIds);
      }
    }
  }, [uploads]);

  // Poll analysis-status for recently uploaded files (3s intervals, max 10 attempts)
  const pollAnalysisStatus = async (fileIds: string[]) => {
    const pending = new Set(fileIds);
    let attempts = 0;
    const maxAttempts = 10;
    const interval = 3000;

    const poll = async () => {
      if (pending.size === 0 || attempts >= maxAttempts) return;
      attempts++;

      for (const fid of [...pending]) {
        try {
          const status = await getAnalysisStatus(fid);
          if (status.status === 'completed' || status.status === 'skipped') {
            pending.delete(fid);
            if (status.has_suggestion) {
              // Refresh pending suggestions batch
              const allFileIds = files.map(f => f.id);
              const res = await getPendingSuggestions(allFileIds);
              setNameSuggestions(res.suggestions);
            }
          }
        } catch {
          // Ignore — will retry
        }
      }

      if (pending.size > 0 && attempts < maxAttempts) {
        setTimeout(poll, interval);
      }
    };

    setTimeout(poll, interval);
  };

  // Accept/dismiss name suggestion handlers
  const handleAcceptNameSuggestion = async (fileId: string) => {
    try {
      await apiAcceptSuggestion(fileId);
      setNameSuggestions(prev => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
      await refreshFiles();
      showSuccess('File renamed successfully');
    } catch {
      // Ignore
    }
  };

  const handleDismissNameSuggestion = async (fileId: string) => {
    try {
      await apiDismissSuggestion(fileId);
      setNameSuggestions(prev => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
    } catch {
      // Ignore
    }
  };

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

    // Store File reference for potential retry
    fileRefs.current[uploadId] = file;

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

      const result = await uploadFile(file, (progressData) => {
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          // Map context UploadProgress to UploadItem
          const chunksUploaded = progressData.chunksUploaded || 0;
          const totalChunks = progressData.totalChunks || 0;
          const bytesUploaded = progressData.bytesUploaded || 0;
          const progressUploadId = (progressData as unknown as { uploadId?: string }).uploadId;
          const updatedItem: UploadItem = {
            ...current,
            progress: progressData.progress,
            chunksUploaded,
            totalChunks,
            bytesUploaded,
            elapsedTime: Date.now() - startTime
          };
          if (progressUploadId) {
            updatedItem.serverUploadId = progressUploadId;
          }
          return { ...prev, [uploadId]: updatedItem };
        });
      }, controller.signal);

      // Capture serverUploadId from result
      if (result.serverUploadId) {
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: { ...current, serverUploadId: result.serverUploadId! }
          };
        });
      }

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

      // Clean up file ref on success
      delete fileRefs.current[uploadId];

      setTimeout(() => {
        setUploads(prev => {
          const newUploads = { ...prev };
          delete newUploads[uploadId];
          return newUploads;
        });
      }, 3000);

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        // User cancel — clean up file ref
        delete fileRefs.current[uploadId];

        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: { ...current, status: 'cancelled' }
          };
        });

        // Auto-clear cancelled upload after 3 seconds
        setTimeout(() => {
          setUploads(prev => {
            const newUploads = { ...prev };
            delete newUploads[uploadId];
            return newUploads;
          });
        }, 3000);
      } else {
        // Extract user-friendly error message
        const errorWithStatus = error as ErrorWithStatus;
        const errorMessage = getErrorMessage(error);
        const isNetworkError = errorMessage.includes('Internet connection lost');
        const isTransient = error instanceof TransientUploadError;

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
              error: errorMessage,
              isNetworkError,
              canRetry: isNetworkError || isTransient,
            }
          };
        });

        if (isNetworkError || isTransient) {
          // Keep file ref for retry — don't auto-clear
          // User will see retry button
        } else {
          // Non-network error — clean up file ref and auto-clear after 10 seconds
          delete fileRefs.current[uploadId];
          setTimeout(() => {
            setUploads(prev => {
              const newUploads = { ...prev };
              delete newUploads[uploadId];
              return newUploads;
            });
          }, 10000);
        }
      }
    } finally {
      delete abortControllers.current[uploadId];
    }
  };

  const cancelUpload = (uploadId: string): void => {
    abortControllers.current[uploadId]?.abort();
  };

  const retryUpload = (uploadId: string): void => {
    const file = fileRefs.current[uploadId];
    if (!file) {
      // File lost (page refresh) — remove error entry
      setUploads(prev => {
        const newUploads = { ...prev };
        delete newUploads[uploadId];
        return newUploads;
      });
      return;
    }

    // Clean up the error entry and file ref
    delete fileRefs.current[uploadId];
    setUploads(prev => {
      const newUploads = { ...prev };
      delete newUploads[uploadId];
      return newUploads;
    });

    // Re-upload — the context will detect the checkpoint and resume
    void handleFileUpload(file);
  };

  // Notify user about interrupted uploads that can be resumed
  useEffect(() => {
    const checkpointPrefix = 'upload_checkpoint_';
    const maxAge = 24 * 60 * 60 * 1000;

    (async () => {
      const now = Date.now();
      // Snapshot keys first — safe to remove during iteration
      const allKeys = Array.from(
        { length: localStorage.length },
        (_, i) => localStorage.key(i)
      ).filter(Boolean) as string[];
      const checkpointKeys = allKeys.filter(k => k.startsWith(checkpointPrefix));

      let resumableCount = 0;

      for (const key of checkpointKeys) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const checkpoint = JSON.parse(raw) as { savedAt: number; serverUploadId?: string };

          // Expired (>24hr) — garbage-collect
          if (now - checkpoint.savedAt >= maxAge) {
            localStorage.removeItem(key);
            continue;
          }

          // No serverUploadId — shouldn't exist, garbage-collect
          if (!checkpoint.serverUploadId) {
            localStorage.removeItem(key);
            continue;
          }

          // Validate against server
          const result = await normalUploadService.getServerUploadStatus(checkpoint.serverUploadId);

          if (result === 'unknown') {
            // Can't reach server — preserve checkpoint, count as resumable (offline-safe)
            resumableCount++;
          } else if (result && result.missing_chunks.length < result.total_chunks) {
            // Server session alive with some chunks uploaded — resumable
            resumableCount++;
          } else {
            // null (server confirmed gone) or zero progress — garbage-collect
            localStorage.removeItem(key);
          }
        } catch {
          // Invalid JSON or other parse error — garbage-collect
          localStorage.removeItem(key);
        }
      }

      if (resumableCount > 0) {
        showInfo(
          `You have ${resumableCount} interrupted upload(s) that can be resumed. Re-select the file(s) to continue.`,
          { duration: 8000 }
        );
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateFolder = (): void => {
    setShowNewFolder(true);
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

  const handleBulkDelete = (): void => {
    if (selectedFiles.size === 0) return;
    const ids = Array.from(selectedFiles);
    const folderIdSet = new Set(folders.map((f) => f.id));
    const folderCount = ids.filter((id) => folderIdSet.has(id)).length;
    const fileCount = ids.length - folderCount;
    setBulkDeleteConfirm({ ids, fileCount, folderCount, needsForce: false });
  };

  const runBulkDelete = async (force: boolean): Promise<void> => {
    if (!bulkDeleteConfirm) return;
    const { ids } = bulkDeleteConfirm;
    setBulkDeleting(true);
    try {
      await bulkDelete(ids, { force });
      setBulkDeleteConfirm(null);
      clearSelection();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Backend returns this exact phrase when a non-empty folder blocks delete.
      if (!force && /force=true/i.test(message)) {
        setBulkDeleteConfirm({ ...bulkDeleteConfirm, needsForce: true });
      } else {
        setBulkDeleteConfirm(null);
        showError(message || 'Failed to delete selection');
      }
    } finally {
      setBulkDeleting(false);
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

  const openFilePicker = (): void => {
    fileInputRef.current?.click();
  };

  const uploadEmptyAction = (label = 'Drag files here or browse'): React.ReactElement => (
    <button
      type="button"
      onClick={openFilePicker}
      className="flex min-h-12 items-center gap-2 rounded-lg border border-dashed border-primary/50 bg-primary/5 px-4 py-3 text-body-sm font-medium text-primary transition-colors hover:bg-primary/10"
    >
      <Upload className="h-4 w-4" />
      {label}
    </button>
  );

  const folderEmptyAction = (): React.ReactElement => (
    <Button
      variant="secondary"
      size="md"
      onClick={handleCreateFolder}
      leftIcon={<FolderPlus className="h-4 w-4" />}
    >
      New folder
    </Button>
  );

  const cloudDriveEmptyState = ((): React.ReactElement => {
    const actions = (includeFolderAction: boolean, uploadLabel?: string): React.ReactElement => (
      <div className="flex flex-col items-center gap-3 sm:flex-row">
        {uploadEmptyAction(uploadLabel)}
        {includeFolderAction && folderEmptyAction()}
      </div>
    );

    switch (quickFilter) {
      case 'recent':
        return (
          <EmptyState
            icon={<Clock />}
            title="No recent files"
            description="Files opened or updated in the last 7 days will appear here."
            action={uploadEmptyAction('Upload files')}
            size="lg"
          />
        );
      case 'folders':
        return (
          <EmptyState
            icon={<FolderPlus />}
            title="No folders"
            description="Create a folder to organize related files."
            action={folderEmptyAction()}
            size="lg"
          />
        );
      case 'image':
        return (
          <EmptyState
            icon={<Image />}
            title="No image files"
            description="Upload JPG, PNG, GIF, or WebP files to see them here."
            action={uploadEmptyAction('Upload images')}
            size="lg"
          />
        );
      case 'document':
        return (
          <EmptyState
            icon={<FileText />}
            title="No document files"
            description="Upload PDFs, text files, or office documents to see them here."
            action={uploadEmptyAction('Upload documents')}
            size="lg"
          />
        );
      case 'video':
        return (
          <EmptyState
            icon={<Video />}
            title="No video files"
            description="Upload MP4, MOV, or WebM files to see them here."
            action={uploadEmptyAction('Upload videos')}
            size="lg"
          />
        );
      case 'audio':
        return (
          <EmptyState
            icon={<Music />}
            title="No audio files"
            description="Upload MP3, WAV, or M4A files to see them here."
            action={uploadEmptyAction('Upload audio')}
            size="lg"
          />
        );
      case 'all':
      default:
        return currentFolder ? (
          <EmptyState
            icon={<FolderOpen />}
            title="This folder is empty"
            description={`Add files${currentFolderName ? ` to ${currentFolderName}` : ''} or create a nested folder.`}
            action={actions(true)}
            size="lg"
          />
        ) : (
          <EmptyState
            icon={<Upload />}
            title="Your drive is empty"
            description="Upload files or create a folder to get started."
            action={actions(true)}
            size="lg"
          />
        );
    }
  })();

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

      case 'my-share-links':
        return <ShareLinkManager darkMode={darkMode} />;

      case 'share-analytics':
        return <ShareAnalyticsDashboard darkMode={darkMode} />;

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
          <div className="rounded-lg bg-surface p-6">
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

      case 'security-alerts':
        return <SecurityAlertsView />;

      case 'settings':
        return (
          <SettingsView darkMode={darkMode} />
        );

      case 'billing':
        return (
          <SubscriptionDashboard onOpenPaymentPortal={() => setActiveView('payment-portal')} />
        );

      case 'payment-portal':
        return (
          <PaymentPortal onBack={() => setActiveView('billing')} />
        );

      case 'cloud-drive':
      default:
        return (
          <div
            className={`rounded-lg bg-surface ${isDragging ? 'ring-2 ring-primary' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {isDragging && (
              <div className="m-4 rounded-lg border-2 border-dashed border-primary p-8 text-center">
                <Upload className="mx-auto mb-2 text-primary" size={48} />
                <p className="text-primary">Drop files here to upload</p>
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
                    <div className="mb-4 flex items-center gap-2 text-body-sm">
                      <button
                        onClick={() => navigateToFolder(null)}
                        className={`flex items-center gap-1 transition-colors ${currentFolder ? 'text-primary hover:text-primary/80' : 'text-fg'}`}
                        type="button"
                      >
                        <Home size={16} />
                        Home
                      </button>
                      {currentFolder && (
                        <>
                          <ChevronRight size={16} className="text-fg-subtle" />
                          <span className="font-medium text-fg">
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
                        emptyState={cloudDriveEmptyState}
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
                        nameSuggestions={nameSuggestions}
                        onAcceptNameSuggestion={handleAcceptNameSuggestion}
                        onDismissNameSuggestion={handleDismissNameSuggestion}
                      />
                    ) : (
                      <FileList
                        folders={filteredFolders}
                        files={filteredFiles}
                        emptyState={cloudDriveEmptyState}
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
                        nameSuggestions={nameSuggestions}
                        onAcceptNameSuggestion={handleAcceptNameSuggestion}
                        onDismissNameSuggestion={handleDismissNameSuggestion}
                      />
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
    <div className="min-h-screen bg-bg">
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
        {/* Header — shared top bar (see shared/DashboardTopBar). */}
        <DashboardTopBar
          search={
            <SearchBar
              onSearch={(results) => { setSearchResults(results); }}
              darkMode={darkMode}
            />
          }
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          darkMode={darkMode}
          onToggleTheme={toggleTheme}
          onShowShortcuts={() => setShowShortcuts(true)}
          onLockSession={
            zkEnabled && zkSessionUnlocked ? () => setShowLockConfirm(true) : undefined
          }
          username={user?.username || 'User'}
          onLogout={logout}
          isZKMode={false}
        />

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
                <ArrowUpDown size={16} className="text-fg-muted" />
                <select
                  value={sortBy}
                  onChange={handleSortChange}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-body-sm text-fg"
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
              onRetry={retryUpload}
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
          <Suspense fallback={
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          }>
            {renderMainContent()}
          </Suspense>
        </div>
      </div>

      {/* Modals — lazy-loaded, rendered only on user action */}
      <Suspense fallback={null}>
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

      {showNewFolder && (
        <NewFolderModal
          open={showNewFolder}
          onClose={() => setShowNewFolder(false)}
          onCreate={async (name) => { await createFolder(name); }}
        />
      )}

      {bulkDeleteConfirm && !bulkDeleteConfirm.needsForce && (
        <ConfirmModal
          open
          onClose={() => !bulkDeleting && setBulkDeleteConfirm(null)}
          onConfirm={() => runBulkDelete(false)}
          title="Move to trash"
          message={(() => {
            const { fileCount, folderCount } = bulkDeleteConfirm;
            const parts: string[] = [];
            if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
            if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
            return `Delete ${parts.join(' and ')}? Files move to trash and can be restored.`;
          })()}
          confirmLabel={bulkDeleting ? 'Deleting...' : 'Delete'}
          variant="danger"
          loading={bulkDeleting}
        />
      )}

      {bulkDeleteConfirm && bulkDeleteConfirm.needsForce && (
        <ConfirmModal
          open
          onClose={() => !bulkDeleting && setBulkDeleteConfirm(null)}
          onConfirm={() => runBulkDelete(true)}
          title="Folder isn't empty"
          message="One or more selected folders contain files or subfolders. Delete the folder and everything inside it? Files move to trash and can be restored."
          confirmLabel={bulkDeleting ? 'Deleting...' : 'Delete everything'}
          variant="danger"
          loading={bulkDeleting}
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
      </Suspense>

      {/* Upload Complete Toast */}
      {showUploadCompleteToast && (
        <div className="fixed right-4 top-4 z-50 animate-slide-in">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-elevated px-6 py-4 shadow-2xl">
            <div className="shrink-0">
              <CheckCircle size={24} className="text-success" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-fg">Upload done!</p>
              <p className="text-body-sm text-fg-muted">
                {completedUploadCount} {completedUploadCount === 1 ? 'file' : 'files'} uploaded successfully
              </p>
            </div>
            <button
              onClick={() => setShowUploadCompleteToast(false)}
              className="shrink-0 rounded-lg p-1 transition-colors hover:bg-surface-muted"
              type="button"
              aria-label="Dismiss"
            >
              <X size={18} className="text-fg-muted" />
            </button>
          </div>
        </div>
      )}

      {/* Lock Session Confirmation Modal — shared primitive-based dialog. */}
      <LockSessionDialog
        open={showLockConfirm}
        onClose={() => setShowLockConfirm(false)}
        onConfirm={() => {
          if (lockSession) lockSession();
        }}
      />
    </div>
  );
};

export default NormalDashboard;
