import React, { createContext, useContext, useState, useEffect } from 'react';
import { storageService } from '../services/storageService';
import { websocketService } from '../services/websocketService';
import { useAuth } from './AuthContext';
import { offlineDB } from '../utils/offlineStorage';
import { requestCache } from '../utils/requestCache';


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
  const { token, isAuthenticated, user } = useAuth(); // Added user here
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [currentFolderName, setCurrentFolderName] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
  const [dedupStats, setDedupStats] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState(null);

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
        loadFiles();
        loadStorageStats();
        loadDedupStats(); // Load dedup stats on mount
      } else {
        loadOfflineData();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentFolder, isOnline]);

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
    try {
      const [filesData, foldersData, statsData] = await Promise.all([
        storageService.getFiles(token, folderId),
        storageService.getFolders(token, folderId),
        storageService.getStorageStats(token)
      ]);
      
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
    try {
      const stats = await storageService.getStorageStats(token);
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
  
  while (retryCount < maxRetries) {
    try {
      console.log(`Refreshing files (attempt ${retryCount + 1})...`);
      
      // Add a small delay between retries
      if (retryCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
      }
      
      const [filesData, foldersData] = await Promise.all([
        storageService.getFiles(token, folderId),
        storageService.getFolders(token, folderId)
      ]);
      
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
      const result = await storageService.deleteFile(token, fileId);

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
    refreshAll
  };

  return (
    <StorageContext.Provider value={value}>
      {children}
    </StorageContext.Provider>
  );
};