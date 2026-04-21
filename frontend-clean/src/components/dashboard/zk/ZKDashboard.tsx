import React, { Suspense, useState, useRef, useMemo, useEffect } from 'react';
import {
  Upload, X, CheckCircle, Cloud, Home, Settings, ChevronRight, Lock,
  FolderPlus, Shield, Trash2, ArrowUpDown, AlertTriangle, CreditCard,
} from 'lucide-react';
import { ZK_SERVICE_URL } from '../../../config/constants';
import zkEncryptionService from '../../../services/zkEncryptionService';
import { UploadError, UPLOAD_ERROR_TYPES, restoreFromTrash as zkRestoreFromTrash } from '../../../services/zkAuthService';
// Eager imports — always visible on default cloud-drive view
import ZKStorageStats from '../ZKStorageStats';
import ZKEncryptionStatus from '../ZKEncryptionStatus';
import QuickFilters from '../QuickFilters';
import FileGrid from '../FileGrid';
import FileList from '../FileList';
import UploadProgress from '../UploadProgress';
import DownloadProgress from '../DownloadProgress';
import SearchBar from '../SearchBar';
import MigrationBanner from '../MigrationBanner';
import { DashboardTopBar } from '../shared/DashboardTopBar';
import { LockSessionDialog } from '../shared/LockSessionDialog';
import { NavItem, NavSection } from '@/components/layout';

// Lazy-loaded views
const TrashView = React.lazy(() => import('../TrashView'));
const SettingsView = React.lazy(() => import('../SettingsView'));
const SubscriptionDashboard = React.lazy(() => import('../../subscription/SubscriptionDashboard'));
const PaymentPortal = React.lazy(() => import('../../payment/PaymentPortal'));
const SearchResults = React.lazy(() => import('../SearchResults'));

// Lazy-loaded modals
const FilePreview = React.lazy(() => import('../FilePreview'));
const RenameModal = React.lazy(() => import('../RenameModal'));
const FileInfoPanel = React.lazy(() => import('../FileInfoPanel'));
const ShareOptionsModal = React.lazy(() => import('../ShareOptionsModal'));
const KeyboardShortcuts = React.lazy(() => import('../KeyboardShortcuts'));
const FileCorruptionModal = React.lazy(() => import('../FileCorruptionModal'));
import { useKeyboardShortcuts } from '../../../hooks/useKeyboardShortcuts';
import { useNotification } from '../../../contexts/NotificationContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useStorage } from '../../../contexts/StorageContext';
import { getFileType } from '../../../utils/helpers';
import type { ZKDashboardProps, FileItem, FolderItem, UploadItem, DownloadItem, UploadErrorInfo, CorruptionErrorInfo, SearchResults as SearchResultsType } from '../types';
import { getErrorMessage } from '../types';

type ViewMode = 'grid' | 'list';
type ActiveView = 'cloud-drive' | 'settings' | 'billing' | 'payment-portal' | 'trash';
type SortBy = 'name' | 'date' | 'size' | 'type';

/**
 * ZKDashboard - Zero-Knowledge encrypted file management dashboard
 * Provides client-side encryption, decryption, and secure file operations
 */
const ZKDashboard: React.FC<ZKDashboardProps> = ({
  pendingDownload,
  onClearPendingDownload,
}) => {
  const { darkMode, toggleTheme } = useTheme();
  const { user, logout, zkSessionUnlocked: isUnlocked, lockSession } = useAuth();
  const onLock = lockSession || (() => {});
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
    createFolder,
    navigateToFolder,
    selectFile,
    selectAll,
    clearSelection,
    refreshFiles,
  } = useStorage();
  const { success: showSuccess } = useNotification();

  const handleDeleteFile = async (fileId: string, fileName?: string): Promise<void> => {
    await deleteFile(fileId, fileName);
    showSuccess(`"${fileName || 'File'}" moved to trash`, {
      duration: 6000,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await zkRestoreFromTrash(fileId);
            await refreshFiles();
          } catch {
            // silently fail
          }
        },
      },
    });
  };

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
  const pendingDownloadProcessedRef = useRef<string | null>(null);

  // Handle pending download retry from parent Dashboard
  // This handles the case where a download was started in NormalDashboard with a locked session,
  // user unlocks via SessionUnlockModal, and then the dashboard switches to ZKDashboard
  useEffect(() => {
    if (pendingDownload && isUnlocked) {
      // Prevent processing the same pending download multiple times
      const downloadKey = `${pendingDownload.fileId}-${pendingDownload.fileName}`;
      if (pendingDownloadProcessedRef.current === downloadKey) {
        return;
      }
      pendingDownloadProcessedRef.current = downloadKey;

      console.log('[ZKDashboard] Processing pending download from parent:', pendingDownload.fileName);

      // Small delay to ensure component is fully mounted
      const retryTimeout = setTimeout(async () => {
        const { fileId, fileName } = pendingDownload;

        // Clear the pending download first to prevent re-processing
        if (onClearPendingDownload) {
          onClearPendingDownload();
        }

        // Trigger the download
        try {
          const downloadId = crypto.randomUUID();
          const file = files.find(f => f.id === fileId);

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

          await downloadFile(fileId, fileName, (progressData) => {
            setDownloads(prev => {
              const current = prev[downloadId];
              if (!current) return prev;
              return {
                ...prev,
                [downloadId]: {
                  ...current,
                  status: 'downloading',
                  progress: (progressData.progress as number) || 0,
                  bytesDownloaded: (progressData.bytesDownloaded as number) || 0,
                  ...(progressData.decryptProgress !== undefined && { decryptionProgress: progressData.decryptProgress as number }),
                  ...(progressData.currentChunk !== undefined && { chunksDownloaded: progressData.currentChunk as number }),
                  ...(progressData.totalChunks !== undefined && { totalChunks: progressData.totalChunks as number })
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

          console.log('[ZKDashboard] Pending download completed successfully:', fileName);
        } catch (error) {
          console.error('[ZKDashboard] Pending download retry failed:', error);
        }
      }, 300);

      return () => clearTimeout(retryTimeout);
    }
  }, [pendingDownload, isUnlocked, onClearPendingDownload, downloadFile, files]);

  // Handle sort change with localStorage persistence
  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const newSort = e.target.value as SortBy;
    setSortBy(newSort);
    localStorage.setItem('zk_sort_preference', newSort);
  };

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
          const fileDate = new Date((f.last_accessed as string) || f.updated_at || f.created_at || 0);
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

      await uploadFile(file, (progressData) => {
        const chunksUploaded = progressData.chunksUploaded ?? 0;
        const totalChunks = progressData.totalChunks ?? 1;
        setUploads(prev => {
          const current = prev[uploadId];
          if (!current) return prev;
          return {
            ...prev,
            [uploadId]: {
              ...current,
              progress: progressData.progress,
              chunksUploaded,
              totalChunks,
              bytesUploaded: progressData.bytesUploaded || (chunksUploaded * (file.size / totalChunks)),
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

      await downloadFile(fileId, fileName, (progressData) => {
        setDownloads(prev => {
          const current = prev[downloadId];
          if (!current) return prev;
          return {
            ...prev,
            [downloadId]: {
              ...current,
              status: 'downloading',
              progress: (progressData.progress as number) || 0,
              bytesDownloaded: (progressData.bytesDownloaded as number) || 0,
              ...(progressData.decryptProgress !== undefined && { decryptionProgress: progressData.decryptProgress as number }),
              ...(progressData.currentChunk !== undefined && { chunksDownloaded: progressData.currentChunk as number }),
              ...(progressData.totalChunks !== undefined && { totalChunks: progressData.totalChunks as number })
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
      return <SubscriptionDashboard onOpenPaymentPortal={() => setActiveView('payment-portal')} />;
    }

    if (activeView === 'payment-portal') {
      return <PaymentPortal onBack={() => setActiveView('billing')} />;
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
          onRestore={async () => {
            await refreshFiles();
            showSuccess('File restored successfully');
          }}
        />
      );
    }

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
            <p className="text-primary">Drop files here to upload (encrypted)</p>
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
                  <div className="py-12 text-center">
                    <div className="mb-4 flex justify-center">
                      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/10">
                        <Shield className="text-success" size={48} />
                      </div>
                    </div>
                    <p className="mb-2 text-h3 font-medium text-fg">
                      Your encrypted storage is empty
                    </p>
                    <p className="text-body-sm text-fg-muted">
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
    <div className="min-h-screen bg-bg">
      {/*
        ZK Sidebar — narrower nav (encrypted-only flows), built on `NavItem` +
        `NavSection` layout primitives. Signature green ZK accent kept in the
        brand lockup; the rest uses Signal tokens so dark-mode swaps cleanly.
      */}
      <aside className="fixed top-0 left-0 z-40 h-full w-64 border-r border-border bg-surface flex flex-col">
        {/* Brand */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-success to-emerald-600 shadow-md">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-body font-semibold text-fg">ZK Storage</div>
            <div className="text-caption text-success">End-to-End Encrypted</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Primary">
          <NavSection>
            <NavItem
              icon={<Cloud />}
              label="Encrypted Files"
              active={activeView === 'cloud-drive'}
              onClick={() => setActiveView('cloud-drive')}
            />
            <NavItem
              icon={<CreditCard />}
              label="Billing & Plans"
              active={activeView === 'billing'}
              onClick={() => setActiveView('billing')}
            />
            <NavItem
              icon={<Settings />}
              label="Settings"
              active={activeView === 'settings'}
              onClick={() => setActiveView('settings')}
            />
            <NavItem
              icon={<Trash2 />}
              label="Trash"
              active={activeView === 'trash'}
              onClick={() => setActiveView('trash')}
            />
          </NavSection>
        </nav>

        {/* Encryption status footer */}
        <div className="shrink-0 border-t border-border bg-surface-muted px-4 py-3">
          <div className="flex items-center gap-2 text-success">
            <Lock className="h-3.5 w-3.5" />
            <span className="text-caption font-semibold uppercase tracking-wide">
              Session Active
            </span>
          </div>
          <p className="mt-1 text-caption text-fg-subtle">AES-256-GCM encryption</p>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="lg:ml-64 min-h-screen">
        {/* Header — shared top bar; ZK mode always has a lock button visible. */}
        <DashboardTopBar
          search={
            <SearchBar
              onSearch={(results) => setSearchResults(results)}
              darkMode={darkMode}
              zkMode={true}
              files={files}
            />
          }
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          darkMode={darkMode}
          onToggleTheme={toggleTheme}
          onShowShortcuts={() => setShowShortcuts(true)}
          onLockSession={() => setShowLockConfirm(true)}
          username={user?.username || 'User'}
          onLogout={logout}
          isZKMode={true}
        />

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
                className="flex items-center gap-2 rounded-lg bg-surface-muted px-4 py-2 text-fg transition-colors hover:bg-surface-elevated"
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
      </Suspense>

      {/* Upload Complete Toast */}
      {showUploadCompleteToast && (
        <div className="fixed right-4 top-4 z-50 animate-slide-in">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-elevated px-6 py-4 shadow-2xl">
            <div className="shrink-0">
              <CheckCircle size={24} className="text-success" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-fg">Encrypted & uploaded!</p>
              <p className="text-body-sm text-fg-muted">
                {completedUploadCount} {completedUploadCount === 1 ? 'file' : 'files'} secured
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

      {/* Upload Error Toast */}
      {uploadError && (
        <div className="fixed right-4 top-4 z-50 animate-slide-in">
          <div className="flex max-w-md items-start gap-3 rounded-xl border border-danger/40 bg-surface-elevated px-6 py-4 shadow-2xl">
            <div className="mt-0.5 shrink-0">
              <AlertTriangle size={24} className="text-danger" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-fg">Upload failed</p>
              <p className="mt-1 truncate text-body-sm text-fg-muted" title={uploadError.fileName}>
                {uploadError.fileName}
              </p>
              <p className="mt-2 text-body-sm text-danger">{uploadError.message}</p>
              {uploadError.type === UPLOAD_ERROR_TYPES.QUOTA_EXCEEDED && (
                <p className="mt-2 text-caption text-fg-subtle">
                  Tip: Delete some files or upgrade your storage plan.
                </p>
              )}
              {uploadError.type === UPLOAD_ERROR_TYPES.RATE_LIMITED && (
                <p className="mt-2 text-caption text-fg-subtle">
                  Tip: Wait a few seconds before retrying.
                </p>
              )}
            </div>
            <button
              onClick={() => setUploadError(null)}
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
        onConfirm={onLock}
      />
    </div>
  );
};

export default ZKDashboard;
