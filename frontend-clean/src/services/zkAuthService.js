/**
 * Zero-Knowledge Authentication Service
 *
 * API calls to the ZK backend service for authentication and user management.
 * All sensitive cryptographic operations happen client-side; this service
 * only handles network communication with the backend.
 */

import { ZK_ENDPOINTS, ZK_ERRORS } from '../config/constants.js';

// ==================== Custom Error Types ====================

/**
 * Upload error with specific error type for better handling
 */
export class UploadError extends Error {
  constructor(message, type, details = {}) {
    super(message);
    this.name = 'UploadError';
    this.type = type; // 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'NETWORK', 'AUTH', 'UNKNOWN'
    this.details = details;
  }
}

export const UPLOAD_ERROR_TYPES = Object.freeze({
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  AUTH: 'AUTH',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
});

// ==================== Helper Functions ====================

/**
 * Make an authenticated API request to ZK service
 * @param {string} url - API endpoint URL
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Response data
 */
async function zkFetch(url, options = {}) {
  const defaultOptions = {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include', // Include cookies for session management
  };

  const mergedOptions = {
    ...defaultOptions,
    ...options,
    headers: {
      ...defaultOptions.headers,
      ...options.headers,
    },
  };

  try {
    const response = await fetch(url, mergedOptions);

    // Handle different response types
    const contentType = response.headers.get('content-type');
    let data;

    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      // Extract error message from response
      let errorMessage = 'Unknown error';
      if (typeof data === 'string') {
        errorMessage = data;
      } else if (data?.error?.message) {
        // Handle custom ZK service error format: {"error": {"code": 400, "message": "..."}}
        errorMessage = data.error.message;
      } else if (data?.detail) {
        // Handle FastAPI validation errors (array of error objects)
        if (Array.isArray(data.detail)) {
          errorMessage = data.detail.map(e => e.msg || e.message || JSON.stringify(e)).join(', ');
        } else if (typeof data.detail === 'string') {
          errorMessage = data.detail;
        } else {
          errorMessage = JSON.stringify(data.detail);
        }
      } else if (data?.message) {
        errorMessage = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
      }
      throw new Error(errorMessage);
    }

    return data;
  } catch (error) {
    // Network errors
    if (error instanceof TypeError) {
      throw new Error(ZK_ERRORS.NETWORK_ERROR);
    }

    // Re-throw API errors
    throw error;
  }
}

// ==================== KDF Parameters ====================

/**
 * Get KDF parameters for a user (public endpoint)
 * @param {string} email - User email
 * @returns {Promise<Object>} { kdf_salt, kdf_algorithm, kdf_iterations }
 */
export async function getKDFParams(email) {
  const url = `${ZK_ENDPOINTS.KDF_PARAMS}?email=${encodeURIComponent(email)}`;

  try {
    const response = await zkFetch(url);
    return response;
  } catch (error) {
    // 404 is expected for new users
    if (error.message.includes('404') || error.message.includes('not found')) {
      return null;
    }
    throw error;
  }
}

// ==================== Registration ====================

/**
 * Register a new ZK user
 * @param {Object} registrationData - Registration data
 * @param {string} registrationData.email - User email
 * @param {string} registrationData.username - Username
 * @param {string} registrationData.passwordHash - Hashed derived key
 * @param {string} registrationData.encryptedMasterKey - Encrypted master key (base64)
 * @param {string} registrationData.kdfSalt - KDF salt (hex)
 * @param {string} registrationData.kdfAlgorithm - KDF algorithm (pbkdf2 or argon2id)
 * @param {number} registrationData.kdfIterations - KDF iterations
 * @param {number} registrationData.kdfMemory - Argon2id memory parameter (optional)
 * @param {number} registrationData.kdfParallelism - Argon2id parallelism parameter (optional)
 * @returns {Promise<Object>} { user_id, access_token, message }
 */
export async function registerZK(registrationData) {
  const payload = {
    email: registrationData.email,
    username: registrationData.username,
    password_hash: registrationData.passwordHash,
    encrypted_master_key: registrationData.encryptedMasterKey,
    master_key_iv: registrationData.masterKeyIV,
    kdf_salt: registrationData.kdfSalt,
    kdf_algorithm: registrationData.kdfAlgorithm,
    kdf_iterations: registrationData.kdfIterations,
    kdf_memory: registrationData.kdfMemory,
    kdf_parallelism: registrationData.kdfParallelism,
  };

  const response = await zkFetch(ZK_ENDPOINTS.REGISTER_ZK, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== Login ====================

/**
 * Login with ZK credentials
 * @param {string} email - User email
 * @param {string} passwordHash - Hashed derived key
 * @returns {Promise<Object>} { access_token, encrypted_master_key, user_id, zk_enabled }
 */
export async function loginZK(email, passwordHash) {
  const payload = {
    email,
    password_hash: passwordHash,
  };

  const response = await zkFetch(ZK_ENDPOINTS.LOGIN_ZK, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== Logout ====================

/**
 * Logout current user
 * @returns {Promise<Object>} { message }
 */
export async function logout() {
  const response = await zkFetch(ZK_ENDPOINTS.LOGOUT, {
    method: 'POST',
  });

  return response;
}

// ==================== User Status ====================

/**
 * Get current user's ZK status
 * @returns {Promise<Object>} ZK status and configuration
 */
export async function getZKStatus() {
  const response = await zkFetch(ZK_ENDPOINTS.STATUS);
  return response;
}

// ==================== Recovery Phrase ====================

/**
 * Enable recovery phrase for current user
 * @param {string} recoveryEncryptedMasterKey - Master key encrypted with recovery phrase
 * @param {string} recoveryPhraseHash - SHA-256 hash of recovery phrase
 * @returns {Promise<Object>} { message, recovery_enabled }
 */
export async function enableRecoveryPhrase(recoveryEncryptedMasterKey, recoveryPhraseHash) {
  const payload = {
    recovery_encrypted_master_key: recoveryEncryptedMasterKey,
    recovery_phrase_hash: recoveryPhraseHash,
  };

  const response = await zkFetch(ZK_ENDPOINTS.RECOVERY_ENABLE, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Verify recovery phrase
 * @param {string} recoveryPhrase - Recovery phrase to verify
 * @returns {Promise<Object>} { valid, message }
 */
export async function verifyRecoveryPhrase(recoveryPhrase) {
  const payload = {
    recovery_phrase: recoveryPhrase,
  };

  const response = await zkFetch(ZK_ENDPOINTS.RECOVERY_VERIFY, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Recover account using recovery phrase (legacy - use recoverAccountWithNewPassword instead)
 * @param {string} email - User email
 * @param {string} recoveryPhrase - Recovery phrase
 * @returns {Promise<Object>} { access_token, encrypted_master_key, recovery_encrypted_master_key }
 */
export async function recoverAccount(email, recoveryPhrase) {
  const payload = {
    email,
    recovery_phrase: recoveryPhrase,
  };

  const response = await zkFetch(ZK_ENDPOINTS.RECOVERY_RECOVER, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Get recovery information for a user (public endpoint for recovery flow)
 * @param {string} email - User email
 * @returns {Promise<Object>} { recovery_enabled, recovery_encrypted_master_key, kdf_params }
 */
export async function getRecoveryInfo(email) {
  const url = `${ZK_ENDPOINTS.RECOVERY_INFO}?email=${encodeURIComponent(email)}`;

  const response = await zkFetch(url);
  return response;
}

/**
 * Recover account with recovery phrase and set new password
 * Full recovery flow that updates the user's password
 * @param {Object} recoveryData - Recovery data
 * @param {string} recoveryData.email - User email
 * @param {string} recoveryData.recoveryPhrase - Recovery phrase
 * @param {string} recoveryData.newPasswordHash - New password hash (SHA-256 of derived key)
 * @param {string} recoveryData.newEncryptedMasterKey - Master key re-encrypted with new password
 * @param {string} recoveryData.newKdfSalt - New KDF salt (hex)
 * @returns {Promise<Object>} { message, access_token, token_type }
 */
export async function recoverAccountWithNewPassword(recoveryData) {
  const payload = {
    email: recoveryData.email,
    recovery_phrase: recoveryData.recoveryPhrase,
    new_password_hash: recoveryData.newPasswordHash,
    new_encrypted_master_key: recoveryData.newEncryptedMasterKey,
    new_kdf_salt: recoveryData.newKdfSalt,
  };

  const response = await zkFetch(ZK_ENDPOINTS.RECOVERY_USE, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Rotate (replace) recovery phrase
 * @param {string} newRecoveryEncryptedMasterKey - Master key re-encrypted with new recovery phrase
 * @param {string} newRecoveryPhraseHash - Hash of new recovery phrase
 * @returns {Promise<Object>} { message, rotated_at, verified, instructions }
 */
export async function rotateRecoveryPhrase(newRecoveryEncryptedMasterKey, newRecoveryPhraseHash) {
  const payload = {
    new_recovery_encrypted_master_key: newRecoveryEncryptedMasterKey,
    new_recovery_phrase_hash: newRecoveryPhraseHash,
  };

  const response = await zkFetch(ZK_ENDPOINTS.RECOVERY_ROTATE, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== File Operations ====================

/**
 * Initialize encrypted file upload
 * @param {Object} uploadData - Upload initialization data
 * @returns {Promise<Object>} { upload_id, file_id, message }
 */
export async function initializeUpload(uploadData) {
  const payload = {
    // Encrypted filename (client-side encrypted)
    encrypted_file_name: uploadData.encryptedFileName,
    file_name_iv: uploadData.fileNameIV,
    file_size: uploadData.fileSize,
    mime_type: uploadData.mimeType,
    encrypted_file_key: uploadData.encryptedFileKey,
    file_key_iv: uploadData.fileKeyIV,
    encryption_algorithm: uploadData.encryptionAlgorithm,
    encryption_version: uploadData.encryptionVersion || 2, // Default to V2 (HKDF+AAD)
    chunk_size: uploadData.chunkSize,
    parent_folder_id: uploadData.parentFolderId || null,

    // ZK Thumbnail (client-side generated and encrypted)
    encrypted_thumbnail: uploadData.encryptedThumbnail || null,
    thumbnail_iv: uploadData.thumbnailIV || null,
    thumbnail_width: uploadData.thumbnailWidth || null,
    thumbnail_height: uploadData.thumbnailHeight || null,
  };

  const response = await zkFetch(ZK_ENDPOINTS.UPLOAD_INIT, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Upload encrypted chunk with retry logic for rate limiting
 * @param {string} uploadId - Upload ID from initialization
 * @param {number} chunkIndex - Chunk index
 * @param {Uint8Array} encryptedChunk - Encrypted chunk data
 * @param {string} chunkIV - Chunk IV (base64) - IV is embedded in the encrypted chunk
 * @param {number} retryCount - Current retry attempt (internal)
 * @returns {Promise<Object>} { message, chunk_index, status }
 */
export async function uploadChunk(uploadId, chunkIndex, encryptedChunk, chunkIV, retryCount = 0) {
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 2000; // 2 seconds base delay

  // Create FormData for multipart upload (backend expects file upload)
  const formData = new FormData();
  formData.append('chunk_index', chunkIndex.toString());

  // Create a Blob from the encrypted chunk data
  const chunkBlob = new Blob([encryptedChunk], { type: 'application/octet-stream' });
  formData.append('chunk', chunkBlob, `chunk_${chunkIndex}.enc`);

  // Build URL with upload_id in path: /upload/chunk/{upload_id}
  const url = `${ZK_ENDPOINTS.UPLOAD_CHUNK}/${uploadId}`;

  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include', // Include cookies for authentication
    body: formData,
    // Note: Don't set Content-Type header - browser will set it with multipart boundary
  });

  // Handle 429 Too Many Requests with retry
  if (response.status === 429) {
    if (retryCount >= MAX_RETRIES) {
      throw new UploadError(
        'Upload rate limit exceeded. Your plan limits have been reached. Please wait or upgrade your plan.',
        UPLOAD_ERROR_TYPES.RATE_LIMITED,
        { uploadId, chunkIndex, retryCount }
      );
    }

    // Get Retry-After header or use exponential backoff
    const retryAfter = response.headers.get('Retry-After');
    const delayMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : BASE_DELAY_MS * Math.pow(2, retryCount);

    console.log(`[Upload] Rate limited on chunk ${chunkIndex}, retrying in ${delayMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);

    await new Promise(resolve => setTimeout(resolve, delayMs));
    return uploadChunk(uploadId, chunkIndex, encryptedChunk, chunkIV, retryCount + 1);
  }

  // Handle 413 Storage Quota Exceeded
  if (response.status === 413) {
    const errorData = await response.json().catch(() => ({ detail: 'Storage quota exceeded' }));
    throw new UploadError(
      errorData.detail || 'Storage quota exceeded. Please free up space or upgrade your plan.',
      UPLOAD_ERROR_TYPES.QUOTA_EXCEEDED,
      { uploadId, chunkIndex }
    );
  }

  // Handle 401 Authentication errors
  if (response.status === 401) {
    throw new UploadError(
      'Authentication expired. Please log in again.',
      UPLOAD_ERROR_TYPES.AUTH,
      { uploadId, chunkIndex }
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Chunk upload failed' }));
    throw new UploadError(
      errorData.detail || errorData.message || 'Chunk upload failed',
      UPLOAD_ERROR_TYPES.UNKNOWN,
      { uploadId, chunkIndex, status: response.status }
    );
  }

  return response.json();
}

/**
 * Complete encrypted file upload
 * @param {string} uploadId - Upload ID
 * @param {string} fileHash - SHA-256 hash of original file
 * @param {number} totalChunks - Total number of chunks uploaded
 * @returns {Promise<Object>} { file_id, message }
 */
export async function completeUpload(uploadId, fileHash, totalChunks = 1) {
  const payload = {
    total_chunks: totalChunks,
    file_hash: fileHash,
  };

  // Build URL with upload_id in path: /upload/complete/{upload_id}
  const url = `${ZK_ENDPOINTS.UPLOAD_COMPLETE}/${uploadId}`;

  const response = await zkFetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * List encrypted files for current user
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum files to return
 * @param {number} [options.offset] - Offset for pagination
 * @param {string} [options.sortBy] - Sort field
 * @param {string} [options.sortOrder] - Sort order (asc/desc)
 * @returns {Promise<Object>} { files, total, limit, offset }
 */
export async function listFiles(options = {}) {
  const params = new URLSearchParams();

  if (options.limit) params.append('limit', options.limit);
  if (options.offset) params.append('offset', options.offset);
  if (options.sortBy) params.append('sort_by', options.sortBy);
  if (options.sortOrder) params.append('sort_order', options.sortOrder);

  const url = `${ZK_ENDPOINTS.FILES_LIST}?${params.toString()}`;
  const response = await zkFetch(url);

  return response;
}

/**
 * Get file metadata
 * @param {string} fileId - File ID
 * @returns {Promise<Object>} File metadata including encrypted_file_key
 */
export async function getFileMetadata(fileId) {
  const url = `${ZK_ENDPOINTS.FILE_METADATA}/${fileId}`;
  const response = await zkFetch(url);

  return response;
}

/**
 * Download encrypted file chunk
 * @param {string} fileId - File ID
 * @param {number} chunkIndex - Chunk index
 * @returns {Promise<Object>} { encrypted_data, chunk_iv }
 */
export async function downloadChunk(fileId, chunkIndex) {
  const url = `${ZK_ENDPOINTS.FILE_METADATA}/${fileId}/chunk/${chunkIndex}`;
  const response = await zkFetch(url);

  return response;
}

/**
 * Get storage usage statistics
 * @returns {Promise<Object>} Storage usage data
 */
export async function getStorageUsage() {
  const response = await zkFetch(ZK_ENDPOINTS.STORAGE_USAGE);
  return response;
}

/**
 * Delete encrypted file
 * @param {string} fileId - File ID to delete
 * @returns {Promise<Object>} { message }
 */
export async function deleteFile(fileId) {
  // Use FILES_LIST base URL - delete endpoint is /files/{file_id}
  const url = `${ZK_ENDPOINTS.FILES_LIST}/${fileId}`;
  const response = await zkFetch(url, {
    method: 'DELETE',
  });

  return response;
}

// ==================== Upload Management ====================

/**
 * Cancel an in-progress upload and clean up server-side resources
 * @param {string} uploadId - Upload ID to cancel
 * @returns {Promise<Object>} { message, upload_id }
 */
export async function cancelUpload(uploadId) {
  const url = `${ZK_ENDPOINTS.UPLOAD_CHUNK}/${uploadId}/cancel`;

  try {
    const response = await zkFetch(url, {
      method: 'POST',
    });
    console.log(`[Upload] Cancelled upload ${uploadId}:`, response);
    return response;
  } catch (error) {
    // Log but don't throw - cancellation is best-effort cleanup
    console.warn(`[Upload] Failed to cancel upload ${uploadId}:`, error.message);
    return { message: 'Cancel request sent', upload_id: uploadId };
  }
}

// ==================== Health Check ====================

/**
 * Check ZK service health
 * @returns {Promise<Object>} { status, message }
 */
export async function checkHealth() {
  const response = await zkFetch(ZK_ENDPOINTS.HEALTH);
  return response;
}

// ==================== Account Upgrade ====================

/**
 * Upgrade existing regular account to Zero-Knowledge encryption
 * @param {Object} upgradeData - Upgrade data
 * @param {string} upgradeData.passwordHash - SHA-256 hash of derived key
 * @param {string} upgradeData.encryptedMasterKey - Encrypted master key (base64)
 * @param {string} upgradeData.masterKeyIV - IV for AES-GCM (base64)
 * @param {string} upgradeData.kdfSalt - KDF salt (hex)
 * @param {string} upgradeData.kdfAlgorithm - KDF algorithm (pbkdf2 or argon2id)
 * @param {number} upgradeData.kdfIterations - KDF iterations
 * @param {number} upgradeData.kdfMemory - Argon2id memory parameter (optional)
 * @param {number} upgradeData.kdfParallelism - Argon2id parallelism parameter (optional)
 * @returns {Promise<Object>} { message, access_token, user }
 */
export async function upgradeToZK(upgradeData) {
  const payload = {
    password_hash: upgradeData.passwordHash,
    encrypted_master_key: upgradeData.encryptedMasterKey,
    master_key_iv: upgradeData.masterKeyIV,
    kdf_salt: upgradeData.kdfSalt,
    kdf_algorithm: upgradeData.kdfAlgorithm,
    kdf_iterations: upgradeData.kdfIterations,
    kdf_memory: upgradeData.kdfMemory,
    kdf_parallelism: upgradeData.kdfParallelism,
  };

  const response = await zkFetch(ZK_ENDPOINTS.UPGRADE_TO_ZK, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== Exports ====================

export default {
  // Error Types
  UploadError,
  UPLOAD_ERROR_TYPES,

  // KDF
  getKDFParams,

  // Authentication
  registerZK,
  loginZK,
  logout,

  // Status
  getZKStatus,

  // Recovery
  enableRecoveryPhrase,
  verifyRecoveryPhrase,
  recoverAccount,
  getRecoveryInfo,
  recoverAccountWithNewPassword,
  rotateRecoveryPhrase,

  // File Operations
  initializeUpload,
  uploadChunk,
  completeUpload,
  cancelUpload,
  listFiles,
  getFileMetadata,
  downloadChunk,
  deleteFile,
  getStorageUsage,

  // Health
  checkHealth,

  // Account Upgrade
  upgradeToZK,
};
