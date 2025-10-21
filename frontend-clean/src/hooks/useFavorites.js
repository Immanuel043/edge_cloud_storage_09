import { useState, useEffect } from 'react';
import { storageService } from '../services/storageService';

export function useFavorites(enabled = true) {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchFavorites = async () => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const data = await storageService.getFavorites();
      setFavorites(data);
    } catch (err) {
      console.error('Failed to fetch favorites:', err);
      setError(err.message || 'Failed to load favorites');
      setFavorites([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleFavorite = async (fileId) => {
    try {
      const result = await storageService.toggleFavorite(fileId);
      await fetchFavorites(); // Refresh list
      return result;
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
      throw err;
    }
  };

  useEffect(() => {
    fetchFavorites();
  }, [enabled]);

  return {
    favorites,
    loading,
    error,
    toggleFavorite,
    refresh: fetchFavorites,
  };
}
