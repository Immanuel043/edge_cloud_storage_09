/**
 * Storage Context Router
 *
 * Routes to appropriate storage provider based on ZK mode.
 * - ZK Mode: ZKStorageProvider (client-side encryption)
 * - Normal Mode: NormalStorageProvider (server-side storage)
 *
 * Uses a unified StorageContext with bridge components to avoid
 * conditional hook calls (React Rules of Hooks compliance).
 */

import React, { createContext, useContext } from 'react';
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
 * Unified Storage Context
 * Populated by the appropriate bridge component (ZK or Normal)
 */
const StorageContext = createContext<StorageContextValue | undefined>(undefined);

/**
 * Hook to access storage context (mode-aware)
 * Always calls useContext unconditionally (React Rules of Hooks compliant)
 */
export const useStorage = (): StorageContextValue => {
  const context = useContext(StorageContext);
  if (!context) {
    throw new Error('useStorage must be used within StorageProvider');
  }
  return context;
};

/**
 * Bridge component that reads from ZKStorageContext and provides to unified StorageContext.
 * Safe because it's always rendered inside ZKStorageProvider.
 */
const ZKStorageBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const zkStorage = useZKStorage();
  return <StorageContext.Provider value={zkStorage}>{children}</StorageContext.Provider>;
};

/**
 * Bridge component that reads from NormalStorageContext and provides to unified StorageContext.
 * Safe because it's always rendered inside NormalStorageProvider.
 */
const NormalStorageBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const normalStorage = useNormalStorage();
  return <StorageContext.Provider value={normalStorage}>{children}</StorageContext.Provider>;
};

interface StorageProviderProps {
  children: React.ReactNode;
}

/**
 * Storage Provider Router
 *
 * Automatically selects ZK or Normal provider based on auth state.
 * Uses bridge components to provide a unified StorageContext.
 */
export const StorageProvider: React.FC<StorageProviderProps> = ({ children }) => {
  const { zkEnabled, zkSessionUnlocked } = useAuth();

  // ZK Mode: Use ZK Storage Provider with bridge
  if (zkEnabled && zkSessionUnlocked) {
    console.log('[StorageRouter] Using ZK Storage Provider');
    return (
      <ZKStorageProvider>
        <ZKStorageBridge>{children}</ZKStorageBridge>
      </ZKStorageProvider>
    );
  }

  // Normal Mode: Use Normal Storage Provider with bridge
  console.log('[StorageRouter] Using Normal Storage Provider');
  return (
    <NormalStorageProvider>
      <NormalStorageBridge>{children}</NormalStorageBridge>
    </NormalStorageProvider>
  );
};

export default {
  StorageProvider,
  useStorage,
};
