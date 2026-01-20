import { useState, useEffect } from 'react';
import { storageService } from '../services/storageService';

export function useRecents(enabled = true) {
  const [recents, setRecents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchRecents = async () => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const data = await storageService.getRecentFiles(30); // Last 30 days
      setRecents(data);
    } catch (err) {
      console.error('Failed to fetch recent files:', err);
      setError(err.message || 'Failed to load recent files');
      setRecents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecents();
  }, [enabled]);

  return {
    recents,
    loading,
    error,
    refresh: fetchRecents,
  };
}
