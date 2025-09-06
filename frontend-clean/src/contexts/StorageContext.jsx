import React, { createContext, useContext, useState, useEffect } from 'react';
import { storageService } from '../services/storageService';
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
  const { token, isAuthenticated } = useAuth();
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
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
    } else {
      loadOfflineData();
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isAuthenticated, token, currentFolder, isOnline]);

  // In your StorageContext.jsx, replace your loadFiles function with this:

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
    
    // The backend already returns the correct format!
    // No transformation needed since backend returns: quota, used, percentage_used, distribution
    //console.log('Storage stats loaded:', stats);
    
    setStorageStats(stats);
    
    // Cache for offline
    if (isOnline) {
      await offlineDB.cacheStats(stats);
    }
  } catch (error) {
    console.error('Failed to load storage stats:', error);
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
    const result = await storageService.uploadFile(token, file, currentFolder, onProgress);
    
    // After successful upload, refresh everything
    await refreshFiles();
    
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
    //console.log('File deleted, freed space:', result.freed_space);
    
    // After successful deletion, refresh everything
    await refreshFiles();
    
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
    //console.log('Bulk delete completed:', result);
    
    // After successful bulk deletion, refresh everything
    await refreshFiles();
    
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
    loadStorageStats()
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
  refreshFiles,  // This now refreshes both files and stats
  refreshStats: loadStorageStats,  // Direct access to refresh just stats
  refreshAll  // Manual refresh everything
};

  return (
    <StorageContext.Provider value={value}>
      {children}
    </StorageContext.Provider>
  );
};