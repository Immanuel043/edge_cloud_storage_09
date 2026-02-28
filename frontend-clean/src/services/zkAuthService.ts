/**
 * Zero-Knowledge Authentication Service
 *
 * API calls to the ZK backend service for authentication and user management
 * All sensitive cryptographic operations happen client-side; this service
 * only handles network communication with the backend.
 */

import { ZK_ENDPOINTS, ZK_ERRORS } from '../config/constants';

// ==================== Custom Error Types ====================

/**
 * Upload error with specific error type for better handling
 */
export class UploadError extends Error {
  type: UploadErrorType;
  details: Record<string, unknown>;

  constructor(message: string, type: UploadErrorType, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UploadError';
    this.type = type;
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
} as const);

export type UploadErrorType = typeof UPLOAD_ERROR_TYPES[keyof typeof UPLOAD_ERROR_TYPES];

// ==================== Type Definitions ====================

export interface KDFParams {
  kdf_salt: string;
  kdf_algorithm: string;
  kdf_iterations: number;
  kdf_memory?: number;
  kdf_parallelism?: number;
  kdf_iv?: string;
}

export interface RegisterZKData {
  email: string;
  username: string;
  passwordHash: string;
  encryptedMasterKey: string;
  masterKeyIV: string;
  kdfSalt: string;
  kdfAlgorithm: string;
  kdfIterations: number;
  kdfMemory?: number;
  kdfParallelism?: number;
}

export interface LoginZKResponse {
  access_token: string;
  encrypted_master_key: string;
  master_key_iv: string;
  user_id: string;
  zk_enabled: boolean;
}

export interface ZKStatusResponse {
  zk_enabled: boolean;
  encryption_version: number;
  recovery_enabled: boolean;
  kdf_algorithm: string;
}

export interface RecoveryData {
  email: string;
  recoveryPhrase: string;
  newPasswordHash: string;
  newEncryptedMasterKey: string;
  newKdfSalt: string;
}

export interface UploadInitData {
  uploadId?: string; // V2: Pre-generated uploadId for AAD
  encryptedFileName: string;
  fileNameIV: string;
  fileSize: number;
  mimeType: string;
  encryptedFileKey: string;
  fileKeyIV: string;
  encryptionAlgorithm: string;
  encryptionVersion?: number;
  chunkSize: number;
  parentFolderId?: string | null;
  encryptedThumbnail?: string | null;
  thumbnailIV?: string | null;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
}

export interface UploadInitResponse {
  upload_id: string;
  file_id: string;
  message: string;
}

export interface ListFilesOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface FileMetadata {
  file_id: string;
  encrypted_file_name: string;
  file_name_iv: string;
  file_size: number;
  mime_type: string;
  encrypted_file_key: string;
  file_key_iv: string;
  encryption_algorithm: string;
  encryption_version: number;
  created_at: string;
  chunk_size: number;
}

export interface UpgradeToZKData {
  passwordHash: string;
  encryptedMasterKey: string;
  masterKeyIV: string;
  kdfSalt: string;
  kdfAlgorithm: string;
  kdfIterations: number;
  kdfMemory?: number;
  kdfParallelism?: number;
}

export interface RegisterZKResponse {
  message: string;
  user_id: string;
  access_token: string;
}

export interface UpgradeToZKResponse {
  message: string;
  access_token: string;
  user: {
    user_id: string;
    email: string;
    username: string;
    zk_enabled: boolean;
  };
}

// FastAPI validation error detail
interface ValidationErrorDetail {
  loc: (string | number)[];
  msg: string;
  type: string;
}

// Generic API error response
interface APIErrorResponse {
  error?: {
    code: number;
    message: string;
  };
  detail?: string | ValidationErrorDetail[];
  message?: string;
}

// ==================== Helper Functions ====================

interface FetchOptions extends RequestInit {
  headers?: Record<string, string>;
}

/**
 * Make an authenticated API request to ZK service
 */
async function zkFetch<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const defaultOptions: FetchOptions = {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include', // Include cookies for session management
  };

  const mergedOptions: FetchOptions = {
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
    let data: string | Record<string, unknown>;

    if (contentType?.includes('application/json')) {
      data = await response.json() as Record<string, unknown>;
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      // Extract error message from response
      let errorMessage = 'Unknown error';
      if (typeof data === 'string') {
        errorMessage = data;
      } else {
        const errorData = data as APIErrorResponse;
        if (errorData?.error?.message) {
          // Handle custom ZK service error format: {"error": {"code": 400, "message": "..."}}
          errorMessage = errorData.error.message;
        } else if (errorData?.detail) {
          // Handle FastAPI validation errors (array of error objects)
          if (Array.isArray(errorData.detail)) {
            errorMessage = errorData.detail.map((e: ValidationErrorDetail) => e.msg || JSON.stringify(e)).join(', ');
          } else if (typeof errorData.detail === 'string') {
            errorMessage = errorData.detail;
          } else {
            errorMessage = JSON.stringify(errorData.detail);
          }
        } else if (errorData?.message) {
          errorMessage = typeof errorData.message === 'string' ? errorData.message : JSON.stringify(errorData.message);
        }
      }
      throw new Error(errorMessage);
    }

    return data as T;
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
 */
export async function getKDFParams(email: string): Promise<KDFParams | null> {
  const url = `${ZK_ENDPOINTS.KDF_PARAMS}?email=${encodeURIComponent(email)}`;

  try {
    const response = await zkFetch<KDFParams>(url);
    return response;
  } catch (error) {
    // 404 is expected for new users
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('404') || errorMessage.includes('not found')) {
      return null;
    }
    throw error;
  }
}

// ==================== Registration ====================

/**
 * Register a new ZK user
 */
export async function registerZK(registrationData: RegisterZKData): Promise<RegisterZKResponse> {
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

  const response = await zkFetch<RegisterZKResponse>(ZK_ENDPOINTS.REGISTER_ZK, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== Login ====================

/**
 * Login with ZK credentials
 */
export async function loginZK(email: string, passwordHash: string): Promise<LoginZKResponse> {
  const payload = {
    email,
    password_hash: passwordHash,
  };

  const response = await zkFetch<LoginZKResponse>(ZK_ENDPOINTS.LOGIN_ZK, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== Logout ====================

/**
 * Logout current user
 */
export async function logout(): Promise<{ message: string }> {
  const response = await zkFetch<{ message: string }>(ZK_ENDPOINTS.LOGOUT, {
    method: 'POST',
  });

  return response;
}

// ==================== User Profile & Status ====================

/**
 * User profile response from ZK service
 */
export interface ZKUserProfile {
  id: string;
  email: string;
  username: string;
  plan_type: string;
  storage_quota: number;
  storage_used: number;
  zk_enabled: boolean;
  recovery_phrase_enabled: boolean;
  created_at: string;
}

/**
 * Get current user's profile from ZK service
 * This is the ZK-equivalent of authService.getProfile()
 */
export async function getProfile(): Promise<ZKUserProfile> {
  const response = await zkFetch<ZKUserProfile>(ZK_ENDPOINTS.ME);
  return response;
}

/**
 * Get current user's ZK status
 */
export async function getZKStatus(): Promise<ZKStatusResponse> {
  const response = await zkFetch<ZKStatusResponse>(ZK_ENDPOINTS.STATUS);
  return response;
}

// ==================== Recovery Phrase ====================

/**
 * Enable recovery phrase for current user
 */
export async function enableRecoveryPhrase(
  recoveryEncryptedMasterKey: string,
  recoveryPhraseHash: string
): Promise<{ message: string; recovery_enabled: boolean }> {
  const payload = {
    recovery_encrypted_master_key: recoveryEncryptedMasterKey,
    recovery_phrase_hash: recoveryPhraseHash,
  };

  const response = await zkFetch<{ message: string; recovery_enabled: boolean }>(ZK_ENDPOINTS.RECOVERY_ENABLE, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Verify recovery phrase
 */
export async function verifyRecoveryPhrase(recoveryPhrase: string): Promise<{ valid: boolean; message: string }> {
  const payload = {
    recovery_phrase: recoveryPhrase,
  };

  const response = await zkFetch<{ valid: boolean; message: string }>(ZK_ENDPOINTS.RECOVERY_VERIFY, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Recover account using recovery phrase (legacy - use recoverAccountWithNewPassword instead)
 */
export async function recoverAccount(
  email: string,
  recoveryPhrase: string
): Promise<{ access_token: string; encrypted_master_key: string; recovery_encrypted_master_key: string }> {
  const payload = {
    email,
    recovery_phrase: recoveryPhrase,
  };

  const response = await zkFetch<{ access_token: string; encrypted_master_key: string; recovery_encrypted_master_key: string }>(ZK_ENDPOINTS.RECOVERY_RECOVER, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Get recovery information for a user (public endpoint for recovery flow)
 */
export async function getRecoveryInfo(
  email: string
): Promise<{ recovery_enabled: boolean; recovery_encrypted_master_key: string; kdf_params: KDFParams }> {
  const url = `${ZK_ENDPOINTS.RECOVERY_INFO}?email=${encodeURIComponent(email)}`;

  const response = await zkFetch<{ recovery_enabled: boolean; recovery_encrypted_master_key: string; kdf_params: KDFParams }>(url);
  return response;
}

/**
 * Recover account with recovery phrase and set new password
 * Full recovery flow that updates the user's password
 *
 * TODO: Implement client-side recovery key derivation. Currently the recovery
 * phrase is needed server-side for account recovery verification. A proper ZK
 * implementation would derive the master key from the phrase client-side and
 * only send encrypted artifacts to the server. The recovery_phrase should be
 * removed from the payload once the backend supports verification via a
 * recovery_phrase_hash instead of the raw phrase.
 */
export async function recoverAccountWithNewPassword(
  recoveryData: RecoveryData
): Promise<{ message: string; access_token: string; token_type: string }> {
  const payload = {
    email: recoveryData.email,
    recovery_phrase: recoveryData.recoveryPhrase,
    new_password_hash: recoveryData.newPasswordHash,
    new_encrypted_master_key: recoveryData.newEncryptedMasterKey,
    new_kdf_salt: recoveryData.newKdfSalt,
  };

  const response = await zkFetch<{ message: string; access_token: string; token_type: string }>(ZK_ENDPOINTS.RECOVERY_USE, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Rotate (replace) recovery phrase
 */
export async function rotateRecoveryPhrase(
  newRecoveryEncryptedMasterKey: string,
  newRecoveryPhraseHash: string
): Promise<{ message: string; rotated_at: string; verified: boolean; instructions: string }> {
  const payload = {
    new_recovery_encrypted_master_key: newRecoveryEncryptedMasterKey,
    new_recovery_phrase_hash: newRecoveryPhraseHash,
  };

  const response = await zkFetch<{ message: string; rotated_at: string; verified: boolean; instructions: string }>(ZK_ENDPOINTS.RECOVERY_ROTATE, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

// ==================== File Operations ====================

/**
 * Initialize encrypted file upload
 */
export async function initializeUpload(uploadData: UploadInitData): Promise<UploadInitResponse> {
  const payload = {
    // V2: Pre-generated uploadId for AAD (optional)
    ...(uploadData.uploadId && { upload_id: uploadData.uploadId }),

    // Encrypted filename (client-side encrypted)
    encrypted_file_name: uploadData.encryptedFileName,
    file_name_iv: uploadData.fileNameIV,
    file_size: uploadData.fileSize,
    mime_type: uploadData.mimeType,
    encrypted_file_key: uploadData.encryptedFileKey,
    file_key_iv: uploadData.fileKeyIV,
    encryption_algorithm: uploadData.encryptionAlgorithm,
    encryption_version: uploadData.encryptionVersion ?? 2, // Default to V2 (HKDF+AAD)
    chunk_size: uploadData.chunkSize,
    parent_folder_id: uploadData.parentFolderId ?? null,

    // ZK Thumbnail (client-side generated and encrypted)
    encrypted_thumbnail: uploadData.encryptedThumbnail ?? null,
    thumbnail_iv: uploadData.thumbnailIV ?? null,
    thumbnail_width: uploadData.thumbnailWidth ?? null,
    thumbnail_height: uploadData.thumbnailHeight ?? null,
  };

  const response = await zkFetch<UploadInitResponse>(ZK_ENDPOINTS.UPLOAD_INIT, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Upload encrypted chunk with retry logic for rate limiting
 */
export async function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  encryptedChunk: Uint8Array,
  chunkIV: string,
  retryCount = 0
): Promise<{ message: string; chunk_index: number; status: string }> {
  const MAX_RETRIES = 10;
  const BASE_DELAY_MS = 2000; // 2 seconds base delay

  // Create FormData for multipart upload (backend expects file upload)
  const formData = new FormData();
  formData.append('chunk_index', chunkIndex.toString());

  // Create a Blob from the encrypted chunk data
  const chunkBlob = new Blob([encryptedChunk as BlobPart], { type: 'application/octet-stream' });
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

    console.log(
      `[Upload] Rate limited on chunk ${chunkIndex}, retrying in ${delayMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    throw new UploadError('Authentication expired. Please log in again.', UPLOAD_ERROR_TYPES.AUTH, {
      uploadId,
      chunkIndex,
    });
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
 */
export async function completeUpload(
  uploadId: string,
  fileHash: string,
  totalChunks = 1
): Promise<{ file_id: string; message: string }> {
  const payload = {
    total_chunks: totalChunks,
    file_hash: fileHash,
  };

  // Build URL with upload_id in path: /upload/complete/{upload_id}
  const url = `${ZK_ENDPOINTS.UPLOAD_COMPLETE}/${uploadId}`;

  const response = await zkFetch<{ file_id: string; message: string }>(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * List encrypted files for current user
 */
export async function listFiles(
  options: ListFilesOptions = {}
): Promise<{ files: FileMetadata[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();

  if (options.limit) params.append('limit', options.limit.toString());
  if (options.offset) params.append('offset', options.offset.toString());
  if (options.sortBy) params.append('sort_by', options.sortBy);
  if (options.sortOrder) params.append('sort_order', options.sortOrder);

  const url = `${ZK_ENDPOINTS.FILES_LIST}?${params.toString()}`;
  const response = await zkFetch<{ files: FileMetadata[]; total: number; limit: number; offset: number }>(url);

  return response;
}

/**
 * Get file metadata
 */
export async function getFileMetadata(fileId: string): Promise<FileMetadata> {
  const url = `${ZK_ENDPOINTS.FILE_METADATA}/${fileId}`;
  const response = await zkFetch<FileMetadata>(url);

  return response;
}

/**
 * Download encrypted file chunk
 */
export async function downloadChunk(
  fileId: string,
  chunkIndex: number
): Promise<{ encrypted_data: string; chunk_iv: string }> {
  const url = `${ZK_ENDPOINTS.FILE_METADATA}/${fileId}/chunk/${chunkIndex}`;
  const response = await zkFetch<{ encrypted_data: string; chunk_iv: string }>(url);

  return response;
}

/**
 * Get storage usage statistics
 */
export async function getStorageUsage(): Promise<{ storage_used: number; storage_quota: number; file_count: number }> {
  const response = await zkFetch<{ storage_used: number; storage_quota: number; file_count: number }>(ZK_ENDPOINTS.STORAGE_USAGE);
  return response;
}

/**
 * Delete encrypted file
 */
export async function deleteFile(fileId: string): Promise<{ message: string }> {
  // Use FILES_LIST base URL - delete endpoint is /files/{file_id}
  const url = `${ZK_ENDPOINTS.FILES_LIST}/${fileId}`;
  const response = await zkFetch<{ message: string }>(url, {
    method: 'DELETE',
  });

  return response;
}

// ==================== Trash Operations ====================

/**
 * Get trashed files for current ZK user
 */
export async function getTrash(): Promise<{ files: FileMetadata[] }> {
  const url = `${ZK_ENDPOINTS.FILES_LIST}?is_deleted=true&limit=500`;
  const response = await zkFetch<{ files: FileMetadata[] }>(url);
  return response;
}

/**
 * Restore a file from trash
 */
export async function restoreFromTrash(fileId: string): Promise<{ message: string }> {
  const url = `${ZK_ENDPOINTS.FILES_LIST}/${fileId}/restore`;
  const response = await zkFetch<{ message: string }>(url, {
    method: 'POST',
  });
  return response;
}

/**
 * Permanently delete a file (bypasses trash)
 */
export async function permanentDelete(fileId: string): Promise<{ message: string }> {
  const url = `${ZK_ENDPOINTS.FILES_LIST}/${fileId}?permanent=true`;
  const response = await zkFetch<{ message: string }>(url, {
    method: 'DELETE',
  });
  return response;
}

/**
 * Empty all files from trash
 */
export async function emptyTrash(): Promise<{ message: string }> {
  const url = `${ZK_ENDPOINTS.FILES_LIST}/empty-trash`;
  const response = await zkFetch<{ message: string }>(url, {
    method: 'POST',
  });
  return response;
}

// ==================== Upload Management ====================

/**
 * Cancel an in-progress upload and clean up server-side resources
 */
export async function cancelUpload(uploadId: string): Promise<{ message: string; upload_id: string }> {
  const url = `${ZK_ENDPOINTS.UPLOAD_CHUNK}/${uploadId}/cancel`;

  try {
    const response = await zkFetch<{ message: string; upload_id: string }>(url, {
      method: 'POST',
    });
    console.log(`[Upload] Cancelled upload ${uploadId}:`, response);
    return response;
  } catch (error) {
    // Log but don't throw - cancellation is best-effort cleanup
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[Upload] Failed to cancel upload ${uploadId}:`, errorMessage);
    return { message: 'Cancel request sent', upload_id: uploadId };
  }
}

// ==================== Health Check ====================

/**
 * Check ZK service health
 */
export async function checkHealth(): Promise<{ status: string; message: string }> {
  const response = await zkFetch<{ status: string; message: string }>(ZK_ENDPOINTS.HEALTH);
  return response;
}

// ==================== Account Upgrade ====================

/**
 * Upgrade existing regular account to Zero-Knowledge encryption
 */
export async function upgradeToZK(upgradeData: UpgradeToZKData): Promise<UpgradeToZKResponse> {
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

  const response = await zkFetch<UpgradeToZKResponse>(ZK_ENDPOINTS.UPGRADE_TO_ZK, {
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

  // Profile & Status
  getProfile,
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

  // Trash Operations
  getTrash,
  restoreFromTrash,
  permanentDelete,
  emptyTrash,

  // Health
  checkHealth,

  // Account Upgrade
  upgradeToZK,
};
