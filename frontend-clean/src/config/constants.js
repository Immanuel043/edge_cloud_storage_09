// Networking
export const API_URL =
  (import.meta.env.VITE_API_URL && import.meta.env.VITE_API_URL.replace(/\/+$/, "")) ||
  "http://localhost:3001"; // no trailing slash

export const WS_URL =
  (import.meta.env.VITE_WS_URL && import.meta.env.VITE_WS_URL.replace(/\/+$/, "")) ||
  "ws://localhost:3001"; // no trailing slash

export const ZK_SERVICE_URL =
  (import.meta.env.VITE_ZK_SERVICE_URL && import.meta.env.VITE_ZK_SERVICE_URL.replace(/\/+$/, "")) ||
  "http://localhost:8002"; // Zero-Knowledge Encryption Service

// Sizes
export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

export const CHUNK_SIZE = 64 * MiB;         // 64 MiB
export const MAX_FILE_SIZE = 20 * GiB;      // 20 GiB

// Storage tiers
export const STORAGE_TIERS = Object.freeze({
  CACHE_DAYS: 1,
  WARM_DAYS: 7,
  COLD_DAYS: 30,
});

// File categories & helper
export const FILE_CATEGORIES = Object.freeze({
  IMAGE:    ["jpg","jpeg","png","gif","bmp","svg","webp","ico"],
  DOCUMENT: ["pdf","doc","docx","txt","rtf","odt","xls","xlsx","csv","ppt","pptx"],
  VIDEO:    ["mp4","avi","mkv","mov","wmv","flv","webm"],
  AUDIO:    ["mp3","wav","flac","aac","ogg","wma"],
  ARCHIVE:  ["zip","rar","7z","tar","gz","bz2"],
  CODE:     ["js","jsx","ts","tsx","html","css","json","xml","py","java","cpp","c","go","rs"],
});

export function getFileCategory(ext = "") {
  const e = ext.toLowerCase().replace(/^\./, "");
  for (const [cat, list] of Object.entries(FILE_CATEGORIES)) {
    if (list.includes(e)) return cat;
  }
  return "OTHER";
}

// Simple client-side rate limit defaults
export const RATE_LIMIT = Object.freeze({
  MAX_REQUESTS: 10,
  TIME_WINDOW: 1000, // ms
});

// Common endpoints (optional)
export const ENDPOINTS = Object.freeze({
  LOGIN: `${API_URL}/auth/login`,
  REFRESH: `${API_URL}/auth/refresh`,
  UPLOAD_INIT: `${API_URL}/upload/init`,
  WS_PATH: `${WS_URL}/ws`, // e.g., new WebSocket(ENDPOINTS.WS_PATH)
});

// ==================== Zero-Knowledge Encryption ====================

// ZK Service Endpoints
export const ZK_ENDPOINTS = Object.freeze({
  // Authentication
  REGISTER_ZK: `${ZK_SERVICE_URL}/api/v1/zk/register-zk`,
  LOGIN_ZK: `${ZK_SERVICE_URL}/api/v1/zk/login-zk`,
  LOGOUT: `${ZK_SERVICE_URL}/api/v1/zk/logout`,
  KDF_PARAMS: `${ZK_SERVICE_URL}/api/v1/zk/kdf-params`,

  // User & Status
  STATUS: `${ZK_SERVICE_URL}/api/v1/zk/status`,

  // Recovery
  RECOVERY_ENABLE: `${ZK_SERVICE_URL}/api/v1/zk/recovery/enable`,
  RECOVERY_VERIFY: `${ZK_SERVICE_URL}/api/v1/zk/recovery/verify`,
  RECOVERY_RECOVER: `${ZK_SERVICE_URL}/api/v1/zk/recovery/recover`,

  // File Operations
  UPLOAD_INIT: `${ZK_SERVICE_URL}/api/v1/zk/upload/init`,
  UPLOAD_CHUNK: `${ZK_SERVICE_URL}/api/v1/zk/upload/chunk`,
  UPLOAD_COMPLETE: `${ZK_SERVICE_URL}/api/v1/zk/upload/complete`,
  FILES_LIST: `${ZK_SERVICE_URL}/api/v1/zk/files`,
  FILE_METADATA: `${ZK_SERVICE_URL}/api/v1/zk/file`,
  STORAGE_USAGE: `${ZK_SERVICE_URL}/api/v1/zk/storage/usage`,

  // Health
  HEALTH: `${ZK_SERVICE_URL}/health`,
});

// ZK Encryption Configuration
export const ZK_CONFIG = Object.freeze({
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
});

// ZK Feature Flags
export const ZK_FEATURES = Object.freeze({
  ENABLED: import.meta.env.VITE_ZK_ENABLED !== 'false', // ZK encryption available
  REQUIRED: import.meta.env.VITE_ZK_REQUIRED === 'true', // Force ZK for all users
  RECOVERY_PHRASE: true, // BIP39 recovery phrase support
  HARDWARE_KEYS: false, // Hardware key support (future)
  SOCIAL_RECOVERY: false, // Social recovery (future)
  BIOMETRIC_UNLOCK: false, // Biometric unlock (future)
});

// ZK Storage Settings
export const ZK_STORAGE = Object.freeze({
  // LocalStorage keys (for non-sensitive data only)
  ZK_ENABLED_KEY: 'zkEnabled',
  ZK_EMAIL_KEY: 'zkEmail',
  RECOVERY_ENABLED_KEY: 'zkRecoveryEnabled',

  // Session storage keys
  SESSION_UNLOCKED_KEY: 'zkSessionUnlocked',
  SESSION_TIMESTAMP_KEY: 'zkSessionTimestamp',
});

// ZK Error Messages
export const ZK_ERRORS = Object.freeze({
  SESSION_LOCKED: 'Your encryption session is locked. Please unlock to continue.',
  INVALID_PASSWORD: 'Invalid password. Please try again.',
  INVALID_RECOVERY_PHRASE: 'Invalid recovery phrase. Please check and try again.',
  DECRYPTION_FAILED: 'Failed to decrypt file. The file may be corrupted or you may not have access.',
  ENCRYPTION_FAILED: 'Failed to encrypt file. Please try again.',
  SESSION_EXPIRED: 'Your encryption session has expired. Please log in again.',
  NETWORK_ERROR: 'Network error. Please check your connection and try again.',
  MASTER_KEY_MISSING: 'Master encryption key not found. Please log in again.',
});

// ZK Upload Modes
export const ZK_UPLOAD_MODE = Object.freeze({
  STANDARD: 'standard', // Regular upload (no encryption)
  ENCRYPTED: 'encrypted', // ZK encrypted upload
  HYBRID: 'hybrid', // Support both modes
});
