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
    const unsubStorageUpdate = websocketService.on('storage_updated', handleStorageUpdate);

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
      const statsData = rawStats as StorageStats;

      setFiles(filesArray);
      setFolders(foldersArray);
      setStorageStats(statsData);

      // Cache for offline use
      if (isOnline) {
        await offlineDB.cacheFiles(filesArray);
        await offlineDB.cacheFolders(foldersArray);
        await offlineDB.cacheStats(statsData);
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
      setStorageStats(rawStats as StorageStats);

      // Update file count
      if (storageStats) {
        setStorageStats({ ...storageStats, files_count: filesArray.length });
      }
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

  // ==================== FILE UPLOAD (NORMAL) ====================
  // Delegated to normalUploadService for clean separation

  const uploadFile = async (
    file: File,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<{ success: boolean; fileId?: string; encrypted?: boolean }> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    console.log('[Normal] Starting upload via normalUploadService:', file.name);

    try {
      // Use the dedicated normal upload service
      const result = await normalUploadService.uploadFile(file, {
        folderId: currentFolder,
        onProgress: (progressData) => {
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
        },
        onError: (error) => {
          console.error('[Normal] Upload error:', error);
        },
      });

      // Send WebSocket notification
      if (websocketService.isConnected) {
        websocketService.send({
          type: 'file_uploaded',
          file_id: result.file_id,
          file_name: file.name,
          folder_id: currentFolder,
        });
      }

      // Clear cache and refresh
      requestCache.invalidate(/^files-/);
      requestCache.invalidate(/^folders-/);
      await loadFiles();
      await loadDedupStats();
      await loadStorageStats();

      return { success: true, fileId: result.file_id, encrypted: false };
    } catch (error) {
      console.error('[Normal] Upload failed:', error);
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

  const bulkDelete = async (fileIds: string[]): Promise<BulkDeleteResult> => {
    if (!token) {
      throw new Error('No authentication token available');
    }

    console.log(`[Normal] Bulk deleting ${fileIds.length} files`);

    try {
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

      const result = (await response.json()) as BulkDeleteResult;

      // Clear cache and refresh
      requestCache.invalidate(/^files-/);
      await loadFiles();
      await loadDedupStats();
      await loadStorageStats();

      // Clear selections
      clearSelection();

      return result;
    } catch (error) {
      console.error('[Normal] Bulk delete failed:', error);
      throw error;
    }
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

    // File operations
    uploadFile,
    downloadFile,
    deleteFile,
    createFolder,
    createShareLink,
    bulkDelete,

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
