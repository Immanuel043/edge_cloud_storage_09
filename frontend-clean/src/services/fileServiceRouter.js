/**
 * File Service Router
 *
 * Unified service abstraction that routes file operations to the appropriate
 * backend service (ZK encryption service or normal storage service).
 *
 * This centralizes the ZK vs Normal mode decision logic in one place.
 * Also includes health checking to gracefully handle service unavailability.
 */

import * as zkAuthService from './zkAuthService.js';
import { ZK_SERVICE_URL, API_URL } from '../config/constants.js';

// ==================== Service Health Checking ====================

// Service health state cache
const serviceHealth = {
  zk: { healthy: true, lastCheck: 0, checkInProgress: false },
  storage: { healthy: true, lastCheck: 0, checkInProgress: false }
};

const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds

/**
 * Check ZK service health
 * @returns {Promise<boolean>} True if service is healthy
 */
export async function checkZKServiceHealth() {
  const now = Date.now();
  const state = serviceHealth.zk;

  // Return cached result if recent
  if (now - state.lastCheck < HEALTH_CHECK_INTERVAL) {
    return state.healthy;
  }

  // Prevent concurrent checks
  if (state.checkInProgress) {
    return state.healthy;
  }

  state.checkInProgress = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(`${ZK_SERVICE_URL}/health`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    state.healthy = response.ok;
    state.lastCheck = now;
    return state.healthy;
  } catch (error) {
    console.warn('ZK service health check failed:', error.message);
    state.healthy = false;
    state.lastCheck = now;
    return false;
  } finally {
    state.checkInProgress = false;
  }
}

/**
 * Check Storage service health
 * @returns {Promise<boolean>} True if service is healthy
 */
export async function checkStorageServiceHealth() {
  const now = Date.now();
  const state = serviceHealth.storage;

  // Return cached result if recent
  if (now - state.lastCheck < HEALTH_CHECK_INTERVAL) {
    return state.healthy;
  }

  // Prevent concurrent checks
  if (state.checkInProgress) {
    return state.healthy;
  }

  state.checkInProgress = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(`${API_URL}/health`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    state.healthy = response.ok;
    state.lastCheck = now;
    return state.healthy;
  } catch (error) {
    console.warn('Storage service health check failed:', error.message);
    state.healthy = false;
    state.lastCheck = now;
    return false;
  } finally {
    state.checkInProgress = false;
  }
}

/**
 * Get service health status
 * @returns {Object} Health status for both services
 */
export function getServiceHealthStatus() {
  return {
    zk: { ...serviceHealth.zk },
    storage: { ...serviceHealth.storage }
  };
}

/**
 * Reset health status (force recheck on next operation)
 */
export function resetHealthStatus() {
  serviceHealth.zk.lastCheck = 0;
  serviceHealth.storage.lastCheck = 0;
}

// ====================

/**
 * Check if ZK mode is active based on auth context
 * @param {Object} authContext - Authentication context containing zkEnabled and zkSessionUnlocked
 * @returns {boolean} True if ZK mode is active
 */
export function isZKModeActive(authContext) {
  return authContext?.zkEnabled === true && authContext?.zkSessionUnlocked === true;
}

/**
 * List files from the appropriate service
 * @param {Object} authContext - Auth context with zkEnabled and zkSessionUnlocked
 * @param {Object} options - Query options (limit, offset, sortBy, sortOrder)
 * @returns {Promise<Object>} Files list response
 */
export async function listFiles(authContext, options = {}) {
  if (isZKModeActive(authContext)) {
    return zkAuthService.listFiles(options);
  }

  // Normal storage service
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit);
  if (options.offset) params.append('offset', options.offset);
  if (options.sortBy) params.append('sort_by', options.sortBy);
  if (options.sortOrder) params.append('sort_order', options.sortOrder);

  const response = await fetch(`${API_URL}/api/v1/files?${params.toString()}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error('Failed to list files');
  }

  return response.json();
}

/**
 * Get storage usage from the appropriate service
 * @param {Object} authContext - Auth context with zkEnabled and zkSessionUnlocked
 * @returns {Promise<Object>} Storage usage data
 */
export async function getStorageUsage(authContext) {
  if (isZKModeActive(authContext)) {
    return zkAuthService.getStorageUsage();
  }

  // Normal storage service
  const response = await fetch(`${API_URL}/api/v1/storage/usage`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error('Failed to get storage usage');
  }

  return response.json();
}

/**
 * Get file metadata from the appropriate service
 * @param {Object} authContext - Auth context
 * @param {string} fileId - File ID
 * @param {Object} fileMetadata - Optional file metadata (to check encryption_mode)
 * @returns {Promise<Object>} File metadata
 */
export async function getFileMetadata(authContext, fileId, fileMetadata = null) {
  // If we have metadata, use it to determine the service
  const isZKFile = fileMetadata?.encryption_mode === 'client_zk' ||
                   (fileMetadata?.is_encrypted && !fileMetadata?.encryption_mode);

  if (isZKFile || isZKModeActive(authContext)) {
    return zkAuthService.getFileMetadata(fileId);
  }

  // Normal storage service
  const response = await fetch(`${API_URL}/api/v1/files/${fileId}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error('Failed to get file metadata');
  }

  return response.json();
}

/**
 * Delete file from the appropriate service
 * @param {Object} authContext - Auth context
 * @param {string} fileId - File ID
 * @param {Object} fileMetadata - File metadata to determine service
 * @returns {Promise<Object>} Deletion result
 */
export async function deleteFile(authContext, fileId, fileMetadata = null) {
  const isZKFile = fileMetadata?.encryption_mode === 'client_zk' ||
                   (fileMetadata?.is_encrypted && !fileMetadata?.encryption_mode);

  if (isZKFile || isZKModeActive(authContext)) {
    return zkAuthService.deleteFile(fileId);
  }

  // Normal storage service
  const response = await fetch(`${API_URL}/api/v1/files/${fileId}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error('Failed to delete file');
  }

  return response.json();
}

/**
 * Check which service a file belongs to based on its metadata
 * @param {Object} fileMetadata - File metadata
 * @returns {string} 'zk' or 'normal'
 */
export function getFileService(fileMetadata) {
  if (fileMetadata?.encryption_mode === 'client_zk') {
    return 'zk';
  }
  if (fileMetadata?.encryption_mode === 'server_side') {
    return 'normal';
  }
  // Fallback: check is_encrypted flag
  if (fileMetadata?.is_encrypted && fileMetadata?.encrypted_file_key) {
    return 'zk';
  }
  return 'normal';
}

/**
 * Transform file data from ZK service to common format
 * @param {Object} file - File from ZK service
 * @returns {Object} Normalized file object
 */
export function normalizeZKFile(file) {
  return {
    id: file.id || file.file_id,
    name: file.file_name || file.filename || file.name,
    size: file.file_size || file.size,
    mimeType: file.mime_type || file.mimeType,
    createdAt: file.created_at || file.createdAt,
    updatedAt: file.updated_at || file.updatedAt,
    uploadedAt: file.uploaded_at || file.uploadedAt,
    // ZK-specific fields
    is_encrypted: true,
    encryption_mode: 'client_zk',
    encryption_version: file.encryption_version,
    encrypted_file_key: file.encrypted_file_key,
    file_key_iv: file.file_key_iv,
    encryption_algorithm: file.encryption_algorithm,
    file_hash: file.file_hash
  };
}

/**
 * Transform file data from normal storage service to common format
 * @param {Object} file - File from storage service
 * @returns {Object} Normalized file object
 */
export function normalizeStorageFile(file) {
  return {
    id: file.id,
    name: file.file_name || file.name,
    size: file.file_size || file.size,
    mimeType: file.mime_type || file.mimeType,
    createdAt: file.created_at || file.createdAt,
    updatedAt: file.updated_at || file.updatedAt,
    // Storage-specific fields
    is_encrypted: file.is_encrypted || false,
    encryption_mode: file.encryption_mode || 'none',
    storage_tier: file.storage_tier,
    content_hash: file.content_hash
  };
}

export default {
  // Health checking
  checkZKServiceHealth,
  checkStorageServiceHealth,
  getServiceHealthStatus,
  resetHealthStatus,
  // Mode checking
  isZKModeActive,
  // File operations
  listFiles,
  getStorageUsage,
  getFileMetadata,
  deleteFile,
  // Utilities
  getFileService,
  normalizeZKFile,
  normalizeStorageFile
};
