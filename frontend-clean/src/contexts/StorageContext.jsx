import React, { createContext, useContext, useState, useEffect } from 'react';
import { storageService } from '../services/storageService';
import { websocketService } from '../services/websocketService';
import { useAuth } from './AuthContext';
import { offlineDB } from '../utils/offlineStorage';

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
  const [storageStats, setStorageStats] = useState(null);
  const [dedupStats, setDedupStats] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [selectedFiles, setSelectedFiles] = useState(new Set());

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

  useEffect(() => {
    if (isAuthenticated && token) {
      if (isOnline) {
        loadFiles();
        loadStorageStats();
        loadDedupStats(); // Load dedup stats on mount
      } else {
        loadOfflineData();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token, currentFolder, isOnline]);

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
  if (!token) return;
  
  try {
    const stats = await storageService.getDedupSavings(token);
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
    try {
      // Load files and folders
      const [filesData, foldersData] = await Promise.all([
        storageService.getFiles(token, folderId),
        storageService.getFolders(token, folderId)
      ]);
      
      setFiles(filesData);
      setFolders(foldersData);
      
      // ALSO refresh storage stats
      await loadStorageStats();
      
      // Cache for offline
      if (isOnline) {
        await offlineDB.cacheFiles(filesData);
        await offlineDB.cacheFolders(foldersData);
      }
    } catch (error) {
      console.error('Failed to load files:', error);
    }
  };

  const uploadFile = async (file, onProgress) => {
    try {
      const result = await storageService.uploadFile(token, file, currentFolder, (progress) => {
        // Call the original progress callback
        if (onProgress) {
          onProgress(progress);
        }
        
        // Send progress via WebSocket to other sessions
        if (websocketService.isConnected && progress.uploadId) {
          websocketService.sendUploadProgress(progress.uploadId, progress.progress);
        }
      });
      
      // After successful upload, refresh everything
      await refreshFiles();
      await loadDedupStats(); // Refresh dedup stats after upload
      
      return result;
    } catch (error) {
      console.error('Upload failed:', error);
      throw error;
    }
  };

  const downloadFile = async (fileId, fileName) => {
    return await storageService.downloadFile(token, fileId, fileName);
  };

  const deleteFile = async (fileId) => {
    try {
      const result = await storageService.deleteFile(token, fileId);
      
      // After successful deletion, refresh everything
      await refreshFiles();
      await loadDedupStats(); // Refresh dedup stats after deletion
      
      return result;
    } catch (error) {
      console.error('Failed to delete file:', error);
      throw error;
    }
  };

  const bulkDelete = async (fileIds) => {
    try {
      // Use the bulk delete endpoint
      const response = await fetch(`${API_URL}/files/bulk-delete`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_ids: fileIds })
      });
      
      if (!response.ok) {
        throw new Error('Bulk delete failed');
      }
      
      const result = await response.json();
      
      // After successful bulk deletion, refresh everything
      await refreshFiles();
      await loadDedupStats(); // Refresh dedup stats after bulk delete
      
      return result;
    } catch (error) {
      console.error('Failed to bulk delete:', error);
      throw error;
    }
  };

  const createFolder = async (name) => {
    await storageService.createFolder(token, name, currentFolder);
    await loadFiles();
  };

  const createShareLink = async (fileId, options = {}) => {
    return await storageService.createShareLink(token, fileId, options);
  };

  const navigateToFolder = (folderId) => {
    setCurrentFolder(folderId);
    setSelectedFiles(new Set());
  };

  const selectFile = (fileId) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map(f => f.id)));
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