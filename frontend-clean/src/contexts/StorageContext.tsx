/**
 * Storage Context Router
 *
 * Routes to appropriate storage provider based on ZK mode.
 * - ZK Mode: ZKStorageProvider (client-side encryption)
 * - Normal Mode: NormalStorageProvider (server-side storage)
 */

import React from 'react';
import { useAuth } from './AuthContext';
import { ZKStorageProvider, useZKStorage } from './storage/ZKStorageContext';
import { NormalStorageProvider, useNormalStorage } from './storage/NormalStorageContext';
import type { StorageContextValue } from './storage/types';

// Re-export types for backwards compatibility
export type {
  FileItem,
  FolderItem,
  StorageStats,
  DedupStats,
  UploadProgress,
  ShareLinkOptions,
  MigrationStats,
  MigrationProgress,
  MigrationResult,
  BulkDeleteResult,
  StorageContextValue,
} from './storage/types';

/**
 * Hook to access storage context (mode-aware)
 */
export const useStorage = (): StorageContextValue => {
  const { zkEnabled, zkSessionUnlocked } = useAuth();

  // Route to appropriate hook based on current mode
  if (zkEnabled && zkSessionUnlocked) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useZKStorage();
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useNormalStorage();
};

interface StorageProviderProps {
  children: React.ReactNode;
}

/**
 * Storage Provider Router
 *
 * Automatically selects ZK or Normal provider based on auth state.
 */
export const StorageProvider: React.FC<StorageProviderProps> = ({ children }) => {
  const { zkEnabled, zkSessionUnlocked } = useAuth();

  // ZK Mode: Use ZK Storage Provider
  if (zkEnabled && zkSessionUnlocked) {
    console.log('[StorageRouter] Using ZK Storage Provider');
    return <ZKStorageProvider>{children}</ZKStorageProvider>;
  }

  // Normal Mode: Use Normal Storage Provider
  console.log('[StorageRouter] Using Normal Storage Provider');
  return <NormalStorageProvider>{children}</NormalStorageProvider>;
};

export default {
  StorageProvider,
  useStorage,
};
