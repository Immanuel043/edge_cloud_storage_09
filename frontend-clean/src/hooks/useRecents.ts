import { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import type { FileResponse } from '../types/hooks.types';

// Type guard for FileResponse array
function isFileResponseArray(data: unknown): data is FileResponse[] {
  return Array.isArray(data) && data.every((item) => typeof item === 'object' && item !== null && 'id' in item);
}

export interface UseRecentsReturn {
  recents: FileResponse[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRecents(enabled: boolean = true): UseRecentsReturn {
  const [recents, setRecents] = useState<FileResponse[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRecents = useCallback(async (): Promise<void> => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const data: unknown = await storageService.getRecentFiles(30); // Last 30 days
      if (isFileResponseArray(data)) {
        setRecents(data);
      } else {
        // Handle case where API returns empty array or unexpected format
        setRecents(Array.isArray(data) ? [] : []);
        if (!Array.isArray(data)) {
          console.warn('Unexpected response format from getRecentFiles:', data);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to fetch recent files:', error);
      setError(error.message || 'Failed to load recent files');
      setRecents([]);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void fetchRecents();
  }, [fetchRecents]);

  return {
    recents,
    loading,
    error,
    refresh: fetchRecents,
  };
}
