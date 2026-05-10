/**
 * Normal Storage Context - Standard Mode
 *
 * Standard server-side storage implementation.
 * Uses dedicated services: normalUploadService for uploads, storageService for other operations
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../AuthContext';
import { storageService } from '../../services/storageService';
import { normalUploadService } from '../../services/normalUploadService';
import { normalDownloadService } from '../../services/normalDownloadService';
import { websocketService } from '../../services/websocketService';
import { offlineDB } from '../../utils/offlineStorage';
import { requestCache } from '../../utils/requestCache';
import type {
  FileItem,
  FolderItem,
  StorageStats,
  DedupStats,
  UploadProgress,
  ShareLinkOptions,
  MigrationStats,
  MigrationProgress,
  MigrationResult,
  BulkDeleteResult,
  StorageContextValue,
} from './types';
import { API_URL } from '../../config/constants';
import { TransientUploadError } from '../../utils/uploadErrors';

const NormalStorageContext = createContext<StorageContextValue | undefined>(undefined);

export const useNormalStorage = (): StorageContextValue => {
  const context = useContext(NormalStorageContext);
  if (!context) {
    throw new Error('useNormalStorage must be used within NormalStorageProvider');
  }
  return context;
};

interface NormalStorageProviderProps {
  children: React.ReactNode;
}

export const NormalStorageProvider: React.FC<NormalStorageProviderProps> = ({ children }) => {
  // Get auth state directly - will update when auth completes
  const { isAuthenticated, token, loading: authLoading } = useAuth();

  // State
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [currentFolderName, setCurrentFolderName] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [dedupStats] = useState<DedupStats | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Migration state (not used in normal mode, but required by interface)
  const [migrationStats] = useState<MigrationStats | null>(null);
  const [migrationInProgress] = useState<boolean>(false);
  const [migrationProgress] = useState<MigrationProgress>({
    current: 0,
    total: 0,
    currentFile: null,
  });

  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRefreshingRef = useRef<boolean>(false);

  // Online/offline listeners
  useEffect(() => {
    const handleOnline = (): void => setIsOnline(true);
    const handleOffline = (): void => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Debounced refresh
  const debouncedRefresh = useCallback(() => {
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
    }

    refreshDebounceRef.current = setTimeout(() => {
      if (!isRefreshingRef.current) {
        void refreshFiles();
      }
    }, 500);
  }, []);

  // WebSocket listeners for real-time updates
  useEffect(() => {
    const handleFileUploaded = (): void => {
      debouncedRefresh();
    };

    const handleFileDeleted = (): void => {
      debouncedRefresh();
    };

    const handleStorageUpdate = (): void => {
      void loadStorageStats();
    };

    const unsubFileUploaded = websocketService.on('file_uploaded', handleFileUploaded);
    const unsubFileDeleted = websocketService.on('file_deleted', handleFileDeleted);
    const unsubStorageUpdate = websocketService.on('storage_update', handleStorageUpdate);

    return () => {
      unsubFileUploaded();
      unsubFileDeleted();
      unsubStorageUpdate();
    };
  }, [debouncedRefresh]);

  // ==================== FILE LOADING ====================

  // Load offline data from cache (defined first as loadFiles depends on it)
  const loadOfflineData = useCallback(async (): Promise<void> => {
    try {
      const cachedFiles = await offlineDB.getCachedFiles();
      const cachedFolders = await offlineDB.getCachedFolders();
      const cachedStats = await offlineDB.getCachedStats();

      if (cachedFiles) setFiles(cachedFiles as unknown as FileItem[]);
      if (cachedFolders) setFolders(cachedFolders as unknown as FolderItem[]);
      if (cachedStats) setStorageStats(cachedStats as unknown as StorageStats);

      const syncTime = await offlineDB.getLastSyncedAt();
      if (syncTime) setLastSyncedAt(syncTime);
    } catch (error) {
      console.error('[Normal] Failed to load offline data:', error);
    }
  }, []);

  // Load files from server
  const loadFiles = useCallback(async (folderId: string | null = currentFolder): Promise<void> => {
    if (!token) {
      console.warn('[Normal] No token available for loadFiles');
      return;
    }

    console.log('[Normal] Loading files for folder:', folderId);

    try {
      const [rawFiles, rawFolders, rawStats] = await Promise.all([
        storageService.getFiles(token, folderId),
        storageService.getFolders(token, folderId),
        storageService.getStorageStats(token),
      ]);

      const filesArray = rawFiles as FileItem[];
      const foldersArray = rawFolders as FolderItem[];
      const rawStatsObj = rawStats as Record<string, unknown>;
      // Map backend fields (quota, total_files) to frontend fields (total, files_count)
      const statsData: StorageStats = {
        ...(rawStatsObj as unknown as StorageStats),
        total: (rawStatsObj.quota as number) || 0,
        files_count: (rawStatsObj.total_files as number) || 0,
      };

      setFiles(filesArray);
      setFolders(foldersArray);
      setStorageStats(statsData);

      // Cache for offline use
      if (isOnline) {
        await offlineDB.cacheFiles(filesArray);
        await offlineDB.cacheFolders(foldersArray);
        await offlineDB.cacheStats(statsData);
        await offlineDB.saveSyncTimestamp();
        setLastSyncedAt(new Date().toISOString());
      }
    } catch (error) {
      console.error('[Normal] Failed to load files:', error);

      // Try offline data as fallback
      if (!isOnline) {
        await loadOfflineData();
      }
    }
  }, [token, currentFolder, isOnline, loadOfflineData]);

  // Auto-load files when authenticated (must be after loadFiles/loadOfflineData definitions)
  useEffect(() => {
    // Wait for auth to complete loading
    if (authLoading) {
      return;
    }

    if (isAuthenticated && token) {
      if (isOnline) {
        void loadFiles();
      } else {
        void loadOfflineData();
      }
    }
  }, [authLoading, isAuthenticated, token, currentFolder, isOnline, loadFiles, loadOfflineData]);

  const refreshFiles = async (): Promise<void> => {
    if (isRefreshingRef.current) return;

    isRefreshingRef.current = true;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        await loadFiles();
        isRefreshingRef.current = false;
        return;
      } catch (error) {
        attempts++;
        if (attempts >= maxAttempts) {
          console.error('[Normal] Refresh failed after 3 attempts:', error);
          isRefreshingRef.current = false;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
  };

  const loadStorageStats = async (): Promise<void> => {
    if (!token) return;

    try {
      const [rawStats, rawFiles] = await Promise.all([
        storageService.getStorageStats(token),
        storageService.getFiles(token, currentFolder),
      ]);

      const filesArray = rawFiles as FileItem[];
      const rawStatsObj = rawStats as Record<string, unknown>;
      const mappedStats: StorageStats = {
        ...(rawStatsObj as unknown as StorageStats),
        total: (rawStatsObj.quota as number) || 0,
        files_count: (rawStatsObj.total_files as number) || filesArray.length,
      };
      setStorageStats(mappedStats);
    } catch (error) {
      console.error('[Normal] Failed to load storage stats:', error);
    }
  };

  const loadDedupStats = async (): Promise<void> => {
    if (!token) return;

    try {
      // TODO: Implement getDedupStats in storageService
      // const stats = await storageService.getDedupStats(token);
      // setDedupStats(stats as DedupStats);
      console.log('[Normal] Dedup stats not yet implemented');
    } catch (error) {
      console.error('[Normal] Failed to load dedup stats:', error);
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      loadFiles(),
      loadStorageStats(),
      loadDedupStats(),
    ]);
  };

  // ==================== UPLOAD CHECKPOINT HELPERS ====================
  const CHECKPOINT_PREFIX = 'upload_checkpoint_';
  const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  interface UploadCheckpoint {
    serverUploadId: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    folderId: string | null;
    strategy: string;
    chunkSize: number;
    totalChunks: number;
    savedAt: number;
  }

  const getCheckpointKey = (fileName: string, fileSize: number): string =>
    `${CHECKPOINT_PREFIX}${fileName}_${fileSize}`;

  const saveCheckpoint = (data: UploadCheckpoint): void => {
    try {
      localStorage.setItem(getCheckpointKey(data.fileName, data.fileSize), JSON.stringify(data));
    } catch {
      // localStorage full or unavailable — non-critical
    }
  };

  const loadCheckpoint = (fileName: string, fileSize: number): UploadCheckpoint | null => {
    try {
      const raw = localStorage.getItem(getCheckpointKey(fileName, fileSize));
      if (!raw) return null;
      const checkpoint = JSON.parse(raw) as UploadCheckpoint;
      // Validate age
      if (Date.now() - checkpoint.savedAt > CHECKPOINT_MAX_AGE_MS) {
        localStorage.removeItem(getCheckpointKey(fileName, fileSize));
        return null;
      }
      return checkpoint;
    } catch {
      return null;
    }
  };

  const clearCheckpoint = (fileName: string, fileSize: number): void => {
    try {
      localStorage.removeItem(getCheckpointKey(fileName, fileSize));
    } catch {
      // non-critical
    }
  };

  // ==================== FILE UPLOAD (NORMAL) ====================
  // Delegated to normalUploadService for clean separation

  const uploadFile = async (
    file: File,
    onProgress?: (progress: UploadProgress) => void,
    signal?: AbortSignal
  ): Promise<{ success: boolean; fileId?: string; encrypted?: boolean; serverUploadId?: string }> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    const progressCallback = (progressData: { progress: number; bytesUploaded: number; totalBytes: number; chunksUploaded: number; totalChunks: number }) => {
      if (onProgress) {
        onProgress({
          progress: progressData.progress,
          bytesUploaded: progressData.bytesUploaded,
          totalBytes: progressData.totalBytes,
          chunksUploaded: progressData.chunksUploaded,
          totalChunks: progressData.totalChunks,
          status: 'uploading' as const,
        });
      }
    };

    // Check for existing checkpoint (resume path)
    const checkpoint = loadCheckpoint(file.name, file.size);
    if (checkpoint) {
      console.log('[Normal] Found checkpoint for', file.name, '— checking server session...');
      const serverStatus = await normalUploadService.getServerUploadStatus(checkpoint.serverUploadId);

      if (serverStatus === 'unknown') {
        // Can't reach server to verify session — do NOT start fresh upload
        // (fresh upload would overwrite the checkpoint with a new serverUploadId,
        // abandoning the potentially-resumable session)
        throw new TransientUploadError('Unable to check upload status. Please try again when connected.');
      } else if (serverStatus && serverStatus.missing_chunks.length < serverStatus.total_chunks) {
        // Server session alive with some chunks uploaded — resume
        console.log('[Normal] Resuming upload:', checkpoint.serverUploadId,
          `${serverStatus.uploaded_chunks.length}/${serverStatus.total_chunks} chunks done`);

        try {
          const result = await normalUploadService.resumeUpload(file, checkpoint.serverUploadId, serverStatus, {
            folderId: currentFolder,
            ...(signal ? { signal } : {}),
            onProgress: progressCallback,
            onChunkComplete: (_chunkIndex, uploadedCount, totalChunks) => {
              // Update checkpoint timestamp on each chunk
              saveCheckpoint({ ...checkpoint, savedAt: Date.now() });
              if (onProgress) {
                onProgress({
                  progress: (uploadedCount / totalChunks) * 100,
                  bytesUploaded: uploadedCount * serverStatus.chunk_size,
                  totalBytes: file.size,
                  chunksUploaded: uploadedCount,
                  totalChunks,
                  status: 'uploading' as const,
                });
              }
            },
            onError: (error) => {
              console.error('[Normal] Resume error:', error);
            },
          });

          // Success — clear checkpoint
          clearCheckpoint(file.name, file.size);

          // Optimistic UI: inject file immediately
          const optimisticFile: FileItem = {
            id: result.file_id,
            name: file.name,
            size: file.size,
            mime_type: file.type || 'application/octet-stream',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_encrypted: true,
            folder_id: currentFolder,
          };
          setFiles(prev => [optimisticFile, ...prev]);

          requestCache.invalidate(/^files-/);
          requestCache.invalidate(/^folders-/);
          loadFiles().catch(() => {});

          return { success: true, fileId: result.file_id, encrypted: false, serverUploadId: checkpoint.serverUploadId };
        } catch (error) {
          const isNetwork = error instanceof Error && error.message.includes('Internet connection lost');
          if (isNetwork) {
            // Re-save checkpoint with fresh timestamp and rethrow
            saveCheckpoint({ ...checkpoint, savedAt: Date.now() });
            throw error;
          }
          // Other error during resume — clear checkpoint and fall through to fresh upload
          console.warn('[Normal] Resume failed, starting fresh upload:', error);
          clearCheckpoint(file.name, file.size);
        }
      } else {
        // Server session expired or no chunks uploaded — clear stale checkpoint
        console.log('[Normal] Checkpoint expired or no progress, clearing');
        clearCheckpoint(file.name, file.size);
      }
    }

    // Fresh upload path
    console.log('[Normal] Starting fresh upload via normalUploadService:', file.name);

    let capturedServerUploadId: string | undefined;

    try {
      const result = await normalUploadService.uploadFile(file, {
        folderId: currentFolder,
        ...(signal ? { signal } : {}),
        onProgress: progressCallback,
        onSessionCreated: (uploadId, chunkSize, totalChunks, strategy) => {
          capturedServerUploadId = uploadId;
          // Save initial checkpoint
          if (strategy === 'chunked') {
            saveCheckpoint({
              serverUploadId: uploadId,
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type,
              folderId: currentFolder,
              strategy,
              chunkSize,
              totalChunks,
              savedAt: Date.now(),
            });
          }
        },
        onChunkComplete: (_chunkIndex, _uploadedCount, _totalChunks) => {
          // Update checkpoint timestamp on each chunk
          if (capturedServerUploadId) {
            const existing = loadCheckpoint(file.name, file.size);
            if (existing) {
              saveCheckpoint({ ...existing, savedAt: Date.now() });
            }
          }
        },
        onError: (error) => {
          console.error('[Normal] Upload error:', error);
        },
      });

      // Success — clear checkpoint
      clearCheckpoint(file.name, file.size);

      // Optimistic UI: inject the new file into state immediately so the
      // dashboard shows it without waiting for a server round-trip.
      const optimisticFile: FileItem = {
        id: result.file_id,
        name: file.name,
        size: file.size,
        mime_type: file.type || 'application/octet-stream',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_encrypted: true,
        folder_id: currentFolder,
      };
      setFiles(prev => [optimisticFile, ...prev]);

      // Background refresh: reconcile optimistic state with server truth
      requestCache.invalidate(/^files-/);
      requestCache.invalidate(/^folders-/);
      loadFiles().catch(() => {});

      const uploadResult: { success: boolean; fileId: string; encrypted: boolean; serverUploadId?: string } = { success: true, fileId: result.file_id, encrypted: false };
      if (capturedServerUploadId) {
        uploadResult.serverUploadId = capturedServerUploadId;
      }
      return uploadResult;
    } catch (error) {
      console.error('[Normal] Upload failed:', error);
      const isNetwork = error instanceof Error && error.message.includes('Internet connection lost');
      const isTransient = error instanceof TransientUploadError;
      if (!isNetwork && !isTransient) {
        // Server session was destroyed for cancels and non-network errors.
        // Clear checkpoint so resume notification doesn't falsely fire.
        clearCheckpoint(file.name, file.size);
      }
      // Network + transient errors: keep checkpoint for future resume
      throw error;
    }
  };

  // ==================== FILE DOWNLOAD (NORMAL) ====================
  // Delegated to normalDownloadService for clean separation

  const downloadFile = async (
    fileId: string,
    fileName: string,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<void> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    console.log('[Normal] Downloading file via normalDownloadService:', fileName);

    try {
      // Use the dedicated normal download service
      await normalDownloadService.downloadFile(fileId, fileName, {
        onProgress: onProgress ? (progress) => {
          onProgress({
            bytesDownloaded: progress.bytesDownloaded,
            totalBytes: progress.totalBytes,
            progress: progress.progress,
            status: 'downloading',
          });
        } : null,
      });
    } catch (error) {
      console.error('[Normal] Download failed:', error);
      throw error;
    }
  };

  // ==================== FILE DELETE (NORMAL) ====================

  const deleteFile = async (fileId: string, fileName?: string): Promise<void> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    console.log('[Normal] Deleting file:', fileName || fileId);

    try {
      await storageService.deleteFile(token, fileId);

      // Send WebSocket notification
      if (websocketService.isConnected) {
        websocketService.send({
          type: 'file_deleted',
          file_id: fileId,
          folder_id: currentFolder,
        });
      }

      // Clear cache and refresh
      requestCache.invalidate(/^files-/);
      await loadFiles();
      await loadDedupStats();
      await loadStorageStats();

      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    } catch (error) {
      console.error('[Normal] Delete failed:', error);
      throw error;
    }
  };

  // ==================== FOLDER OPERATIONS ====================

  const createFolder = async (name: string): Promise<void> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    console.log('[Normal] Creating folder:', name);

    try {
      await storageService.createFolder(token, name, currentFolder);

      // Clear cache and refresh
      requestCache.invalidate(/^folders-/);
      await loadFiles();
    } catch (error) {
      console.error('[Normal] Create folder failed:', error);
      throw error;
    }
  };

  // ==================== SHARING ====================

  const createShareLink = async (
    fileId: string,
    options?: ShareLinkOptions
  ): Promise<{ share_link: string; expires_at?: string }> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    console.log('[Normal] Creating share link for file:', fileId);

    try {
      const result = await storageService.createShareLink(token, fileId, options);
      return result as { share_link: string; expires_at?: string };
    } catch (error) {
      console.error('[Normal] Create share link failed:', error);
      throw error;
    }
  };

  // ==================== BULK OPERATIONS ====================

  const bulkDelete = async (
    ids: string[],
    options: { force?: boolean } = {},
  ): Promise<BulkDeleteResult> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    // Selection holds a mixed set of file and folder ids; backend has separate
    // endpoints for each. Classify against current folder state.
    const folderIdSet = new Set(folders.map((f) => f.id));
    const folderIds = ids.filter((id) => folderIdSet.has(id));
    const fileIds = ids.filter((id) => !folderIdSet.has(id));

    console.log(
      `[Normal] Bulk deleting ${fileIds.length} files, ${folderIds.length} folders`,
    );

    try {
      let result: BulkDeleteResult = { deleted: 0, freed_space: 0 };

      if (fileIds.length > 0) {
        const response = await fetch(`${API_URL}/api/v1/files/bulk-delete`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ file_ids: fileIds }),
        });
        if (!response.ok) {
          throw new Error(`Bulk delete failed: ${response.statusText}`);
        }
        result = (await response.json()) as BulkDeleteResult;
      }

      // Folders: no bulk endpoint, delete one at a time. force=true cascades
      // through subfolders + soft-deletes files (matches bulk-delete-to-trash).
      const folderFailures: string[] = [];
      const forceQuery = options.force ? '?force=true' : '';
      for (const folderId of folderIds) {
        const response = await fetch(
          `${API_URL}/api/v1/folders/${folderId}${forceQuery}`,
          { method: 'DELETE', credentials: 'include' },
        );
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          folderFailures.push(err.detail || `Failed to delete folder ${folderId}`);
        } else {
          result.deleted += 1;
        }
      }

      requestCache.invalidate(/^files-/);
      requestCache.invalidate(/^folders-/);
      await loadFiles();
      await loadDedupStats();
      await loadStorageStats();
      clearSelection();

      if (folderFailures.length > 0) {
        throw new Error(folderFailures.join('; '));
      }

      return result;
    } catch (error) {
      console.error('[Normal] Bulk delete failed:', error);
      throw error;
    }
  };

  // ==================== TRASH OPERATIONS (NORMAL) ====================

  const getTrash = async (): Promise<FileItem[]> => {
    const data = await storageService.getTrash();
    return data as FileItem[];
  };

  const restoreFromTrash = async (fileId: string): Promise<void> => {
    await storageService.restoreFromTrash(fileId);
    requestCache.invalidate(/^files-/);
    requestCache.invalidate(/^folders-/);
    await loadFiles();
    await loadStorageStats();
  };

  const permanentDeleteFile = async (fileId: string): Promise<void> => {
    await storageService.permanentDelete(fileId);
  };

  const emptyTrashAll = async (): Promise<void> => {
    await storageService.emptyTrash();
  };

  // ==================== MIGRATION (NOT SUPPORTED) ====================

  const updateMigrationStats = async (): Promise<void> => {
    // Migration not applicable in normal mode
  };

  const migrateFile = async (): Promise<{ success?: boolean; skipped?: boolean; reason?: string; newFileId?: string }> => {
    return { skipped: true, reason: 'Migration not applicable in normal mode' };
  };

  const migrateAllFiles = async (): Promise<MigrationResult> => {
    return { completed: 0, failed: 0, skipped: 0 };
  };

  const dismissMigrationPrompt = (): void => {
    // No-op in normal mode
  };

  const isMigrationPromptDismissed = (): boolean => {
    return true; // Always dismissed in normal mode
  };

  // ==================== SELECTION ====================

  const selectFile = (fileId: string, index: number, ctrlKey: boolean, shiftKey: boolean): void => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);

      if (shiftKey && lastClickedIndex !== null) {
        // Range selection
        const allItems = getAllItems();
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);

        for (let i = start; i <= end; i++) {
          const item = allItems[i];
          if (item && 'mime_type' in item) {
            next.add(item.id);
          }
        }
      } else if (ctrlKey) {
        // Toggle selection
        if (next.has(fileId)) {
          next.delete(fileId);
        } else {
          next.add(fileId);
        }
      } else {
        // Single selection
        next.clear();
        next.add(fileId);
      }

      setLastClickedIndex(index);
      return next;
    });
  };

  const selectAll = (): void => {
    setSelectedFiles(new Set(files.map((f) => f.id)));
  };

  const clearSelection = (): void => {
    setSelectedFiles(new Set());
    setLastClickedIndex(null);
  };

  // ==================== NAVIGATION ====================

  const navigateToFolder = (folderId: string | null, folderName?: string): void => {
    setCurrentFolder(folderId);
    setCurrentFolderName(folderName || null);
    clearSelection();
  };

  // ==================== UTILITY ====================

  const getAllItems = (): Array<FileItem | FolderItem> => {
    return [...folders, ...files];
  };

  // ==================== PROVIDER ====================

  const value: StorageContextValue = {
    files,
    folders,
    currentFolder,
    currentFolderName,
    storageStats,
    dedupStats,
    selectedFiles,
    lastClickedIndex,
    isOnline,
    lastSyncedAt,

    // File operations
    uploadFile,
    downloadFile,
    deleteFile,
    createFolder,
    createShareLink,
    bulkDelete,

    // Trash operations
    getTrash,
    restoreFromTrash,
    permanentDelete: permanentDeleteFile,
    emptyTrash: emptyTrashAll,

    // Data loading
    loadFiles,
    loadStorageStats,
    loadDedupStats,
    loadOfflineData,
    refreshFiles,
    refreshAll,

    // Selection
    selectFile,
    selectAll,
    clearSelection,

    // Navigation
    navigateToFolder,
    getAllItems,

    // Migration (no-ops in normal mode)
    migrationStats,
    migrationInProgress,
    migrationProgress,
    migrateFile,
    migrateAllFiles,
    dismissMigrationPrompt,
    isMigrationPromptDismissed,
    updateMigrationStats,
  };

  return <NormalStorageContext.Provider value={value}>{children}</NormalStorageContext.Provider>;
};

export default NormalStorageContext;
