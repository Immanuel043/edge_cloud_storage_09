import { useState, useEffect } from 'react';
import { storageService } from '../services/storageService';

export function useSharedWithMe(enabled = true) {
  const [sharedFiles, setSharedFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchSharedFiles = async () => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const data = await storageService.getSharedWithMe();
      setSharedFiles(data);
    } catch (err) {
      console.error('Failed to fetch shared files:', err);
      setError(err.message || 'Failed to load shared files');
      setSharedFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSharedFiles();
  }, [enabled]);

  const removeSharedAccess = async (shareAccessId) => {
    try {
      await storageService.removeSharedAccess(shareAccessId);
      // Remove from local state
      setSharedFiles(prev => prev.filter(item => item.id !== shareAccessId));
      return true;
    } catch (err) {
      console.error('Failed to remove shared access:', err);
      throw err;
    }
  };

  return {
    sharedFiles,
    loading,
    error,
    refresh: fetchSharedFiles,
    removeSharedAccess,
  };
}
