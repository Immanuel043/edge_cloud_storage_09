import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { storageService } from '../services/storageService';
import { websocketService } from '../services/websocketService';
import { useAuth } from './AuthContext';
import { offlineDB } from '../utils/offlineStorage';
import { requestCache } from '../utils/requestCache';
import { encryptFile, isZKSessionUnlocked, encryptFilename, decryptFilenameSafe } from '../services/zkEncryptionService';
import * as zkAuthService from '../services/zkAuthService';
import { UploadError, cancelUpload as zkCancelUpload, type FileMetadata } from '../services/zkAuthService';
import { bytesToBase64 } from '../utils/zkCrypto';
import { getMigrationStats, needsMigration, formatMigrationStats, type MigrationStats as ImportedMigrationStats } from '../utils/zkMigration';
import { getFileService } from '../services/fileServiceRouter';
import { generateEncryptedThumbnail, supportsThumbnail } from '../utils/zkThumbnails';

const API_URL = import.meta.env.VITE_API_URL;

interface FileItem {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  created_at: string;
  updated_at: string;
  is_encrypted?: boolean;
  encryption_mode?: string;
  encryption_version?: number;
  encrypted_file_key?: string;
  file_key_iv?: string;
  folder_id?: string | null;
  encrypted_file_name?: string;
  file_name_iv?: string;
  [key: string]: unknown;
}

interface FolderItem {
  id: string;
  name: string;
  created_at: string;
  parent_id?: string | null;
  [key: string]: unknown;
}

interface StorageStats {
  used: number;
  total: number;
  quota: number;
  available: number;
  files_count: number;
  percentage_used: number;
  [key: string]: unknown;
}

interface DedupStats {
  logical_size: number;
  physical_size: number;
  saved_size: number;
  savings_percentage: number;
  storage_efficiency: number;
}

interface UploadProgress {
  progress: number;
  status: string;
  uploadId: string | null;
  chunk?: number;
  totalChunks?: number;
}

interface ShareLinkOptions {
  expires_in?: number;
  max_downloads?: number;
  password?: string;
}

type MigrationStats = ImportedMigrationStats;

interface MigrationProgress {
  current: number;
  total: number;
  currentFile: string | null;
}

interface MigrationResult {
  completed: number;
  failed: number;
  skipped: number;
  errors?: Array<{ file: string; error: string }>;
}

interface BulkDeleteResult {
  deleted: number;
  freed_space: number;
}

interface StorageContextValue {
  files: FileItem[];
  folders: FolderItem[];
  currentFolder: string | null;
  currentFolderName: string | null;
  storageStats: StorageStats | null;
  isOnline: boolean;
  selectedFiles: Set<string>;
  dedupStats: DedupStats | null;
  loadDedupStats: () => Promise<void>;
  uploadFile: (file: File, onProgress?: (progress: UploadProgress) => void) => Promise<{ success: boolean; fileId?: string; encrypted?: boolean }>;
  downloadFile: (fileId: string, fileName: string, onProgress?: (progress: UploadProgress) => void) => Promise<unknown>;
  deleteFile: (fileId: string, fileName?: string | null) => Promise<unknown>;
  bulkDelete: (fileIds: string[]) => Promise<BulkDeleteResult>;
  createFolder: (name: string) => Promise<void>;
  createShareLink: (fileId: string, options?: ShareLinkOptions) => Promise<unknown>;
  navigateToFolder: (folderId: string | null, folderName?: string | null) => void;
  selectFile: (fileId: string, index?: number | null, shiftKey?: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;
  getAllItems: () => Array<FileItem | FolderItem>;
  refreshFiles: (folderId?: string | null) => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshAll: () => Promise<void>;
  // Migration
  migrationStats: MigrationStats | null;
  migrationInProgress: boolean;
  migrationProgress: MigrationProgress;
  migrateFile: (fileId: string) => Promise<{ skipped?: boolean; reason?: string; success?: boolean; newFileId?: string }>;
  migrateAllFiles: (onProgress?: (current: number, total: number, fileName: string) => void) => Promise<MigrationResult>;
  dismissMigrationPrompt: () => void;
  isMigrationPromptDismissed: () => boolean;
  formatMigrationStats: typeof formatMigrationStats;
}

interface StorageProviderProps {
  children: React.ReactNode;
}

const StorageContext = createContext<StorageContextValue | undefined>(undefined);

export const useStorage = (): StorageContextValue => {
  const context = useContext(StorageContext);
  if (!context) {
    throw new Error('useStorage must be used within StorageProvider');
  }
  return context;
};

export const StorageProvider: React.FC<StorageProviderProps> = ({ children }) => {
  const { token, isAuthenticated, zkEnabled, zkSessionUnlocked } = useAuth();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [currentFolderName, setCurrentFolderName] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [dedupStats, setDedupStats] = useState<DedupStats | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Migration state
  const [migrationStats, setMigrationStats] = useState<MigrationStats | null>(null);
  const [migrationInProgress, setMigrationInProgress] = useState<boolean>(false);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress>({ current: 0, total: 0, currentFile: null });

  // Debounce ref for refreshFiles to prevent flickering
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRefreshingRef = useRef<boolean>(false);

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

  // Debounced refresh function to prevent flickering
  const debouncedRefresh = useCallback(() => {
    // Clear any pending refresh
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
    }
    // Don't queue another refresh if one is in progress
    if (isRefreshingRef.current) {
      return;
    }
    // Debounce by 500ms to batch multiple events
    refreshDebounceRef.current = setTimeout(() => {
      isRefreshingRef.current = true;
      refreshFiles().finally(() => {
        isRefreshingRef.current = false;
      });
    }, 500);
  }, []);

  // Also add a WebSocket listener for file_uploaded events
  useEffect(() => {
    if (!websocketService || !isAuthenticated) return;

    // Listen for file upload events from WebSocket
    const handleFileUploaded = (data: unknown): void => {
      console.log('WebSocket: file uploaded event', data);
      // Use debounced refresh to prevent flickering
      debouncedRefresh();
    };

    const unsubscribe = websocketService.on('file_uploaded', handleFileUploaded);

    return () => {
      if (unsubscribe) unsubscribe();
      // Clear debounce on cleanup
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
    };
  }, [isAuthenticated, debouncedRefresh]);

  useEffect(() => {
    if (isAuthenticated) {
      if (isOnline) {
        // Only load files when:
        // 1. Not ZK user, OR
        // 2. ZK user with unlocked session
        const shouldLoad = !zkEnabled || zkSessionUnlocked;
        if (shouldLoad) {
          loadFiles();
          loadStorageStats();
          loadDedupStats();
        }
      } else {
        loadOfflineData();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentFolder, isOnline, zkEnabled, zkSessionUnlocked]);

  useEffect(() => {
    // WebSocket event listeners - use debounced refresh to prevent flickering
    const handleWSFileUploaded = (event: Event): void => {
      console.log('File uploaded event received:', (event as CustomEvent).detail);
      debouncedRefresh();
    };

    const handleWSFileDeleted = (event: Event): void => {
      console.log('File deleted event received:', (event as CustomEvent).detail);
      debouncedRefresh();
    };

    const handleWSStorageUpdate = (event: Event): void => {
      console.log('Storage update event received:', (event as CustomEvent).detail);
      if ((event as CustomEvent).detail) {
        setStorageStats((event as CustomEvent).detail as StorageStats);
      }
      loadStorageStats();
    };

    // Add WebSocket event listeners
    window.addEventListener('ws-file-uploaded', handleWSFileUploaded);
    window.addEventListener('ws-file-deleted', handleWSFileDeleted);
    window.addEventListener('ws-storage-update', handleWSStorageUpdate);

    // Cleanup
    return () => {
      window.removeEventListener('ws-file-uploaded', handleWSFileUploaded);
      window.removeEventListener('ws-file-deleted', handleWSFileDeleted);
      window.removeEventListener('ws-storage-update', handleWSStorageUpdate);
    };
  }, [token, debouncedRefresh]);

  const loadFiles = async (folderId: string | null = currentFolder): Promise<void> => {
    // Check if we should use ZK service
    const useZKService = zkEnabled && zkSessionUnlocked;

    try {
      let filesData: FileItem[], foldersData: FolderItem[], statsData: StorageStats;

      if (useZKService) {
        // Use ZK service for encrypted files
        try {
          const zkFilesResponse = await zkAuthService.listFiles({ limit: 1000 });
          filesData = (zkFilesResponse.files || zkFilesResponse || []).map((f: any) => {
            // Decrypt filename if encrypted_file_name and file_name_iv are present
            let decryptedName = f.filename || f.file_name || f.name || 'Encrypted File';
            if (f.encrypted_file_name && f.file_name_iv) {
              decryptedName = decryptFilenameSafe(f.encrypted_file_name, f.file_name_iv, 'Encrypted File');
            }
            return {
              id: f.file_id || f.id,
              name: decryptedName,
              size: f.file_size || f.size,
              mime_type: f.mime_type,
              created_at: f.uploaded_at || f.created_at,
              updated_at: f.uploaded_at || f.updated_at,
              is_encrypted: f.is_encrypted !== undefined ? f.is_encrypted : true,
              encryption_mode: 'client_zk',
              encryption_version: f.encryption_version,
              encrypted_file_key: f.encrypted_file_key,
              file_key_iv: f.file_key_iv,
              folder_id: f.folder_id,
              // Store encrypted filename fields for re-encryption if needed
              encrypted_file_name: f.encrypted_file_name,
              file_name_iv: f.file_name_iv,
            };
          });
          // Get storage usage from ZK service
          const zkUsage = await zkAuthService.getStorageUsage().catch(() => null);
          const usedBytes = zkUsage?.storage_used || 0;
          const quotaBytes = zkUsage?.storage_quota || 100 * 1024 * 1024 * 1024; // Default 100GB
          statsData = zkUsage ? {
            used: usedBytes,
            total: quotaBytes,
            quota: quotaBytes, // For StorageStats component
            available: quotaBytes - usedBytes,
            files_count: zkUsage.file_count || filesData.length,
            percentage_used: quotaBytes > 0 ? (usedBytes / quotaBytes * 100) : 0,
          } : { used: 0, total: 100 * 1024 * 1024 * 1024, quota: 100 * 1024 * 1024 * 1024, available: 100 * 1024 * 1024 * 1024, files_count: filesData.length, percentage_used: 0 };
          // For now, folders not implemented for ZK service
          foldersData = [];
        } catch (zkError) {
          console.error('ZK loadFiles failed:', zkError);
          filesData = [];
          foldersData = [];
          statsData = { used: 0, total: 100 * 1024 * 1024 * 1024, quota: 100 * 1024 * 1024 * 1024, available: 100 * 1024 * 1024 * 1024, files_count: 0, percentage_used: 0 };
        }
      } else {
        // Use regular storage service
        const tokenStr = token || '';
        const [rawFiles, rawFolders, rawStats] = await Promise.all([
          storageService.getFiles(tokenStr, folderId || undefined),
          storageService.getFolders(tokenStr, folderId || undefined),
          storageService.getStorageStats(tokenStr)
        ]);
        filesData = rawFiles as FileItem[];
        foldersData = rawFolders as FolderItem[];
        statsData = rawStats as StorageStats;
        // Always set files_count from the actual files array for accuracy
        if (statsData) {
          statsData.files_count = filesData.length;
        }
      }

      setFiles(filesData);
      setFolders(foldersData);
      setStorageStats(statsData);

      // Cache for offline
      if (isOnline) {
        await offlineDB.cacheFiles(filesData);
        await offlineDB.cacheFolders(foldersData);
        await offlineDB.cacheStats(statsData);
      }
    } catch (error) {
      console.error('Failed to load files:', error);
    }
  };

  const loadOfflineData = async (): Promise<void> => {
    const cachedFiles = await offlineDB.getCachedFiles();
    const cachedFolders = await offlineDB.getCachedFolders();
    const cachedStats = await offlineDB.getCachedStats();

    setFiles((cachedFiles as FileItem[]) || []);
    setFolders((cachedFolders as FolderItem[]) || []);
    setStorageStats((cachedStats as StorageStats) || null);
  };

  const loadStorageStats = async (): Promise<void> => {
    // Check if we should use ZK service
    const useZKService = zkEnabled && zkSessionUnlocked;

    try {
      let stats: StorageStats;

      if (useZKService) {
        // Use ZK service for storage usage
        const zkUsage = await zkAuthService.getStorageUsage().catch(() => null);
        const usedBytes = zkUsage?.storage_used || 0;
        const quotaBytes = zkUsage?.storage_quota || 100 * 1024 * 1024 * 1024; // Default 100GB
        stats = zkUsage ? {
          used: usedBytes,
          total: quotaBytes,
          quota: quotaBytes, // For StorageStats component
          available: quotaBytes - usedBytes,
          files_count: zkUsage.file_count || 0,
          percentage_used: quotaBytes > 0 ? (usedBytes / quotaBytes * 100) : 0,
        } : { used: 0, total: 100 * 1024 * 1024 * 1024, quota: 100 * 1024 * 1024 * 1024, available: 100 * 1024 * 1024 * 1024, files_count: 0, percentage_used: 0 };
      } else {
        // Fetch both stats and files count in parallel for accuracy
        const tokenStr = token || '';
        const [rawStats, rawFiles] = await Promise.all([
          storageService.getStorageStats(tokenStr),
          storageService.getFiles(tokenStr, currentFolder || undefined)
        ]);
        stats = rawStats as StorageStats;
        const filesArray = rawFiles as FileItem[];
        // Always set files_count from the actual files fetch for accuracy
        if (stats) {
          stats.files_count = filesArray?.length || 0;
        }
      }

      setStorageStats(stats);

      // Cache for offline
      if (isOnline) {
        await offlineDB.cacheStats(stats);
      }
    } catch (error) {
      console.error('Failed to load storage stats:', error);
    }
  };

  // Deduplication stats
  const loadDedupStats = async (): Promise<void> => {
  if (!isAuthenticated) return;

  // Skip dedup stats for ZK users (ZK service doesn't have deduplication)
  const useZKService = zkEnabled && zkSessionUnlocked;
  if (useZKService) {
    setDedupStats({
      logical_size: 0,
      physical_size: 0,
      saved_size: 0,
      savings_percentage: 0,
      storage_efficiency: 1
    });
    return;
  }

  try {
    const tokenStr = token || '';
    const stats = await storageService.getDedupSavings(tokenStr); // No token needed - uses cookie
    setDedupStats(stats as DedupStats);
  } catch (error) {
    // Silently handle error if dedup endpoints not available yet
    console.log('Deduplication stats not available');
    // Set default values
    setDedupStats({
      logical_size: 0,
      physical_size: 0,
      saved_size: 0,
      savings_percentage: 0,
      storage_efficiency: 1
    });
  }
};

  const refreshFiles = async (folderId: string | null = currentFolder): Promise<void> => {
  const maxRetries = 3;
  let retryCount = 0;

  // Check if we should use ZK service for files
  const useZKService = zkEnabled && zkSessionUnlocked;

  while (retryCount < maxRetries) {
    try {
      console.log(`Refreshing files (attempt ${retryCount + 1})... useZKService: ${useZKService}`);

      // Add a small delay between retries
      if (retryCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
      }

      let filesData: FileItem[], foldersData: FolderItem[];

      if (useZKService) {
        // Use ZK service for encrypted files
        try {
          const zkFilesResponse = await zkAuthService.listFiles({ limit: 1000 });
          // Transform ZK files response to match expected format
          filesData = (zkFilesResponse.files || zkFilesResponse || []).map((f: any) => {
            // Decrypt filename if encrypted_file_name and file_name_iv are present
            let decryptedName = f.filename || f.file_name || f.name || 'Encrypted File';
            if (f.encrypted_file_name && f.file_name_iv) {
              decryptedName = decryptFilenameSafe(f.encrypted_file_name, f.file_name_iv, 'Encrypted File');
            }
            return {
              id: f.file_id || f.id,  // ZK API returns file_id
              name: decryptedName,
              size: f.file_size || f.size,
              mime_type: f.mime_type,
              created_at: f.uploaded_at || f.created_at,  // ZK API returns uploaded_at
              updated_at: f.uploaded_at || f.updated_at,
              is_encrypted: f.is_encrypted !== undefined ? f.is_encrypted : true,
              encryption_mode: 'client_zk',  // Mark as ZK client-side encrypted
              encryption_version: f.encryption_version || 2,  // Default V2 for ZK files
              encrypted_file_key: f.encrypted_file_key,
              file_key_iv: f.file_key_iv,
              folder_id: f.folder_id,
              // Store encrypted filename fields for re-encryption if needed
              encrypted_file_name: f.encrypted_file_name,
              file_name_iv: f.file_name_iv,
            };
          });
          // For now, folders not implemented for ZK service
          foldersData = [];
        } catch (zkError) {
          console.error('ZK listFiles failed:', zkError);
          filesData = [];
          foldersData = [];
        }
      } else {
        // Use regular storage service
        const tokenStr = token || '';
        const [rawFiles, rawFolders] = await Promise.all([
          storageService.getFiles(tokenStr, folderId || undefined),
          storageService.getFolders(tokenStr, folderId || undefined)
        ]);
        filesData = rawFiles as FileItem[];
        foldersData = rawFolders as FolderItem[];
      }

      console.log(`Files loaded: ${filesData.length} files, ${foldersData.length} folders`);

      setFiles(filesData);
      setFolders(foldersData);

      // Also refresh storage stats
      await loadStorageStats();

      // Cache for offline
      if (isOnline) {
        try {
          await offlineDB.cacheFiles(filesData);
          await offlineDB.cacheFolders(foldersData);
        } catch (cacheError) {
          console.warn('Failed to cache files:', cacheError);
        }
      }

      // Success - exit the retry loop
      return;

    } catch (error) {
      retryCount++;
      console.error(`Failed to load files (attempt ${retryCount}):`, error);

      if (retryCount >= maxRetries) {
        console.error('Max retries reached, giving up');
        throw error;
      }
    }
  }
};

  const uploadFile = async (file: File, onProgress?: (progress: UploadProgress) => void): Promise<{ success: boolean; fileId?: string; encrypted?: boolean }> => {
  try {
    // Check if ZK encryption should be used
    console.log('[Storage] Upload check - zkEnabled:', zkEnabled, 'zkSessionUnlocked:', zkSessionUnlocked, 'isZKSessionUnlocked():', isZKSessionUnlocked());
    const useZKEncryption = zkEnabled && zkSessionUnlocked && isZKSessionUnlocked();
    console.log('[Storage] useZKEncryption:', useZKEncryption);

    if (useZKEncryption) {
      console.log('[Storage] Using ZK encrypted upload for:', file.name);

      // Step 1: Encrypt the file client-side
      let encryptionProgress = 0;
      const encryptedData = await encryptFile(file, (bytesEncrypted: number, totalBytes: number) => {
        encryptionProgress = Math.round((bytesEncrypted / totalBytes) * 30); // 0-30% for encryption
        if (onProgress) {
          onProgress({ progress: encryptionProgress, status: 'encrypting', uploadId: null });
        }
      });

      console.log('[Storage] File encrypted, chunks:', encryptedData.totalChunks);

      // Step 2: Encrypt the filename
      console.log('[Storage] Encrypting filename:', file.name);
      const { encryptedFilename: encryptedFileName, filenameIV } = encryptFilename(file.name);
      console.log('[Storage] Filename encrypted successfully');

      // Step 3: Generate encrypted thumbnail if file type is supported
      let thumbnailData = null;
      if (supportsThumbnail(file.type)) {
        try {
          console.log('[Storage] Generating encrypted thumbnail for:', file.name);
          thumbnailData = await generateEncryptedThumbnail(file, encryptedData.fileKey);
          if (thumbnailData) {
            console.log('[Storage] Thumbnail generated:', thumbnailData.width, 'x', thumbnailData.height);
          }
        } catch (thumbError) {
          console.warn('[Storage] Thumbnail generation failed (non-fatal):', (thumbError as Error).message);
        }
      }

      // Step 4: Initialize upload with ZK service (including encrypted filename and thumbnail if available)
      const initResult = await zkAuthService.initializeUpload({
        // Encrypted filename (server stores this directly)
        encryptedFileName: encryptedFileName,
        fileNameIV: filenameIV,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        encryptedFileKey: encryptedData.encryptedFileKey,
        fileKeyIV: encryptedData.fileKeyIV,
        encryptionAlgorithm: 'AES-256-GCM',
        encryptionVersion: 2, // V2 = HKDF+AAD enhanced encryption
        chunkSize: 64 * 1024 * 1024, // 64MB
        parentFolderId: currentFolder,
        // Include encrypted thumbnail data
        encryptedThumbnail: thumbnailData?.encryptedThumbnail || null,
        thumbnailIV: thumbnailData?.iv || null,
        thumbnailWidth: thumbnailData?.width || null,
        thumbnailHeight: thumbnailData?.height || null,
      });

      console.log('[Storage] ZK upload initialized:', initResult);

      // Step 3: Upload encrypted chunks with error handling
      try {
        for (let i = 0; i < encryptedData.encryptedChunks.length; i++) {
          const chunk = encryptedData.encryptedChunks[i];
          if (!chunk) continue;

          // Convert IV to base64 if it's a Uint8Array
          const chunkIV = chunk.iv instanceof Uint8Array ? bytesToBase64(chunk.iv) : chunk.iv;

          await zkAuthService.uploadChunk(
            initResult.upload_id,
            chunk.index,
            chunk.data,
            chunkIV
          );

          // Progress: 30-90% for chunk uploads
          const uploadProgress = 30 + Math.round(((i + 1) / encryptedData.encryptedChunks.length) * 60);
          if (onProgress) {
            onProgress({
              progress: uploadProgress,
              status: 'uploading',
              uploadId: initResult.upload_id,
              chunk: i + 1,
              totalChunks: encryptedData.encryptedChunks.length
            });
          }
        }
      } catch (chunkError) {
        // Clean up the failed upload on the server
        console.error('[Storage] Chunk upload failed, cleaning up:', chunkError);
        try {
          await zkCancelUpload(initResult.upload_id);
          console.log('[Storage] Cleaned up failed upload:', initResult.upload_id);
        } catch (cleanupError) {
          console.warn('[Storage] Failed to clean up upload:', (cleanupError as Error).message);
        }

        // Re-throw with enhanced error info
        if (chunkError instanceof UploadError) {
          // Add file info to the error
          chunkError.details.fileName = file.name;
          chunkError.details.fileSize = file.size;
          throw chunkError;
        }
        throw chunkError;
      }

      // Step 4: Complete upload
      const completeResult = await zkAuthService.completeUpload(
        initResult.upload_id,
        encryptedData.fileHash,
        encryptedData.totalChunks
      );

      console.log('[Storage] ZK upload completed:', completeResult);

      if (onProgress) {
        onProgress({ progress: 100, status: 'completed', uploadId: initResult.upload_id });
      }

      // Refresh files list
      try {
        requestCache.invalidate(/^files-/);
        requestCache.invalidate(/^folders-/);
        await refreshFiles();
        await loadDedupStats();
      } catch (refreshError) {
        console.error('Refresh failed:', refreshError);
      }

      return { success: true, fileId: completeResult.file_id, encrypted: true };
    }

    // Regular (non-ZK) upload
    const tokenStr = token || '';
    const rawResult = await storageService.uploadFile(tokenStr, file, currentFolder, (progress: Record<string, unknown>) => {
      // Call the original progress callback
      const typedProgress = progress as unknown as UploadProgress;
      if (onProgress) {
        onProgress(typedProgress);
      }

      // Send progress via WebSocket only if connected
      // Don't let WebSocket issues affect upload
      try {
        if (websocketService.isConnected && typedProgress.uploadId) {
          websocketService.sendUploadProgress(typedProgress.uploadId, typedProgress.progress);
        }
      } catch (wsError) {
        console.warn('WebSocket progress update failed:', wsError);
      }
    });

    const result = rawResult as { success: boolean; fileId?: string; encrypted?: boolean };

    console.log('Upload completed:', result);

    // Immediately refresh - backend now commits before responding
    try {
      // Invalidate cache to ensure fresh data is fetched
      requestCache.invalidate(/^files-/);
      requestCache.invalidate(/^folders-/);

      await refreshFiles();
      await loadDedupStats();
    } catch (refreshError) {
      console.error('Refresh failed:', refreshError);
    }

    return result;
  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
};

  const downloadFile = async (fileId: string, fileName: string, onProgress?: (progress: any) => void): Promise<unknown> => {
    // Check if this is a ZK-encrypted file
    const file = files.find(f => f.id === fileId);

    if (file && file.is_encrypted) {
      // ZK file - use ZK download with decryption
      const STREAMING_THRESHOLD = 50 * 1024 * 1024; // 50MB - use streaming for larger files

      if (file.size >= STREAMING_THRESHOLD) {
        console.log('[Storage] Downloading large ZK-encrypted file with streaming decryption:', fileName);
        return await storageService.downloadZKFileStreaming(fileId, fileName, {
          file_size: file.size,
          encrypted_file_key: file.encrypted_file_key!,
          file_key_iv: file.file_key_iv!,
          mime_type: file.mime_type,
          chunk_size: 32 * 1024 * 1024  // 32MB chunks
        }, onProgress);
      } else {
        console.log('[Storage] Downloading small ZK-encrypted file (sequential):', fileName);
        return await storageService.downloadZKFile(fileId, fileName, {
          file_size: file.size,
          encrypted_file_key: file.encrypted_file_key!,
          file_key_iv: file.file_key_iv!,
          mime_type: file.mime_type,
          chunk_size: 32 * 1024 * 1024  // 32MB default
        }, onProgress);
      }
    } else {
      // Standard file - use regular download
      const tokenStr = token || '';
      return await storageService.downloadFile(tokenStr, fileId, fileName);
    }
  };

  const deleteFile = async (fileId: string, fileName: string | null = null): Promise<unknown> => {
    try {
      // Find the file to determine which service to use
      const file = files.find(f => f.id === fileId);
      const fileMetadata: FileMetadata = file as any;
      const isZKFile = file && getFileService(fileMetadata) === 'zk';

      let result;
      if (isZKFile) {
        // Use ZK service for client-side encrypted files
        console.log('[Storage] Deleting ZK-encrypted file:', fileId, fileName || '');
        result = await zkAuthService.deleteFile(fileId);
      } else {
        // Use regular storage service
        const tokenStr = token || '';
        result = await storageService.deleteFile(tokenStr, fileId);
      }

      // Invalidate cache to ensure fresh data is fetched
      requestCache.invalidate(/^files-/);
      requestCache.invalidate(/^folders-/);

      // After successful deletion, refresh everything
      await refreshFiles();
      await loadDedupStats(); // Refresh dedup stats after deletion
      await loadStorageStats();

      // Clear selection if the deleted file was selected
      setSelectedFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(fileId);
        return newSet;
      });

      return result;
    } catch (error) {
      console.error('Failed to delete file:', error);
      throw error;
    }
  };

  const bulkDelete = async (fileIds: string[]): Promise<BulkDeleteResult> => {
  if (!fileIds || fileIds.length === 0) {
    console.error('No files selected for deletion');
    return { deleted: 0, freed_space: 0 };
  }

  try {
    console.log('Bulk deleting files:', fileIds);

    const url = `${API_URL}/api/v1/files/bulk-delete`;
    console.log('Bulk delete URL:', url);

    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',  // Send HTTP-only cookie
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file_ids: fileIds })
    });

    if (!response.ok) {
      let errorMessage = `Bulk delete failed: ${response.status}`;
      try {
        const errorData = await response.text();
        errorMessage += ` - ${errorData}`;
      } catch (e) {
        // Ignore error reading response
      }
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    const result = await response.json() as BulkDeleteResult;
    console.log('Bulk delete successful:', result);

    // Invalidate cache to ensure fresh data is fetched
    requestCache.invalidate(/^files-/);
    requestCache.invalidate(/^folders-/);

    // Update local state
    setFiles(prevFiles => prevFiles.filter(file => !fileIds.includes(file.id)));
    setSelectedFiles(new Set());

    // Refresh all data
    await Promise.all([
      refreshFiles(),
      loadStorageStats(),
      loadDedupStats()
    ]);

    return result;
  } catch (error) {
    console.error('Failed to bulk delete:', error);

    if (error instanceof Error && error.message.includes('Failed to fetch')) {
      throw new Error('Cannot connect to server. Please ensure the backend is running.');
    }

    throw error;
  }
};

  const createFolder = async (name: string): Promise<void> => {
    const tokenStr = token || '';
    await storageService.createFolder(tokenStr, name, currentFolder);
    // Invalidate cache to ensure fresh data is fetched
    requestCache.invalidate(/^files-/);
    requestCache.invalidate(/^folders-/);
    await loadFiles();
  };

  const createShareLink = async (fileId: string, options: ShareLinkOptions = {}): Promise<unknown> => {
    const tokenStr = token || '';
    return await storageService.createShareLink(tokenStr, fileId, options);
  };

  const navigateToFolder = (folderId: string | null, folderName: string | null = null): void => {
    setCurrentFolder(folderId);
    setCurrentFolderName(folderId ? folderName : null);
    setSelectedFiles(new Set());
  };

  // Get all items (folders + files) for consistent indexing
  const getAllItems = (): Array<FileItem | FolderItem> => [...folders, ...files];

  // Range selection for shift+click
  const selectFileRange = (startIndex: number, endIndex: number): void => {
    const allItems = getAllItems();
    const minIdx = Math.min(startIndex, endIndex);
    const maxIdx = Math.max(startIndex, endIndex);
    const itemsInRange = allItems.slice(minIdx, maxIdx + 1);

    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      itemsInRange.forEach(item => newSet.add(item.id));
      return newSet;
    });
  };

  // Enhanced file selection with shift+click support
  const selectFile = (fileId: string, index: number | null = null, shiftKey: boolean = false): void => {
    // If shift is pressed and we have a previous click, select range
    if (shiftKey && lastClickedIndex !== null && index !== null) {
      selectFileRange(lastClickedIndex, index);
      setLastClickedIndex(index);
      return;
    }

    // Regular toggle selection
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });

    // Update last clicked index
    if (index !== null) {
      setLastClickedIndex(index);
    }
  };

  const selectAll = (): void => {
    const allItems = getAllItems();
    if (selectedFiles.size === allItems.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(allItems.map(item => item.id)));
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      loadFiles(),
      loadStorageStats(),
      loadDedupStats() // Include dedup stats in refresh all
    ]);
  };

  const clearSelection = (): void => {
    setSelectedFiles(new Set());
  };

  // Calculate migration stats when files change
  const updateMigrationStats = useCallback(() => {
    if (!zkEnabled || !files.length) {
      setMigrationStats(null);
      return;
    }

    // Only check ZK-encrypted files
    const zkFiles = files.filter(f => f.is_encrypted);
    if (!zkFiles.length) {
      setMigrationStats(null);
      return;
    }

    const stats = getMigrationStats(zkFiles);
    setMigrationStats(stats);
  }, [files, zkEnabled]);

  // Update migration stats when files change
  useEffect(() => {
    updateMigrationStats();
  }, [updateMigrationStats]);

  /**
   * Migrate a single file from V1 to V2 encryption
   * This re-downloads, re-encrypts with new key hierarchy, and re-uploads
   */
  const migrateFile = async (fileId: string): Promise<{ skipped?: boolean; reason?: string; success?: boolean; newFileId?: string }> => {
    if (!zkSessionUnlocked) {
      throw new Error('ZK session must be unlocked to migrate files');
    }

    const file = files.find(f => f.id === fileId);
    if (!file) {
      throw new Error('File not found');
    }

    if (!needsMigration(file)) {
      return { skipped: true, reason: 'Already using V2 encryption' };
    }

    try {
      // Download and decrypt with V1
      const downloadResult = await storageService.downloadZKFile(fileId, file.name, {
        file_size: file.size,
        encrypted_file_key: file.encrypted_file_key!,
        file_key_iv: file.file_key_iv!,
        mime_type: file.mime_type,
        chunk_size: 32 * 1024 * 1024
      });
      const decryptedData = downloadResult as unknown as ArrayBuffer;

      // Create a File object from the decrypted data
      const blob = new Blob([decryptedData], { type: file.mime_type });
      const migratedFile = new File([blob], file.name, { type: file.mime_type });

      // Delete the old file
      await deleteFile(fileId);

      // Re-upload with V2 encryption (new uploads automatically use V2)
      const result = await uploadFile(migratedFile);

      return { success: true, ...(result.fileId ? { newFileId: result.fileId } : {}) };
    } catch (error) {
      console.error('Migration failed for file:', file.name, error);
      throw error;
    }
  };

  /**
   * Migrate all V1 files to V2
   */
  const migrateAllFiles = async (onProgress?: (current: number, total: number, fileName: string) => void): Promise<MigrationResult> => {
    if (!zkSessionUnlocked) {
      throw new Error('ZK session must be unlocked to migrate files');
    }

    const filesToMigrate = files.filter(f => f.is_encrypted && needsMigration(f));

    if (filesToMigrate.length === 0) {
      return { completed: 0, failed: 0, skipped: 0 };
    }

    setMigrationInProgress(true);
    setMigrationProgress({ current: 0, total: filesToMigrate.length, currentFile: null });

    const results: MigrationResult = {
      completed: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    try {
      for (let i = 0; i < filesToMigrate.length; i++) {
        const file = filesToMigrate[i];
        if (!file) continue;

        setMigrationProgress({ current: i + 1, total: filesToMigrate.length, currentFile: file.name });

        if (onProgress) {
          onProgress(i + 1, filesToMigrate.length, file.name);
        }

        try {
          const result = await migrateFile(file.id);
          if (result.skipped) {
            results.skipped++;
          } else {
            results.completed++;
          }
        } catch (error) {
          results.failed++;
          results.errors!.push({ file: file.name, error: (error as Error).message });
        }
      }
    } finally {
      setMigrationInProgress(false);
      setMigrationProgress({ current: 0, total: 0, currentFile: null });

      // Refresh files and stats
      await refreshFiles();
      updateMigrationStats();
    }

    return results;
  };

  /**
   * Dismiss migration prompt (user chose not to migrate)
   */
  const dismissMigrationPrompt = (): void => {
    // Store dismissal in session storage so it persists within the session
    sessionStorage.setItem('migrationPromptDismissed', 'true');
    setMigrationStats(null);
  };

  /**
   * Check if migration prompt was dismissed
   */
  const isMigrationPromptDismissed = (): boolean => {
    return sessionStorage.getItem('migrationPromptDismissed') === 'true';
  };

  const value: StorageContextValue = {
    files,
    folders,
    currentFolder,
    currentFolderName,
    storageStats,
    isOnline,
    selectedFiles,
    dedupStats,
    loadDedupStats,
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
    getAllItems,
    refreshFiles,
    refreshStats: loadStorageStats,
    refreshAll,
    // Migration
    migrationStats,
    migrationInProgress,
    migrationProgress,
    migrateFile,
    migrateAllFiles,
    dismissMigrationPrompt,
    isMigrationPromptDismissed,
    formatMigrationStats,
  };

  return (
    <StorageContext.Provider value={value}>
      {children}
    </StorageContext.Provider>
  );
};
