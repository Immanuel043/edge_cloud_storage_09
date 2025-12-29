import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import { websocketService } from '../services/websocketService';
import { useAuth } from './AuthContext';
import { offlineDB } from '../utils/offlineStorage';
import { requestCache } from '../utils/requestCache';
import { encryptFile, isZKSessionUnlocked } from '../services/zkEncryptionService';
import * as zkAuthService from '../services/zkAuthService';
import { bytesToBase64 } from '../utils/zkCrypto';
import { getMigrationStats, needsMigration, formatMigrationStats } from '../utils/zkMigration';
import { isZKModeActive, getFileService } from '../services/fileServiceRouter';
import { generateEncryptedThumbnail, supportsThumbnail } from '../utils/zkThumbnails';


const API_URL = import.meta.env.VITE_API_URL;

const StorageContext = createContext();

export const useStorage = () => {
  const context = useContext(StorageContext);
  if (!context) {
    throw new Error('useStorage must be used within StorageProvider');
  }
  return context;
};

export const StorageProvider = ({ children }) => {
  const { token, isAuthenticated, user, zkEnabled, zkSessionUnlocked } = useAuth();
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [currentFolderName, setCurrentFolderName] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
  const [dedupStats, setDedupStats] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState(null);

  // Migration state
  const [migrationStats, setMigrationStats] = useState(null);
  const [migrationInProgress, setMigrationInProgress] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState({ current: 0, total: 0, currentFile: null });

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Also add a WebSocket listener for file_uploaded events
  useEffect(() => {
    if (!websocketService || !isAuthenticated) return;

    // Listen for file upload events from WebSocket
    const handleFileUploaded = (data) => {
      console.log('WebSocket: file uploaded event', data);
      // Refresh files when we get a file uploaded event
      refreshFiles();
    };

    const unsubscribe = websocketService.on('file_uploaded', handleFileUploaded);

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      if (isOnline) {
        // Only load files when:
        // 1. Not ZK user, OR
        // 2. ZK user with unlocked session
        const shouldLoad = !zkEnabled || zkSessionUnlocked;
        if (shouldLoad) {
          console.log('[Storage] Loading files - zkEnabled:', zkEnabled, 'zkSessionUnlocked:', zkSessionUnlocked);
          loadFiles();
          loadStorageStats();
          loadDedupStats();
        } else {
          console.log('[Storage] Skipping file load - ZK session locked');
        }
      } else {
        loadOfflineData();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentFolder, isOnline, zkEnabled, zkSessionUnlocked]);

  useEffect(() => {
    // WebSocket event listeners
    const handleWSFileUploaded = (event) => {
      console.log('File uploaded event received:', event.detail);
      refreshFiles();
    };
    
    const handleWSFileDeleted = (event) => {
      console.log('File deleted event received:', event.detail);
      refreshFiles();
    };
    
    const handleWSStorageUpdate = (event) => {
      console.log('Storage update event received:', event.detail);
      if (event.detail) {
        setStorageStats(event.detail);
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
  }, [token]);

  const loadFiles = async (folderId = currentFolder) => {
    // Check if we should use ZK service
    const useZKService = zkEnabled && zkSessionUnlocked;

    try {
      let filesData, foldersData, statsData;

      if (useZKService) {
        // Use ZK service for encrypted files
        try {
          const zkFilesResponse = await zkAuthService.listFiles({ limit: 1000 });
          filesData = (zkFilesResponse.files || zkFilesResponse || []).map(f => ({
            id: f.file_id || f.id,
            name: f.filename || f.file_name || f.name,
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
          }));
          // Get storage usage from ZK service
          const zkUsage = await zkAuthService.getStorageUsage().catch(() => null);
          const usedBytes = zkUsage?.total_used || 0;
          const quotaBytes = zkUsage?.storage_quota || 100 * 1024 * 1024 * 1024; // Default 100GB
          statsData = zkUsage ? {
            used: usedBytes,
            total: quotaBytes,
            quota: quotaBytes, // For StorageStats component
            available: quotaBytes - usedBytes,
            files_count: zkUsage.total_files || filesData.length,
            percentage_used: zkUsage.usage_percentage || (quotaBytes > 0 ? (usedBytes / quotaBytes * 100) : 0),
          } : { used: 0, total: 100 * 1024 * 1024 * 1024, quota: 100 * 1024 * 1024 * 1024, available: 100 * 1024 * 1024 * 1024, files_count: filesData.length, percentage_used: 0 };
          foldersData = await storageService.getFolders(token, folderId).catch(() => []);
        } catch (zkError) {
          console.error('ZK loadFiles failed:', zkError);
          filesData = [];
          foldersData = [];
          statsData = { used: 0, total: 100 * 1024 * 1024 * 1024, quota: 100 * 1024 * 1024 * 1024, available: 100 * 1024 * 1024 * 1024, files_count: 0, percentage_used: 0 };
        }
      } else {
        // Use regular storage service
        [filesData, foldersData, statsData] = await Promise.all([
          storageService.getFiles(token, folderId),
          storageService.getFolders(token, folderId),
          storageService.getStorageStats(token)
        ]);
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

  const loadOfflineData = async () => {
    const cachedFiles = await offlineDB.getCachedFiles();
    const cachedFolders = await offlineDB.getCachedFolders();
    const cachedStats = await offlineDB.getCachedStats();

    setFiles(cachedFiles || []);
    setFolders(cachedFolders || []);
    setStorageStats(cachedStats);
  };

  const loadStorageStats = async () => {
    // Check if we should use ZK service
    const useZKService = zkEnabled && zkSessionUnlocked;

    try {
      let stats;

      if (useZKService) {
        // Use ZK service for storage usage
        const zkUsage = await zkAuthService.getStorageUsage().catch(() => null);
        const usedBytes = zkUsage?.total_used || 0;
        const quotaBytes = zkUsage?.storage_quota || 100 * 1024 * 1024 * 1024; // Default 100GB
        stats = zkUsage ? {
          used: usedBytes,
          total: quotaBytes,
          quota: quotaBytes, // For StorageStats component
          available: quotaBytes - usedBytes,
          files_count: zkUsage.total_files || 0,
          percentage_used: zkUsage.usage_percentage || (quotaBytes > 0 ? (usedBytes / quotaBytes * 100) : 0),
        } : { used: 0, total: 100 * 1024 * 1024 * 1024, quota: 100 * 1024 * 1024 * 1024, available: 100 * 1024 * 1024 * 1024, files_count: 0, percentage_used: 0 };
      } else {
        // Fetch both stats and files count in parallel for accuracy
        const [statsData, filesData] = await Promise.all([
          storageService.getStorageStats(token),
          storageService.getFiles(token, currentFolder)
        ]);
        stats = statsData;
        // Always set files_count from the actual files fetch for accuracy
        if (stats) {
          stats.files_count = filesData?.length || 0;
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
  const loadDedupStats = async () => {
  if (!isAuthenticated) return;

  try {
    const stats = await storageService.getDedupSavings(); // No token needed - uses cookie
    setDedupStats(stats);
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

  const refreshFiles = async (folderId = currentFolder) => {
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

      let filesData, foldersData;

      if (useZKService) {
        // Use ZK service for encrypted files
        try {
          const zkFilesResponse = await zkAuthService.listFiles({ limit: 1000 });
          // Transform ZK files response to match expected format
          filesData = (zkFilesResponse.files || zkFilesResponse || []).map(f => ({
            id: f.file_id || f.id,  // ZK API returns file_id
            name: f.filename || f.file_name || f.name,  // ZK API returns filename
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
          }));
          // For now, folders from regular service (ZK folders to be implemented)
          foldersData = await storageService.getFolders(token, folderId).catch(() => []);
        } catch (zkError) {
          console.error('ZK listFiles failed:', zkError);
          filesData = [];
          foldersData = [];
        }
      } else {
        // Use regular storage service
        [filesData, foldersData] = await Promise.all([
          storageService.getFiles(token, folderId),
          storageService.getFolders(token, folderId)
        ]);
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

  const uploadFile = async (file, onProgress) => {
  try {
    // Check if ZK encryption should be used
    console.log('[Storage] Upload check - zkEnabled:', zkEnabled, 'zkSessionUnlocked:', zkSessionUnlocked, 'isZKSessionUnlocked():', isZKSessionUnlocked());
    const useZKEncryption = zkEnabled && zkSessionUnlocked && isZKSessionUnlocked();
    console.log('[Storage] useZKEncryption:', useZKEncryption);

    if (useZKEncryption) {
      console.log('[Storage] Using ZK encrypted upload for:', file.name);

      // Step 1: Encrypt the file client-side
      let encryptionProgress = 0;
      const encryptedData = await encryptFile(file, (bytesEncrypted, totalBytes) => {
        encryptionProgress = Math.round((bytesEncrypted / totalBytes) * 30); // 0-30% for encryption
        if (onProgress) {
          onProgress({ progress: encryptionProgress, status: 'encrypting', uploadId: null });
        }
      });

      console.log('[Storage] File encrypted, chunks:', encryptedData.totalChunks);

      // Step 2: Generate encrypted thumbnail if file type is supported
      let thumbnailData = null;
      if (supportsThumbnail(file.type)) {
        try {
          console.log('[Storage] Generating encrypted thumbnail for:', file.name);
          thumbnailData = await generateEncryptedThumbnail(file, encryptedData.fileKey);
          if (thumbnailData) {
            console.log('[Storage] Thumbnail generated:', thumbnailData.width, 'x', thumbnailData.height);
          }
        } catch (thumbError) {
          console.warn('[Storage] Thumbnail generation failed (non-fatal):', thumbError.message);
        }
      }

      // Step 3: Initialize upload with ZK service (including thumbnail if available)
      const initResult = await zkAuthService.initializeUpload({
        fileName: file.name,
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

      // Step 3: Upload encrypted chunks
      for (let i = 0; i < encryptedData.encryptedChunks.length; i++) {
        const chunk = encryptedData.encryptedChunks[i];

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
    const result = await storageService.uploadFile(token, file, currentFolder, (progress) => {
      // Call the original progress callback
      if (onProgress) {
        onProgress(progress);
      }

      // Send progress via WebSocket only if connected
      // Don't let WebSocket issues affect upload
      try {
        if (websocketService.isConnected && progress.uploadId) {
          websocketService.sendUploadProgress(progress.uploadId, progress.progress);
        }
      } catch (wsError) {
        console.warn('WebSocket progress update failed:', wsError);
      }
    });

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

  const downloadFile = async (fileId, fileName, onProgress) => {
    // Check if this is a ZK-encrypted file
    const file = files.find(f => f.id === fileId);

    if (file && file.is_encrypted) {
      // ZK file - use ZK download with decryption
      const STREAMING_THRESHOLD = 50 * 1024 * 1024; // 50MB - use streaming for larger files

      if (file.size >= STREAMING_THRESHOLD) {
        console.log('[Storage] Downloading large ZK-encrypted file with streaming decryption:', fileName);
        return await storageService.downloadZKFileStreaming(fileId, fileName, {
          file_size: file.size,
          encrypted_file_key: file.encrypted_file_key,
          file_key_iv: file.file_key_iv,
          mime_type: file.mime_type,
          chunk_size: 32 * 1024 * 1024  // 32MB chunks
        }, onProgress);
      } else {
        console.log('[Storage] Downloading small ZK-encrypted file (sequential):', fileName);
        return await storageService.downloadZKFile(fileId, fileName, {
          file_size: file.size,
          encrypted_file_key: file.encrypted_file_key,
          file_key_iv: file.file_key_iv,
          mime_type: file.mime_type,
          chunk_size: 32 * 1024 * 1024  // 32MB default
        }, onProgress);
      }
    } else {
      // Standard file - use regular download
      return await storageService.downloadFile(token, fileId, fileName, onProgress);
    }
  };

  const deleteFile = async (fileId) => {
    try {
      // Find the file to determine which service to use
      const file = files.find(f => f.id === fileId);
      const isZKFile = file && getFileService(file) === 'zk';

      let result;
      if (isZKFile) {
        // Use ZK service for client-side encrypted files
        console.log('[Storage] Deleting ZK-encrypted file:', fileId);
        result = await zkAuthService.deleteFile(fileId);
      } else {
        // Use regular storage service
        result = await storageService.deleteFile(token, fileId);
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

  const bulkDelete = async (fileIds) => {
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
    
    const result = await response.json();
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
    
    if (error.message.includes('Failed to fetch')) {
      throw new Error('Cannot connect to server. Please ensure the backend is running.');
    }
    
    throw error;
  }
};

  const createFolder = async (name) => {
    await storageService.createFolder(token, name, currentFolder);
    // Invalidate cache to ensure fresh data is fetched
    requestCache.invalidate(/^files-/);
    requestCache.invalidate(/^folders-/);
    await loadFiles();
  };

  const createShareLink = async (fileId, options = {}) => {
    return await storageService.createShareLink(token, fileId, options);
  };

  const navigateToFolder = (folderId, folderName = null) => {
    setCurrentFolder(folderId);
    setCurrentFolderName(folderId ? folderName : null);
    setSelectedFiles(new Set());
  };

  // Get all items (folders + files) for consistent indexing
  const getAllItems = () => [...folders, ...files];

  // Range selection for shift+click
  const selectFileRange = (startIndex, endIndex) => {
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
  const selectFile = (fileId, index = null, shiftKey = false) => {
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

  const selectAll = () => {
    const allItems = getAllItems();
    if (selectedFiles.size === allItems.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(allItems.map(item => item.id)));
    }
  };

  const refreshAll = async () => {
    await Promise.all([
      loadFiles(),
      loadStorageStats(),
      loadDedupStats() // Include dedup stats in refresh all
    ]);
  };

  const clearSelection = () => {
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
  const migrateFile = async (fileId) => {
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
      const decryptedData = await storageService.downloadZKFile(fileId, file.name, {
        file_size: file.size,
        encrypted_file_key: file.encrypted_file_key,
        file_key_iv: file.file_key_iv,
        mime_type: file.mime_type,
        chunk_size: 32 * 1024 * 1024
      });

      // Create a File object from the decrypted data
      const blob = new Blob([decryptedData], { type: file.mime_type });
      const migratedFile = new File([blob], file.name, { type: file.mime_type });

      // Delete the old file
      await deleteFile(fileId);

      // Re-upload with V2 encryption (new uploads automatically use V2)
      const result = await uploadFile(migratedFile);

      return { success: true, newFileId: result.fileId };
    } catch (error) {
      console.error('Migration failed for file:', file.name, error);
      throw error;
    }
  };

  /**
   * Migrate all V1 files to V2
   */
  const migrateAllFiles = async (onProgress) => {
    if (!zkSessionUnlocked) {
      throw new Error('ZK session must be unlocked to migrate files');
    }

    const filesToMigrate = files.filter(f => f.is_encrypted && needsMigration(f));

    if (filesToMigrate.length === 0) {
      return { completed: 0, failed: 0, skipped: 0 };
    }

    setMigrationInProgress(true);
    setMigrationProgress({ current: 0, total: filesToMigrate.length, currentFile: null });

    const results = {
      completed: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    try {
      for (let i = 0; i < filesToMigrate.length; i++) {
        const file = filesToMigrate[i];
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
          results.errors.push({ file: file.name, error: error.message });
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
  const dismissMigrationPrompt = () => {
    // Store dismissal in session storage so it persists within the session
    sessionStorage.setItem('migrationPromptDismissed', 'true');
    setMigrationStats(null);
  };

  /**
   * Check if migration prompt was dismissed
   */
  const isMigrationPromptDismissed = () => {
    return sessionStorage.getItem('migrationPromptDismissed') === 'true';
  };

  const value = {
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