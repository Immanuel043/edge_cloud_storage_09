/**
 * Zero-Knowledge Authentication Service
 *
 * API calls to the ZK backend service for authentication and user management.
 * All sensitive cryptographic operations happen client-side; this service
 * only handles network communication with the backend.
 */

import { ZK_ENDPOINTS, ZK_ERRORS } from '../config/constants.js';

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
      const errorMessage = data?.detail || data?.message || data || 'Unknown error';
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
 * @param {string} registrationData.kdfAlgorithm - KDF algorithm
 * @param {number} registrationData.kdfIterations - KDF iterations
 * @returns {Promise<Object>} { user_id, access_token, message }
 */
export async function registerZK(registrationData) {
  const payload = {
    email: registrationData.email,
    username: registrationData.username,
    password_hash: registrationData.passwordHash,
    encrypted_master_key: registrationData.encryptedMasterKey,
    kdf_salt: registrationData.kdfSalt,
    kdf_algorithm: registrationData.kdfAlgorithm,
    kdf_iterations: registrationData.kdfIterations,
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
 * Recover account using recovery phrase
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

// ==================== File Operations ====================

/**
 * Initialize encrypted file upload
 * @param {Object} uploadData - Upload initialization data
 * @returns {Promise<Object>} { upload_id, file_id, message }
 */
export async function initializeUpload(uploadData) {
  const payload = {
    filename: uploadData.fileName,
    file_size: uploadData.fileSize,
    mime_type: uploadData.mimeType,
    encrypted_file_key: uploadData.encryptedFileKey,
    file_key_iv: uploadData.fileKeyIV,
    encryption_algorithm: uploadData.encryptionAlgorithm,
    chunk_size: uploadData.chunkSize,
    parent_folder_id: uploadData.parentFolderId || null,
  };

  const response = await zkFetch(ZK_ENDPOINTS.UPLOAD_INIT, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Upload encrypted chunk
 * @param {string} uploadId - Upload ID from initialization
 * @param {number} chunkIndex - Chunk index
 * @param {Uint8Array} encryptedChunk - Encrypted chunk data
 * @param {string} chunkIV - Chunk IV (base64)
 * @returns {Promise<Object>} { message, chunk_index, status }
 */
export async function uploadChunk(uploadId, chunkIndex, encryptedChunk, chunkIV) {
  // Convert Uint8Array to base64
  const base64Chunk = btoa(String.fromCharCode(...encryptedChunk));

  const payload = {
    upload_id: uploadId,
    chunk_index: chunkIndex,
    encrypted_data: base64Chunk,
    chunk_iv: chunkIV,
  };

  const response = await zkFetch(ZK_ENDPOINTS.UPLOAD_CHUNK, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Complete encrypted file upload
 * @param {string} uploadId - Upload ID
 * @param {string} fileHash - SHA-256 hash of original file
 * @returns {Promise<Object>} { file_id, message }
 */
export async function completeUpload(uploadId, fileHash) {
  const payload = {
    upload_id: uploadId,
    file_hash: fileHash,
  };

  const response = await zkFetch(ZK_ENDPOINTS.UPLOAD_COMPLETE, {
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
  const url = `${ZK_ENDPOINTS.FILE_METADATA}/${fileId}`;
  const response = await zkFetch(url, {
    method: 'DELETE',
  });

  return response;
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

// ==================== Exports ====================

export default {
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

  // File Operations
  initializeUpload,
  uploadChunk,
  completeUpload,
  listFiles,
  getFileMetadata,
  downloadChunk,
  deleteFile,
  getStorageUsage,

  // Health
  checkHealth,
};
