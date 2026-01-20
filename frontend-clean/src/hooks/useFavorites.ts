import { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import type { FileResponse, ToggleFavoriteResponse } from '../types/hooks.types';

// Type guard for FileResponse array
function isFileResponseArray(data: unknown): data is FileResponse[] {
  return Array.isArray(data) && data.every((item) => typeof item === 'object' && item !== null && 'id' in item);
}

// Type guard for ToggleFavoriteResponse
function isToggleFavoriteResponse(data: unknown): data is ToggleFavoriteResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'favorited' in data &&
    typeof (data as Record<string, unknown>).favorited === 'boolean' &&
    'message' in data &&
    typeof (data as Record<string, unknown>).message === 'string'
  );
}

export interface UseFavoritesReturn {
  favorites: FileResponse[];
  loading: boolean;
  error: string | null;
  toggleFavorite: (fileId: string) => Promise<ToggleFavoriteResponse>;
  refresh: () => Promise<void>;
}

export function useFavorites(enabled: boolean = true): UseFavoritesReturn {
  const [favorites, setFavorites] = useState<FileResponse[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFavorites = useCallback(async (): Promise<void> => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const data: unknown = await storageService.getFavorites();
      if (isFileResponseArray(data)) {
        setFavorites(data);
      } else {
        // Handle case where API returns empty array or unexpected format
        setFavorites(Array.isArray(data) ? [] : []);
        if (!Array.isArray(data)) {
          console.warn('Unexpected response format from getFavorites:', data);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to fetch favorites:', error);
      setError(error.message || 'Failed to load favorites');
      setFavorites([]);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  const toggleFavorite = useCallback(async (fileId: string): Promise<ToggleFavoriteResponse> => {
    try {
      const result: unknown = await storageService.toggleFavorite(fileId);
      if (isToggleFavoriteResponse(result)) {
        // Refresh list - we'll call fetchFavorites after state updates
        return result;
      } else {
        // Fallback response if API format is unexpected
        return {
          favorited: true,
          message: 'Favorite status updated',
        };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to toggle favorite:', error);
      throw error;
    }
  }, []);

  useEffect(() => {
    void fetchFavorites();
  }, [fetchFavorites]);

  // Refresh favorites after toggle
  const toggleFavoriteWithRefresh = useCallback(async (fileId: string): Promise<ToggleFavoriteResponse> => {
    const result = await toggleFavorite(fileId);
    await fetchFavorites();
    return result;
  }, [toggleFavorite, fetchFavorites]);

  return {
    favorites,
    loading,
    error,
    toggleFavorite: toggleFavoriteWithRefresh,
    refresh: fetchFavorites,
  };
}
