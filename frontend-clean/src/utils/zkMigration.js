/**
 * Zero-Knowledge Encryption Migration Utilities
 *
 * Handles migration from V1 (legacy) to V2 (HKDF-based) encryption.
 * Provides version detection and gradual migration support.
 */

import { detectEncryptionVersion } from './zkCryptoV2.js';
import { decryptChunk } from './zkCrypto.js';
import { encryptChunkV2 } from './zkCryptoV2.js';

/**
 * Migration status for a file
 */
export const MIGRATION_STATUS = {
  NOT_NEEDED: 'not_needed',  // Already V2
  PENDING: 'pending',         // Needs migration
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Check if a file needs migration
 * @param {Object} file - File metadata from server
 * @returns {boolean}
 */
export function needsMigration(file) {
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
 * @param {Uint8Array} encryptedChunk
 * @returns {'v1' | 'v2'}
 */
export function checkChunkVersion(encryptedChunk) {
  return detectEncryptionVersion(encryptedChunk);
}

/**
 * Migrate a single file from V1 to V2 encryption
 * @param {Object} options
 * @param {Array<Uint8Array>} options.encryptedChunks - V1 encrypted chunks
 * @param {Uint8Array} options.fileKey - File encryption key
 * @param {string} options.fileId - File ID for AAD
 * @param {Function} options.onProgress - Progress callback (chunkIndex, totalChunks)
 * @returns {Promise<Array<Uint8Array>>} V2 encrypted chunks
 */
export async function migrateFileToV2({ encryptedChunks, fileKey, fileId, onProgress }) {
  const migratedChunks = [];

  for (let i = 0; i < encryptedChunks.length; i++) {
    const encryptedChunk = encryptedChunks[i];

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
        throw new Error(`Failed to migrate chunk ${i}: ${error.message}`);
      }
    }

    if (onProgress) {
      onProgress(i + 1, encryptedChunks.length);
    }
  }

  return migratedChunks;
}

/**
 * Create a migration plan for a file
 * @param {Object} file - File metadata
 * @returns {Object} Migration plan
 */
export function createMigrationPlan(file) {
  // Normalize version to integer
  const currentVersion = typeof file.encryption_version === 'number'
    ? file.encryption_version
    : (file.encryption_version === 'v2' ? 2 : 1);

  const plan = {
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
 * @param {number} sizeBytes
 * @returns {number} Estimated seconds
 */
function estimateMigrationTime(sizeBytes) {
  // Rough estimate: 10MB/s for migration (decrypt + re-encrypt)
  const MB = sizeBytes / (1024 * 1024);
  return Math.ceil(MB / 10);
}

/**
 * Batch migration helper
 * @param {Array<Object>} files - Files to migrate
 * @param {Function} onFileComplete - Callback per file
 * @param {Function} onProgress - Overall progress callback
 * @returns {Promise<Object>} Migration results
 */
export async function batchMigrate(files, onFileComplete, onProgress) {
  const results = {
    total: files.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

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
      results.errors.push({ file: file.name, error: error.message });

      if (onFileComplete) {
        onFileComplete(file, 'failed', error);
      }
    }

    if (onProgress) {
      onProgress(i + 1, files.length, results);
    }
  }

  return results;
}

/**
 * Get migration statistics for user's files
 * @param {Array<Object>} files
 * @returns {Object} Statistics
 */
export function getMigrationStats(files) {
  const stats = {
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
      stats.totalSizeV1 += file.size || 0;
    } else {
      stats.v2Files++;
      stats.totalSizeV2 += file.size || 0;
    }
  }

  stats.migrationNeeded = stats.v1Files > 0;

  return stats;
}

/**
 * Format migration stats for display
 * @param {Object} stats
 * @returns {string}
 */
export function formatMigrationStats(stats) {
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
