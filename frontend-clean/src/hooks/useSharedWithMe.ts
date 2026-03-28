import { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import type { FileResponse } from '../types/hooks.types';

// Type guard for FileResponse array
function isFileResponseArray(data: unknown): data is FileResponse[] {
  return Array.isArray(data) && data.every((item) => typeof item === 'object' && item !== null && 'id' in item);
}

export interface PendingInvitation {
  id: string;
  owner_email: string;
  item_name: string;
  item_type: 'file' | 'folder';
  permission: string;
  invitation_token: string;
  created_at: string;
  expires_at?: string;
  file_id?: string;
  folder_id?: string;
}

export interface UseSharedWithMeReturn {
  sharedFiles: FileResponse[];
  pendingInvitations: PendingInvitation[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  removeSharedAccess: (shareAccessId: string) => Promise<boolean>;
  acceptInvitation: (token: string) => Promise<void>;
  declineInvitation: (token: string) => Promise<void>;
}

export function useSharedWithMe(enabled: boolean = true): UseSharedWithMeReturn {
  const [sharedFiles, setSharedFiles] = useState<FileResponse[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSharedFiles = useCallback(async (): Promise<void> => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const [sharedResponse, invitationsResponse] = await Promise.all([
        storageService.getSharedWithMe(),
        storageService.getPendingInvitations(),
      ]);

      // Backend returns paginated {items: [...], total, limit, offset}
      const data = (sharedResponse && typeof sharedResponse === 'object' && 'items' in sharedResponse)
        ? (sharedResponse as { items: unknown }).items
        : sharedResponse;
      if (isFileResponseArray(data)) {
        setSharedFiles(data);
      } else {
        setSharedFiles(Array.isArray(data) ? [] : []);
      }

      setPendingInvitations(invitationsResponse as PendingInvitation[]);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to fetch shared files:', error);
      setError(error.message || 'Failed to load shared files');
      setSharedFiles([]);
      setPendingInvitations([]);
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

  const acceptInvitation = useCallback(async (token: string): Promise<void> => {
    await storageService.acceptInvitation(token);
    setPendingInvitations((prev) => prev.filter((inv) => inv.invitation_token !== token));
    // Refresh to get the newly accepted item in the shared files list
    void fetchSharedFiles();
  }, [fetchSharedFiles]);

  const declineInvitation = useCallback(async (token: string): Promise<void> => {
    await storageService.declineInvitation(token);
    setPendingInvitations((prev) => prev.filter((inv) => inv.invitation_token !== token));
  }, []);

  return {
    sharedFiles,
    pendingInvitations,
    loading,
    error,
    refresh: fetchSharedFiles,
    removeSharedAccess,
    acceptInvitation,
    declineInvitation,
  };
}
