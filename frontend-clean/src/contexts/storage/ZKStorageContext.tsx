/**
 * ZK Storage Context - Zero-Knowledge Mode
 *
 * Pure ZK implementation with client-side encryption.
 * Uses dedicated services: zkUploadService, zkStorageService, zkAuthService
 */

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useAuth } from '../AuthContext';
import * as zkAuthService from '../../services/zkAuthService';
import * as zkEncryptionService from '../../services/zkEncryptionService';
import { zkUploadService } from '../../services/zkUploadService';
import { zkStorageService } from '../../services/zkStorageService';
import { websocketService } from '../../services/websocketService';
import { requestCache } from '../../utils/requestCache';
import { getMigrationStats, needsMigration } from '../../utils/zkMigration';
import { UploadError, cancelUpload as zkCancelUpload } from '../../services/zkAuthService';
import { terminateEncryptWorkerPool } from '../../workers/zkEncryptWorkerPool';
import { terminateWorkerPool as terminateDecryptWorkerPool } from '../../workers/zkCryptoWorkerPool';
import type {
  FileItem,
  FolderItem,
  StorageStats,
  DedupStats,
  UploadProgress,
  MigrationStats,
  MigrationProgress,
  MigrationResult,
  BulkDeleteResult,
  StorageContextValue,
} from './types';

const ZKStorageContext = createContext<StorageContextValue | undefined>(undefined);

export const useZKStorage = (): StorageContextValue => {
  const context = useContext(ZKStorageContext);
  if (!context) {
    throw new Error('useZKStorage must be used within ZKStorageProvider');
  }
  return context;
};

interface ZKStorageProviderProps {
  children: React.ReactNode;
}

export const ZKStorageProvider: React.FC<ZKStorageProviderProps> = ({ children }) => {
  // Get auth state directly - will update when auth completes
  const { isAuthenticated, zkSessionUnlocked } = useAuth();

  // State
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [currentFolderName, setCurrentFolderName] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [dedupStats] = useState<DedupStats | null>(null); // ZK doesn't support dedup
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Migration state (ZK-specific)
  const [migrationStats, setMigrationStats] = useState<MigrationStats | null>(null);
  const [migrationInProgress, setMigrationInProgress] = useState<boolean>(false);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress>({
    current: 0,
    total: 0,
    currentFile: null,
  });

  const isRefreshingRef = useRef<boolean>(false);

  // Ref to track latest files for use in async callbacks (avoids stale closure)
  const filesRef = useRef<FileItem[]>(files);
  useEffect(() => { filesRef.current = files; }, [files]);

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

  // ✅ WebSocket listeners for real-time updates (ZK-specific events with incremental updates)
  useEffect(() => {
    if (!isAuthenticated) return;

    console.log('[ZK Storage] Setting up WebSocket listeners for ZK events');

    // Initialize WebSocket connection
    websocketService.connect();

    // ✅ Incremental update: Add new file to list (no full reload)
    const handleFileUploaded = (data: any): void => {
      console.log('[ZK WebSocket] File uploaded:', data);
      if (data?.file) {
        setFiles((prev) => {
          // Avoid duplicates
          if (prev.some(f => f.id === data.file.id)) {
            return prev;
          }
          return [...prev, data.file];
        });
        void loadStorageStats(); // Update storage stats
      }
    };

    // ✅ Incremental update: Remove file from list (no full reload)
    const handleFileDeleted = (data: any): void => {
      console.log('[ZK WebSocket] File deleted:', data.fileId);
      if (data?.fileId) {
        setFiles((prev) => prev.filter((f) => f.id !== data.fileId));
        void loadStorageStats(); // Update storage stats
      }
    };

    // ✅ Incremental update: Update file in list
    const handleFileUpdated = (data: any): void => {
      console.log('[ZK WebSocket] File updated:', data);
      if (data?.file) {
        setFiles((prev) =>
          prev.map((f) => (f.id === data.file.id ? data.file : f))
        );
      }
    };

    // ✅ Incremental update: Add new folder
    const handleFolderCreated = (data: any): void => {
      console.log('[ZK WebSocket] Folder created:', data);
      if (data?.folder) {
        setFolders((prev) => {
          // Avoid duplicates
          if (prev.some(f => f.id === data.folder.id)) {
            return prev;
          }
          return [...prev, data.folder];
        });
      }
    };

    // Register ZK-specific event listeners
    const unsubFileUploaded = websocketService.on('zk:file:uploaded', handleFileUploaded);
    const unsubFileDeleted = websocketService.on('zk:file:deleted', handleFileDeleted);
    const unsubFileUpdated = websocketService.on('zk:file:updated', handleFileUpdated);
    const unsubFolderCreated = websocketService.on('zk:folder:created', handleFolderCreated);

    return () => {
      // Cleanup listeners
      unsubFileUploaded();
      unsubFileDeleted();
      unsubFileUpdated();
      unsubFolderCreated();
      websocketService.disconnect();
    };
  }, [isAuthenticated]);

  // Auto-load files when authenticated and session unlocked
  useEffect(() => {
    if (isAuthenticated && zkSessionUnlocked) {
      // Load files first, then update migration stats (which depends on files state)
      void (async () => {
        await loadFiles();
        await updateMigrationStats();
      })();
    }
  }, [isAuthenticated, zkSessionUnlocked, currentFolder]);

  // ✅ Worker pool cleanup on unmount
  useEffect(() => {
    return () => {
      // Terminate worker pools when component unmounts
      console.log('[ZK Storage] Cleaning up worker pools...');
      try {
        terminateEncryptWorkerPool();
        terminateDecryptWorkerPool();
      } catch (error) {
        console.error('[ZK Storage] Error terminating worker pools:', error);
      }
    };
  }, []);

  // ==================== FILE LOADING ====================

  const loadFiles = async (_folderId: string | null = currentFolder): Promise<void> => {
    console.log('[ZK] Loading ZK files...');

    try {
      // ZK API: List files
      const zkFilesResponse = await zkAuthService.listFiles({ limit: 500 });
      console.log('[ZK] Files response:', zkFilesResponse);

      const zkFiles = zkFilesResponse.files || [];

      // Decrypt filenames and convert FileMetadata to FileItem
      const decryptedFiles = zkFiles.map((metadata) => {
        try {
          const file: FileItem = {
            id: metadata.file_id,
            name: '', // Will be decrypted below
            size: metadata.file_size,
            mime_type: metadata.mime_type,
            created_at: metadata.created_at,
            updated_at: metadata.created_at,
            is_encrypted: true,
            encryption_version: metadata.encryption_version,
            encrypted_file_key: metadata.encrypted_file_key,
            file_key_iv: metadata.file_key_iv,
            encrypted_file_name: metadata.encrypted_file_name,
            file_name_iv: metadata.file_name_iv,
            chunk_size: metadata.chunk_size,
          };

          if (metadata.encrypted_file_name && metadata.file_name_iv) {
            const decryptedName = zkEncryptionService.decryptFilenameSafe(
              metadata.encrypted_file_name,
              metadata.file_name_iv,
              `Encrypted File ${metadata.file_id.slice(0, 8)}`
            );
            file.name = decryptedName;
          } else {
            file.name = `Encrypted File ${metadata.file_id.slice(0, 8)}`;
          }

          return file;
        } catch (error) {
          console.warn(`[ZK] Failed to decrypt filename for ${metadata.file_id}:`, error);
          return {
            id: metadata.file_id,
            name: `Encrypted File ${metadata.file_id.slice(0, 8)}`,
            size: metadata.file_size,
            mime_type: metadata.mime_type,
            created_at: metadata.created_at,
            updated_at: metadata.created_at,
            is_encrypted: true,
            encryption_version: metadata.encryption_version,
          };
        }
      });

      setFiles(decryptedFiles);
      setFolders([]); // ZK mode: No folder support yet

      // Load storage stats
      await loadStorageStats();
    } catch (error) {
      console.error('[ZK] Failed to load files:', error);
      setFiles([]);
      setFolders([]);
    }
  };

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
          console.error('[ZK] Refresh failed after 3 attempts:', error);
          isRefreshingRef.current = false;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }
  };

  const loadStorageStats = async (): Promise<void> => {
    try {
      const zkUsage = await zkAuthService.getStorageUsage();
      const usedBytes = zkUsage?.storage_used || 0;
      const quotaBytes = zkUsage?.storage_quota || 100 * 1024 * 1024 * 1024; // Default 100GB

      setStorageStats({
        used: usedBytes,
        total: quotaBytes,
        quota: quotaBytes,
        available: Math.max(0, quotaBytes - usedBytes),
        files_count: filesRef.current.length,
        percentage_used: quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0,
      });
    } catch (error) {
      console.error('[ZK] Failed to load storage stats:', error);
    }
  };

  const loadDedupStats = async (): Promise<void> => {
    // ZK doesn't support deduplication - return zeros
    // Dedup stats remain null (already initialized)
  };

  const loadOfflineData = async (): Promise<void> => {
    // ZK mode: Not yet implemented
    console.warn('[ZK] Offline data not supported in ZK mode');
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      loadFiles(),
      loadStorageStats(),
      loadDedupStats(),
    ]);
  };

  // ==================== FILE UPLOAD (ZK) ====================
  // Delegated to zkUploadService for clean separation

  const uploadFile = async (
    file: File,
    onProgress?: (progress: UploadProgress) => void,
    _signal?: AbortSignal
  ): Promise<{ success: boolean; fileId?: string; encrypted?: boolean }> => {
    console.log('[ZK] Starting ZK encrypted upload via zkUploadService:', file.name);

    try {
      // Use the dedicated ZK upload service
      const result = await zkUploadService.uploadFile(file, {
        folderId: currentFolder,
        generateThumbnail: true,
        onProgress: (progressData) => {
          if (onProgress) {
            const uploadProgress: UploadProgress = {
              progress: progressData.progress,
              bytesUploaded: progressData.bytesUploaded,
              totalBytes: progressData.totalBytes,
              status: 'uploading' as const,
            };

            // Only set optional properties if they exist
            const extendedData = progressData as { uploadId?: string; chunk?: number; totalChunks?: number };
            if (extendedData.uploadId) {
              uploadProgress.uploadId = extendedData.uploadId;
            }
            if (extendedData.chunk !== undefined) {
              uploadProgress.chunksUploaded = extendedData.chunk;
            }
            if (extendedData.totalChunks !== undefined) {
              uploadProgress.totalChunks = extendedData.totalChunks;
            }

            onProgress(uploadProgress);
          }
        },
        onError: (error) => {
          console.error('[ZK] Upload error:', error);
        },
      });

      // Clear cache and refresh
      requestCache.invalidate(/^files-/);
      requestCache.invalidate(/^folders-/);
      await loadFiles();
      await loadStorageStats();
      await updateMigrationStats();

      return { success: true, fileId: result.file_id, encrypted: true };
    } catch (error) {
      console.error('[ZK] Upload failed:', error);

      if (error instanceof UploadError && error.details.uploadId) {
        await zkCancelUpload(error.details.uploadId as string);
      }

      throw error;
    }
  };

  // ==================== FILE DOWNLOAD (ZK) ====================
  // Delegated to zkStorageService for clean separation

  const downloadFile = async (
    fileId: string,
    fileName: string,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<void> => {
    console.log('[ZK] Downloading ZK file via zkStorageService:', fileName);

    const file = files.find((f) => f.id === fileId);
    if (!file) {
      throw new Error('File not found');
    }

    if (!file.encrypted_file_key || !file.file_key_iv) {
      throw new Error('Missing encryption keys for ZK file');
    }

    const metadata = {
      file_size: file.size,
      encrypted_file_key: file.encrypted_file_key,
      file_key_iv: file.file_key_iv,
      mime_type: file.mime_type,
      chunk_size: file.chunk_size || 32 * 1024 * 1024, // 32MB default
    };

    // Use streaming for large files (≥50MB)
    if (file.size >= 50 * 1024 * 1024) {
      await zkStorageService.downloadZKFileStreaming(fileId, fileName, metadata, onProgress);
    } else {
      await zkStorageService.downloadZKFile(fileId, fileName, metadata, onProgress);
    }
  };

  // ==================== FILE DELETE (ZK) ====================

  const deleteFile = async (fileId: string, fileName?: string): Promise<void> => {
    console.log('[ZK] Deleting ZK file:', fileName || fileId);

    try {
      await zkAuthService.deleteFile(fileId);

      // Clear cache and refresh
      requestCache.invalidate(/^files-/);
      await loadFiles();
      await loadStorageStats();
      await updateMigrationStats();

      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    } catch (error) {
      console.error('[ZK] Delete failed:', error);
      throw error;
    }
  };

  // ==================== TRASH OPERATIONS (ZK) ====================

  const getTrash = async (): Promise<FileItem[]> => {
    const response = await zkAuthService.getTrash();
    const zkFiles = response.files || [];

    return zkFiles.map((metadata) => {
      try {
        const decryptedName = metadata.encrypted_file_name && metadata.file_name_iv
          ? zkEncryptionService.decryptFilenameSafe(
              metadata.encrypted_file_name,
              metadata.file_name_iv,
              `Encrypted File ${metadata.file_id.slice(0, 8)}`
            )
          : `Encrypted File ${metadata.file_id.slice(0, 8)}`;

        return {
          id: metadata.file_id,
          name: decryptedName,
          size: metadata.file_size,
          mime_type: metadata.mime_type,
          created_at: metadata.created_at,
          updated_at: metadata.created_at,
          is_encrypted: true,
          encryption_version: metadata.encryption_version,
          encrypted_file_key: metadata.encrypted_file_key,
          file_key_iv: metadata.file_key_iv,
          encrypted_file_name: metadata.encrypted_file_name,
          file_name_iv: metadata.file_name_iv,
          chunk_size: metadata.chunk_size,
        };
      } catch (error) {
        console.error('[ZK Trash] Failed to decrypt filename:', error);
        return {
          id: metadata.file_id,
          name: '[Encrypted File]',
          size: metadata.file_size || 0,
          mime_type: metadata.mime_type || 'application/octet-stream',
          created_at: metadata.created_at,
          updated_at: metadata.created_at,
          is_encrypted: true,
        };
      }
    });
  };

  const restoreFromTrash = async (fileId: string): Promise<void> => {
    await zkAuthService.restoreFromTrash(fileId);
    await loadFiles();
    await loadStorageStats();
  };

  const permanentDeleteFile = async (fileId: string): Promise<void> => {
    await zkAuthService.permanentDelete(fileId);
  };

  const emptyTrashAll = async (): Promise<void> => {
    await zkAuthService.emptyTrash();
  };

  // ==================== NOT SUPPORTED IN ZK MODE ====================

  const createFolder = async (): Promise<void> => {
    throw new Error('Folders not yet supported in ZK mode');
  };

  const createShareLink = async (): Promise<{ share_link: string; expires_at?: string }> => {
    throw new Error('Sharing not supported in ZK mode (encryption prevents server-side sharing)');
  };

  const bulkDelete = async (
    fileIds: string[],
    _options: { force?: boolean } = {},
  ): Promise<BulkDeleteResult> => {
    let deleted = 0;
    let freedSpace = 0;

    for (const fileId of fileIds) {
      try {
        const file = files.find((f) => f.id === fileId);
        if (file) {
          await deleteFile(fileId);
          deleted++;
          freedSpace += file.size;
        }
      } catch (error) {
        console.error(`[ZK] Failed to delete ${fileId}:`, error);
      }
    }

    return { deleted, freed_space: freedSpace };
  };

  // ==================== MIGRATION (ZK V1→V2) ====================

  const updateMigrationStats = async (): Promise<void> => {
    try {
      const stats = await getMigrationStats(files);
      setMigrationStats(stats as unknown as MigrationStats | null);
    } catch (error) {
      console.error('[ZK] Failed to update migration stats:', error);
      setMigrationStats(null);
    }
  };

  const migrateFile = async (
    fileId: string
  ): Promise<{ success?: boolean; skipped?: boolean; reason?: string; newFileId?: string }> => {
    const file = files.find((f) => f.id === fileId);
    if (!file) {
      return { skipped: true, reason: 'File not found' };
    }

    if (!needsMigration(file)) {
      return { skipped: true, reason: 'Already V2' };
    }

    console.log(`[ZK Migration] Migrating ${file.name}...`);

    try {
      // Download with V1 decryption
      const metadata = {
        file_size: file.size,
        encrypted_file_key: file.encrypted_file_key!,
        file_key_iv: file.file_key_iv!,
        mime_type: file.mime_type,
        chunk_size: file.chunk_size || 32 * 1024 * 1024,
      };

      // TODO: Implement blob-based migration
      // Current downloadZKFile saves to disk, doesn't return blob
      // Need to create a new method that returns the decrypted data
      await zkStorageService.downloadZKFile(fileId, file.name, metadata);

      console.warn('[ZK Migration] Migration not fully implemented - needs blob access');

      return { success: false, skipped: true, reason: 'Migration requires blob access' };
    } catch (error) {
      console.error(`[ZK Migration] Failed to migrate ${file.name}:`, error);
      throw error;
    }
  };

  const migrateAllFiles = async (
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<MigrationResult> => {
    const filesToMigrate = files.filter(needsMigration);
    const total = filesToMigrate.length;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    const errors: Array<{ file: string; error: string }> = [];

    setMigrationInProgress(true);

    for (let i = 0; i < total; i++) {
      const file = filesToMigrate[i];

      // TypeScript null safety check
      if (!file) {
        console.error(`[ZK Migration] File at index ${i} is undefined`);
        failed++;
        continue;
      }

      setMigrationProgress({ current: i + 1, total, currentFile: file.name });

      if (onProgress) {
        onProgress({ current: i + 1, total, currentFile: file.name });
      }

      try {
        const result = await migrateFile(file.id);
        if (result.success) {
          completed++;
        } else if (result.skipped) {
          skipped++;
        }
      } catch (error) {
        failed++;
        errors.push({ file: file.name, error: (error as Error).message });
      }
    }

    setMigrationInProgress(false);
    setMigrationProgress({ current: 0, total: 0, currentFile: null });
    await updateMigrationStats();

    return { completed, failed, skipped, errors };
  };

  const dismissMigrationPrompt = (): void => {
    sessionStorage.setItem('migrationPromptDismissed', 'true');
    setMigrationStats(null);
  };

  const isMigrationPromptDismissed = (): boolean => {
    return sessionStorage.getItem('migrationPromptDismissed') === 'true';
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
    lastSyncedAt: null,

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

    // Migration
    migrationStats,
    migrationInProgress,
    migrationProgress,
    migrateFile,
    migrateAllFiles,
    dismissMigrationPrompt,
    isMigrationPromptDismissed,
    updateMigrationStats,
  };

  return <ZKStorageContext.Provider value={value}>{children}</ZKStorageContext.Provider>;
};

export default ZKStorageContext;
