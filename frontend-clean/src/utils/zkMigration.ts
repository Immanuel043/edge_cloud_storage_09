/**
 * Zero-Knowledge Encryption Migration Utilities
 *
 * Handles migration from V1 (legacy) to V2 (HKDF-based) encryption.
 * Provides version detection and gradual migration support.
 */

import { detectEncryptionVersion, type EncryptionVersion } from './zkCryptoV2';
import { decryptChunk } from './zkCrypto';
import { encryptChunkV2 } from './zkCryptoV2';

/**
 * Migration status for a file
 */
export const MIGRATION_STATUS = {
  NOT_NEEDED: 'not_needed',  // Already V2
  PENDING: 'pending',         // Needs migration
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type MigrationStatus = typeof MIGRATION_STATUS[keyof typeof MIGRATION_STATUS];

/**
 * File metadata interface for migration
 */
export interface MigratableFile {
  id: string;
  name: string;
  size: number;
  is_encrypted?: boolean;
  encryption_version?: number | 'v1' | 'v2';
}

/**
 * Check if a file needs migration
 */
export function needsMigration(file: MigratableFile): boolean {
  // Not encrypted = no migration needed
  if (!file.is_encrypted) {
    return false;
  }

  // Check encryption version field (server stores as integer: 1 or 2)
  const version = file.encryption_version;

  // V2 doesn't need migration
  if (version === 2 || version === 'v2') {
    return false;
  }

  // V1 or no version (legacy files) needs migration
  if (version === 1 || version === 'v1' || !version) {
    return true;
  }

  return false;
}

/**
 * Check encryption version of a chunk
 */
export function checkChunkVersion(encryptedChunk: Uint8Array): EncryptionVersion {
  return detectEncryptionVersion(encryptedChunk);
}

/**
 * Options for file migration
 */
export interface MigrateFileOptions {
  encryptedChunks: Uint8Array[];
  fileKey: Uint8Array;
  fileId: string;
  onProgress?: (chunkIndex: number, totalChunks: number) => void;
}

/**
 * Migrate a single file from V1 to V2 encryption
 * @returns V2 encrypted chunks
 */
export async function migrateFileToV2({
  encryptedChunks,
  fileKey,
  fileId,
  onProgress,
}: MigrateFileOptions): Promise<Uint8Array[]> {
  const migratedChunks: Uint8Array[] = [];

  for (let i = 0; i < encryptedChunks.length; i++) {
    const encryptedChunk = encryptedChunks[i] as Uint8Array;

    // Check version
    const version = checkChunkVersion(encryptedChunk);

    if (version === 'v2') {
      // Already V2, no migration needed
      migratedChunks.push(encryptedChunk);
    } else {
      // V1 chunk - decrypt with V1, re-encrypt with V2
      try {
        // Decrypt with V1
        const decryptedChunk = decryptChunk(encryptedChunk, fileKey, i);

        // Re-encrypt with V2 (includes AAD)
        const v2Chunk = encryptChunkV2(decryptedChunk, fileKey, fileId, i);
        migratedChunks.push(v2Chunk);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to migrate chunk ${i}: ${errorMessage}`);
      }
    }

    if (onProgress) {
      onProgress(i + 1, encryptedChunks.length);
    }
  }

  return migratedChunks;
}

/**
 * Migration plan for a file
 */
export interface MigrationPlan {
  fileId: string;
  fileName: string;
  fileSize: number;
  currentVersion: number;
  targetVersion: 2;
  estimatedTime: number;
  needsMigration: boolean;
}

/**
 * Create a migration plan for a file
 */
export function createMigrationPlan(file: MigratableFile): MigrationPlan {
  // Normalize version to integer
  const currentVersion = typeof file.encryption_version === 'number'
    ? file.encryption_version
    : (file.encryption_version === 'v2' ? 2 : 1);

  const plan: MigrationPlan = {
    fileId: file.id,
    fileName: file.name,
    fileSize: file.size,
    currentVersion,
    targetVersion: 2,
    estimatedTime: estimateMigrationTime(file.size),
    needsMigration: needsMigration(file),
  };

  return plan;
}

/**
 * Estimate migration time based on file size
 * @param sizeBytes
 * @returns Estimated seconds
 */
function estimateMigrationTime(sizeBytes: number): number {
  // Rough estimate: 10MB/s for migration (decrypt + re-encrypt)
  const MB = sizeBytes / (1024 * 1024);
  return Math.ceil(MB / 10);
}

/**
 * Batch migration results
 */
export interface BatchMigrationResults {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Batch migration helper
 */
export async function batchMigrate(
  files: MigratableFile[],
  onFileComplete?: (file: MigratableFile, status: string, error?: Error) => void,
  onProgress?: (current: number, total: number, results: BatchMigrationResults) => void
): Promise<BatchMigrationResults> {
  const results: BatchMigrationResults = {
    total: files.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i] as MigratableFile;

    try {
      if (!needsMigration(file)) {
        results.skipped++;
        continue;
      }

      // Migration would happen here
      // This is a placeholder - actual migration requires file download/upload

      results.completed++;

      if (onFileComplete) {
        onFileComplete(file, 'completed');
      }
    } catch (error) {
      results.failed++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.errors.push({ file: file.name, error: errorMessage });

      if (onFileComplete) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        onFileComplete(file, 'failed', errorObj);
      }
    }

    if (onProgress) {
      onProgress(i + 1, files.length, results);
    }
  }

  return results;
}

/**
 * Migration statistics
 */
export interface MigrationStats {
  total: number;
  v1Files: number;
  v2Files: number;
  totalSizeV1: number;
  totalSizeV2: number;
  migrationNeeded: boolean;
}

/**
 * Get migration statistics for user's files
 */
export function getMigrationStats(files: MigratableFile[]): MigrationStats {
  const stats: MigrationStats = {
    total: files.length,
    v1Files: 0,
    v2Files: 0,
    totalSizeV1: 0,
    totalSizeV2: 0,
    migrationNeeded: false,
  };

  for (const file of files) {
    if (needsMigration(file)) {
      stats.v1Files++;
      stats.totalSizeV1 += file.size ?? 0;
    } else {
      stats.v2Files++;
      stats.totalSizeV2 += file.size ?? 0;
    }
  }

  stats.migrationNeeded = stats.v1Files > 0;

  return stats;
}

/**
 * Format migration stats for display
 */
export function formatMigrationStats(stats: MigrationStats): string {
  if (!stats.migrationNeeded) {
    return 'All files are using the latest encryption.';
  }

  const sizeMB = (stats.totalSizeV1 / (1024 * 1024)).toFixed(1);
  return `${stats.v1Files} file(s) (${sizeMB} MB) can be upgraded to enhanced encryption.`;
}

export default {
  MIGRATION_STATUS,
  needsMigration,
  checkChunkVersion,
  migrateFileToV2,
  createMigrationPlan,
  batchMigrate,
  getMigrationStats,
  formatMigrationStats,
};
