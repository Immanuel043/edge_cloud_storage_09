/**
 * Application Constants
 *
 * Centralized constants for networking, file handling, encryption configuration,
 * and Zero-Knowledge (ZK) encryption settings.
 */

// ==================== Networking ====================

/**
 * Remove trailing slashes from URL
 */
function normalizeUrl(url: string | undefined, defaultUrl: string): string {
  const value = url?.replace(/\/+$/, '') || defaultUrl;
  return value;
}

/** Main API URL for the Normal Storage Service */
export const API_URL: string = normalizeUrl(
  import.meta.env.VITE_API_URL,
  'http://localhost:8001'
);

/** WebSocket URL for real-time communication (Normal service) */
export const WS_URL: string = normalizeUrl(
  import.meta.env.VITE_WS_URL,
  'ws://localhost:8001'
);

/** Zero-Knowledge Encryption Service URL */
export const ZK_SERVICE_URL: string = normalizeUrl(
  import.meta.env.VITE_ZK_SERVICE_URL,
  'http://localhost:8002'
);

/** WebSocket URL for ZK service real-time communication */
export const ZK_WS_URL: string = normalizeUrl(
  import.meta.env.VITE_ZK_WS_URL,
  'ws://localhost:8002'
);

// ==================== Size Constants ====================

/** Mebibyte (1024 * 1024 bytes) */
export const MiB: number = 1024 * 1024;

/** Gibibyte (1024 * MiB) */
export const GiB: number = 1024 * MiB;

/** Default chunk size for uploads (64 MiB) */
export const CHUNK_SIZE: number = 64 * MiB;

/** Maximum file size allowed (20 GiB) */
export const MAX_FILE_SIZE: number = 20 * GiB;

// ==================== Storage Tiers ====================

/** Storage tier configuration */
export interface StorageTiersConfig {
  readonly CACHE_DAYS: number;
  readonly WARM_DAYS: number;
  readonly COLD_DAYS: number;
}

/** Storage tier thresholds in days */
export const STORAGE_TIERS = {
  CACHE_DAYS: 1,
  WARM_DAYS: 7,
  COLD_DAYS: 30,
} as const satisfies StorageTiersConfig;

// ==================== File Categories ====================

/** File category type */
export type FileCategory = 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'AUDIO' | 'ARCHIVE' | 'CODE' | 'OTHER';

/** File extensions by category */
export interface FileCategoriesMap {
  readonly IMAGE: readonly string[];
  readonly DOCUMENT: readonly string[];
  readonly VIDEO: readonly string[];
  readonly AUDIO: readonly string[];
  readonly ARCHIVE: readonly string[];
  readonly CODE: readonly string[];
}

/** File category to extensions mapping */
export const FILE_CATEGORIES = {
  IMAGE: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'],
  DOCUMENT: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'],
  VIDEO: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'],
  AUDIO: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'],
  ARCHIVE: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
  CODE: ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'go', 'rs'],
} as const satisfies FileCategoriesMap;

/**
 * Get the file category for a given extension
 * @param ext - File extension (with or without leading dot)
 * @returns The file category or 'OTHER' if not found
 */
export function getFileCategory(ext: string = ''): FileCategory {
  const normalizedExt = ext.toLowerCase().replace(/^\./, '');

  for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
    if ((extensions as readonly string[]).includes(normalizedExt)) {
      return category as FileCategory;
    }
  }

  return 'OTHER';
}

// ==================== Rate Limiting ====================

/** Rate limit configuration */
export interface RateLimitConfig {
  readonly MAX_REQUESTS: number;
  readonly TIME_WINDOW: number;
}

/** Client-side rate limit defaults */
export const RATE_LIMIT = {
  MAX_REQUESTS: 10,
  TIME_WINDOW: 1000, // ms
} as const satisfies RateLimitConfig;

// ==================== Common Endpoints ====================

/** Common API endpoints */
export interface EndpointsConfig {
  readonly LOGIN: string;
  readonly REFRESH: string;
  readonly UPLOAD_INIT: string;
  readonly WS_PATH: string;
}

/** Common API endpoints */
export const ENDPOINTS = {
  LOGIN: `${API_URL}/api/v1/auth/login`,
  REFRESH: `${API_URL}/api/v1/auth/refresh`,
  UPLOAD_INIT: `${API_URL}/api/v1/upload/init`,
  WS_PATH: `${WS_URL}/ws`,
} as const satisfies EndpointsConfig;

// ==================== Zero-Knowledge Encryption ====================

/** ZK Service endpoint configuration */
export interface ZKEndpointsConfig {
  // Authentication
  readonly REGISTER_ZK: string;
  readonly LOGIN_ZK: string;
  readonly LOGOUT: string;
  readonly KDF_PARAMS: string;
  readonly UPGRADE_TO_ZK: string;
  // User & Status
  readonly ME: string;
  readonly STATUS: string;
  // Recovery
  readonly RECOVERY_ENABLE: string;
  readonly RECOVERY_VERIFY: string;
  readonly RECOVERY_RECOVER: string;
  readonly RECOVERY_USE: string;
  readonly RECOVERY_INFO: string;
  readonly RECOVERY_ROTATE: string;
  // File Operations
  readonly UPLOAD_INIT: string;
  readonly UPLOAD_CHUNK: string;
  readonly UPLOAD_COMPLETE: string;
  readonly FILES_LIST: string;
  readonly FILE_METADATA: string;
  readonly STORAGE_USAGE: string;
  // Health
  readonly HEALTH: string;
}

/** ZK Service Endpoints */
export const ZK_ENDPOINTS = {
  // Authentication
  REGISTER_ZK: `${ZK_SERVICE_URL}/api/v1/zk/register-zk`,
  LOGIN_ZK: `${ZK_SERVICE_URL}/api/v1/zk/login-zk`,
  LOGOUT: `${ZK_SERVICE_URL}/api/v1/zk/logout`,
  KDF_PARAMS: `${ZK_SERVICE_URL}/api/v1/zk/kdf-params`,
  UPGRADE_TO_ZK: `${ZK_SERVICE_URL}/api/v1/zk/upgrade-to-zk`,

  // User & Status
  ME: `${ZK_SERVICE_URL}/api/v1/zk/me`,
  STATUS: `${ZK_SERVICE_URL}/api/v1/zk/status`,

  // Recovery
  RECOVERY_ENABLE: `${ZK_SERVICE_URL}/api/v1/zk/recovery/enable`,
  RECOVERY_VERIFY: `${ZK_SERVICE_URL}/api/v1/zk/recovery/verify`,
  RECOVERY_RECOVER: `${ZK_SERVICE_URL}/api/v1/zk/recovery/recover`,
  RECOVERY_USE: `${ZK_SERVICE_URL}/api/v1/zk/recovery/use`,
  RECOVERY_INFO: `${ZK_SERVICE_URL}/api/v1/zk/recovery/info`,
  RECOVERY_ROTATE: `${ZK_SERVICE_URL}/api/v1/zk/recovery/rotate`,

  // File Operations
  UPLOAD_INIT: `${ZK_SERVICE_URL}/api/v1/zk/upload/init`,
  UPLOAD_CHUNK: `${ZK_SERVICE_URL}/api/v1/zk/upload/chunk`,
  UPLOAD_COMPLETE: `${ZK_SERVICE_URL}/api/v1/zk/upload/complete`,
  FILES_LIST: `${ZK_SERVICE_URL}/api/v1/zk/files`,
  FILE_METADATA: `${ZK_SERVICE_URL}/api/v1/zk/file`,
  STORAGE_USAGE: `${ZK_SERVICE_URL}/api/v1/zk/storage/usage`,

  // Health
  HEALTH: `${ZK_SERVICE_URL}/health`,
} as const satisfies ZKEndpointsConfig;

// ==================== ZK Encryption Configuration ====================

/** ZK encryption configuration */
export interface ZKConfigType {
  // Key Derivation
  readonly KDF_ALGORITHM: string;
  readonly KDF_ITERATIONS: number;
  readonly PBKDF2_KEY_LENGTH: number;
  // Encryption
  readonly ENCRYPTION_ALGORITHM: string;
  readonly AES_KEY_LENGTH: number;
  readonly GCM_IV_LENGTH: number;
  readonly GCM_TAG_LENGTH: number;
  // Recovery
  readonly RECOVERY_PHRASE_WORDS: number;
  readonly RECOVERY_PHRASE_STRENGTH: number;
  // Chunk Processing
  readonly ZK_CHUNK_SIZE: number;
  readonly MAX_CONCURRENT_CHUNKS: number;
  // Session
  readonly SESSION_TIMEOUT: number;
  readonly SESSION_WARNING_TIME: number;
  // Performance
  readonly USE_WEB_WORKERS: boolean;
  readonly WORKER_POOL_SIZE: number;
}

/** ZK Encryption Configuration */
export const ZK_CONFIG = {
  // Key Derivation
  KDF_ALGORITHM: 'pbkdf2',
  KDF_ITERATIONS: 600000,
  PBKDF2_KEY_LENGTH: 32, // 256 bits

  // Encryption
  ENCRYPTION_ALGORITHM: 'AES-256-GCM',
  AES_KEY_LENGTH: 32, // 256 bits
  GCM_IV_LENGTH: 12, // 96 bits
  GCM_TAG_LENGTH: 16, // 128 bits

  // Recovery
  RECOVERY_PHRASE_WORDS: 24, // BIP39 mnemonic
  RECOVERY_PHRASE_STRENGTH: 256, // bits

  // Chunk Processing
  ZK_CHUNK_SIZE: 64 * MiB, // Match backend chunk size
  MAX_CONCURRENT_CHUNKS: 4, // Parallel chunk uploads

  // Session
  SESSION_TIMEOUT: 30 * 60 * 1000, // 30 minutes (ms)
  SESSION_WARNING_TIME: 5 * 60 * 1000, // 5 minutes before timeout

  // Performance
  USE_WEB_WORKERS: true, // Use Web Workers for encryption (if available)
  WORKER_POOL_SIZE: 2, // Number of crypto workers
} as const satisfies ZKConfigType;

// ==================== ZK Feature Flags ====================

/** ZK feature flags configuration */
export interface ZKFeaturesConfig {
  readonly ENABLED: boolean;
  readonly REQUIRED: boolean;
  readonly RECOVERY_PHRASE: boolean;
  readonly HARDWARE_KEYS: boolean;
  readonly SOCIAL_RECOVERY: boolean;
  readonly BIOMETRIC_UNLOCK: boolean;
}

/** ZK Feature Flags */
export const ZK_FEATURES = {
  ENABLED: import.meta.env.VITE_ZK_ENABLED !== 'false', // ZK encryption available
  REQUIRED: import.meta.env.VITE_ZK_REQUIRED === 'true', // Force ZK for all users
  RECOVERY_PHRASE: true, // BIP39 recovery phrase support
  HARDWARE_KEYS: true, // Hardware key support (FIDO2/WebAuthn) - ENABLED
  SOCIAL_RECOVERY: false, // Social recovery (future)
  BIOMETRIC_UNLOCK: false, // Biometric unlock (future)
} as const satisfies ZKFeaturesConfig;

// ==================== ZK Storage Keys ====================

/** ZK storage keys configuration */
export interface ZKStorageConfig {
  // LocalStorage keys (for non-sensitive data only)
  readonly ZK_ENABLED_KEY: string;
  readonly ZK_EMAIL_KEY: string;
  readonly RECOVERY_ENABLED_KEY: string;
  // Encrypted data (safe to store - encrypted with password-derived key)
  readonly ZK_DATA_KEY: string;
  // Session storage keys
  readonly SESSION_UNLOCKED_KEY: string;
  readonly SESSION_TIMESTAMP_KEY: string;
}

/** ZK Storage Settings */
export const ZK_STORAGE = {
  // LocalStorage keys (for non-sensitive data only)
  ZK_ENABLED_KEY: 'zkEnabled',
  ZK_EMAIL_KEY: 'zkEmail',
  RECOVERY_ENABLED_KEY: 'zkRecoveryEnabled',
  // Encrypted data (safe to store - encrypted with password-derived key)
  ZK_DATA_KEY: 'zkData',

  // Session storage keys
  SESSION_UNLOCKED_KEY: 'zkSessionUnlocked',
  SESSION_TIMESTAMP_KEY: 'zkSessionTimestamp',
} as const satisfies ZKStorageConfig;

// ==================== ZK Error Messages ====================

/** ZK error messages configuration */
export interface ZKErrorsConfig {
  readonly SESSION_LOCKED: string;
  readonly INVALID_PASSWORD: string;
  readonly INVALID_RECOVERY_PHRASE: string;
  readonly DECRYPTION_FAILED: string;
  readonly ENCRYPTION_FAILED: string;
  readonly SESSION_EXPIRED: string;
  readonly NETWORK_ERROR: string;
  readonly MASTER_KEY_MISSING: string;
}

/** ZK Error Messages */
export const ZK_ERRORS = {
  SESSION_LOCKED: 'Your encryption session is locked. Please unlock to continue.',
  INVALID_PASSWORD: 'Invalid password. Please try again.',
  INVALID_RECOVERY_PHRASE: 'Invalid recovery phrase. Please check and try again.',
  DECRYPTION_FAILED: 'Failed to decrypt file. The file may be corrupted or you may not have access.',
  ENCRYPTION_FAILED: 'Failed to encrypt file. Please try again.',
  SESSION_EXPIRED: 'Your encryption session has expired. Please log in again.',
  NETWORK_ERROR: 'Network error. Please check your connection and try again.',
  MASTER_KEY_MISSING: 'Master encryption key not found. Please log in again.',
} as const satisfies ZKErrorsConfig;

// ==================== ZK Upload Modes ====================

/** ZK upload mode type */
export type ZKUploadModeType = 'standard' | 'encrypted' | 'hybrid';

/** ZK upload modes configuration */
export interface ZKUploadModeConfig {
  readonly STANDARD: ZKUploadModeType;
  readonly ENCRYPTED: ZKUploadModeType;
  readonly HYBRID: ZKUploadModeType;
}

/** ZK Upload Modes */
export const ZK_UPLOAD_MODE = {
  STANDARD: 'standard', // Regular upload (no encryption)
  ENCRYPTED: 'encrypted', // ZK encrypted upload
  HYBRID: 'hybrid', // Support both modes
} as const satisfies ZKUploadModeConfig;
