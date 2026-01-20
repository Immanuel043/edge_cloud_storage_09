import { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import type { FileResponse } from '../types/hooks.types';

// Type guard for FileResponse array
function isFileResponseArray(data: unknown): data is FileResponse[] {
  return Array.isArray(data) && data.every((item) => typeof item === 'object' && item !== null && 'id' in item);
}

export interface UseSharedWithMeReturn {
  sharedFiles: FileResponse[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  removeSharedAccess: (shareAccessId: string) => Promise<boolean>;
}

export function useSharedWithMe(enabled: boolean = true): UseSharedWithMeReturn {
  const [sharedFiles, setSharedFiles] = useState<FileResponse[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSharedFiles = useCallback(async (): Promise<void> => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const data: unknown = await storageService.getSharedWithMe();
      if (isFileResponseArray(data)) {
        setSharedFiles(data);
      } else {
        // Handle case where API returns empty array or unexpected format
        setSharedFiles(Array.isArray(data) ? [] : []);
        if (!Array.isArray(data)) {
          console.warn('Unexpected response format from getSharedWithMe:', data);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to fetch shared files:', error);
      setError(error.message || 'Failed to load shared files');
      setSharedFiles([]);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void fetchSharedFiles();
  }, [fetchSharedFiles]);

  const removeSharedAccess = useCallback(async (shareAccessId: string): Promise<boolean> => {
    try {
      await storageService.removeSharedAccess(shareAccessId);
      // Remove from local state
      setSharedFiles((prev) => prev.filter((item) => item.id !== shareAccessId));
      return true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to remove shared access:', error);
      throw error;
    }
  }, []);

  return {
    sharedFiles,
    loading,
    error,
    refresh: fetchSharedFiles,
    removeSharedAccess,
  };
}
