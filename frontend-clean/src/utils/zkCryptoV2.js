/**
 * Zero-Knowledge Cryptography V2 - Production-Grade Implementation
 *
 * Key improvements over V1:
 * - HKDF-based key hierarchy (MasterKey → derived keys)
 * - Argon2id as primary KDF with Safari fallback
 * - AAD (Additional Authenticated Data) in AES-GCM
 * - Never encrypt directly with MasterKey
 *
 * Key Hierarchy:
 * MasterKey (32 bytes, from Argon2id)
 *   ├── MetadataKey = HKDF(MasterKey, "meta:v1")
 *   ├── ShareKey    = HKDF(MasterKey, "share:v1")
 *   └── FileKey     = HKDF(MasterKey, "file:{file_id}")
 *         ├── ChunkKey  = HKDF(FileKey, "chunk:{index}")
 *         └── ThumbKey  = HKDF(FileKey, "thumb:v1")
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// ==================== Constants ====================

export const ZK_CONSTANTS_V2 = {
  // Version identifier for encrypted data
  VERSION: 0x02,

  // Key Derivation - Argon2id parameters
  ARGON2_MEMORY_DEFAULT: 65536,      // 64 MiB
  ARGON2_MEMORY_SAFARI_IOS: 32768,   // 32 MiB
  ARGON2_MEMORY_SAFARI_MACOS: 65536, // 64 MiB
  ARGON2_ITERATIONS: 3,
  ARGON2_PARALLELISM: 4,

  // PBKDF2 fallback (only with explicit user consent)
  PBKDF2_ITERATIONS: 600000,

  // Key lengths
  KEY_LENGTH: 32,        // 256 bits
  SALT_LENGTH: 32,       // 256 bits

  // AES-GCM parameters
  GCM_IV_LENGTH: 12,     // 96 bits (recommended for GCM)
  GCM_TAG_LENGTH: 16,    // 128 bits

  // Chunk parameters
  CHUNK_SIZE: 64 * 1024 * 1024, // 64 MiB
  MAX_CONCURRENT_CHUNKS: 4,
};

// HKDF context labels - NEVER reuse these
export const HKDF_LABELS = {
  METADATA: 'meta:v1',
  SHARE: 'share:v1',
  FILE: (fileId) => `file:${fileId}`,
  CHUNK: (index) => `chunk:${index}`,
  THUMBNAIL: 'thumb:v1',
  RECOVERY: 'recovery:v1',
};

// ==================== Browser Detection ====================

/**
 * Detect Safari browser for memory-constrained Argon2 parameters
 * @returns {Object} { isSafari, isIOS, isMacOS }
 */
export function detectBrowser() {
  const ua = navigator.userAgent;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isMacOS = /Mac OS X/.test(ua) && !isIOS;

  return { isSafari, isIOS, isMacOS };
}

/**
 * Get appropriate Argon2 memory parameter for current browser
 * @returns {number} Memory in KiB
 */
export function getArgon2Memory() {
  const { isSafari, isIOS } = detectBrowser();

  if (isSafari && isIOS) {
    return ZK_CONSTANTS_V2.ARGON2_MEMORY_SAFARI_IOS;
  }
  if (isSafari) {
    return ZK_CONSTANTS_V2.ARGON2_MEMORY_SAFARI_MACOS;
  }
  return ZK_CONSTANTS_V2.ARGON2_MEMORY_DEFAULT;
}

// ==================== Random Generation ====================

/**
 * Generate cryptographically secure random bytes
 * @param {number} length - Number of bytes
 * @returns {Uint8Array}
 */
export function generateRandomBytes(length) {
  return randomBytes(length);
}

/**
 * Generate a random 256-bit master key
 * @returns {Uint8Array} 32 bytes
 */
export function generateMasterKey() {
  return generateRandomBytes(ZK_CONSTANTS_V2.KEY_LENGTH);
}

/**
 * Generate a random salt for key derivation
 * @returns {Uint8Array} 32 bytes
 */
export function generateSalt() {
  return generateRandomBytes(ZK_CONSTANTS_V2.SALT_LENGTH);
}

/**
 * Generate a random IV for AES-GCM
 * @returns {Uint8Array} 12 bytes
 */
export function generateIV() {
  return generateRandomBytes(ZK_CONSTANTS_V2.GCM_IV_LENGTH);
}

// ==================== Argon2id Key Derivation ====================

let argon2Module = null;
let argon2LoadPromise = null;

/**
 * Load Argon2 via script tag (more reliable than ES module import)
 * @returns {Promise<Object>}
 */
async function getArgon2() {
  if (argon2Module) return argon2Module;
  if (argon2LoadPromise) return argon2LoadPromise;

  argon2LoadPromise = new Promise((resolve, reject) => {
    // Check if already loaded globally
    if (typeof window !== 'undefined' && window.argon2) {
      argon2Module = window.argon2;
      console.log('[ZK] Argon2 already loaded globally');
      resolve(argon2Module);
      return;
    }

    // Load via script tag
    const script = document.createElement('script');
    script.src = '/argon2-bundled.min.js';
    script.async = true;

    script.onload = () => {
      if (window.argon2 && typeof window.argon2.hash === 'function') {
        argon2Module = window.argon2;
        console.log('[ZK] Argon2 loaded via script');
        resolve(argon2Module);
      } else {
        reject(new Error('Argon2 script loaded but hash function not found'));
      }
    };

    script.onerror = () => {
      reject(new Error('Failed to load Argon2 script'));
    };

    document.head.appendChild(script);
  });

  return argon2LoadPromise;
}

/**
 * Derive a key from password using Argon2id
 * Falls back to lower memory if allocation fails
 *
 * @param {string} password - User password
 * @param {Uint8Array} salt - Salt (32 bytes)
 * @param {Object} options - Optional overrides
 * @returns {Promise<Uint8Array>} Derived key (32 bytes)
 * @throws {Error} If Argon2id fails completely
 */
export async function deriveKeyArgon2id(password, salt, options = {}) {
  const argon2 = await getArgon2();

  const memoryLevels = [
    ZK_CONSTANTS_V2.ARGON2_MEMORY_DEFAULT,      // 64 MiB
    ZK_CONSTANTS_V2.ARGON2_MEMORY_SAFARI_IOS,   // 32 MiB
    16384,                                       // 16 MiB (emergency)
  ];

  // Start with browser-appropriate memory
  const startIndex = memoryLevels.indexOf(getArgon2Memory());
  const levelsToTry = memoryLevels.slice(Math.max(0, startIndex));

  // argon2-browser uses numeric types: Argon2d=0, Argon2i=1, Argon2id=2
  const ARGON2ID_TYPE = argon2.ArgonType?.Argon2id ?? 2;

  for (const memory of levelsToTry) {
    try {
      const result = await argon2.hash({
        pass: password,
        salt: salt,
        time: options.iterations || ZK_CONSTANTS_V2.ARGON2_ITERATIONS,
        mem: memory,
        parallelism: options.parallelism || ZK_CONSTANTS_V2.ARGON2_PARALLELISM,
        hashLen: ZK_CONSTANTS_V2.KEY_LENGTH,
        type: ARGON2ID_TYPE,
      });

      return new Uint8Array(result.hash);
    } catch (error) {
      const isMemoryError =
        error.message?.includes('memory') ||
        error.message?.includes('allocation') ||
        error.message?.includes('OOM');

      if (!isMemoryError || memory === levelsToTry[levelsToTry.length - 1]) {
        throw new Error(`Argon2id failed: ${error.message}`);
      }
      // Try next lower memory level
      console.warn(`Argon2id: Memory ${memory}KB failed, trying lower...`);
    }
  }

  throw new Error('Argon2id failed at all memory levels');
}

/**
 * PBKDF2 fallback - ONLY use with explicit user consent
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Uint8Array}
 */
export function deriveKeyPBKDF2Fallback(password, salt) {
  console.warn('Using PBKDF2 fallback - less secure than Argon2id');

  const passwordBytes = utf8ToBytes(password);
  return pbkdf2(sha256, passwordBytes, salt, {
    c: ZK_CONSTANTS_V2.PBKDF2_ITERATIONS,
    dkLen: ZK_CONSTANTS_V2.KEY_LENGTH,
  });
}

// ==================== HKDF Key Derivation ====================

/**
 * Derive a key using HKDF-SHA256
 * @param {Uint8Array} masterKey - Input key material
 * @param {string} label - Context label (unique per key type)
 * @returns {Uint8Array} Derived key (32 bytes)
 */
export function deriveKeyHKDF(masterKey, label) {
  const info = utf8ToBytes(label);
  return hkdf(sha256, masterKey, undefined, info, ZK_CONSTANTS_V2.KEY_LENGTH);
}

/**
 * Derive metadata encryption key
 * @param {Uint8Array} masterKey
 * @returns {Uint8Array}
 */
export function deriveMetadataKey(masterKey) {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.METADATA);
}

/**
 * Derive share encryption key
 * @param {Uint8Array} masterKey
 * @returns {Uint8Array}
 */
export function deriveShareKey(masterKey) {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.SHARE);
}

/**
 * Derive file encryption key
 * @param {Uint8Array} masterKey
 * @param {string} fileId
 * @returns {Uint8Array}
 */
export function deriveFileKey(masterKey, fileId) {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.FILE(fileId));
}

/**
 * Derive chunk encryption key
 * @param {Uint8Array} fileKey
 * @param {number} chunkIndex
 * @returns {Uint8Array}
 */
export function deriveChunkKey(fileKey, chunkIndex) {
  return deriveKeyHKDF(fileKey, HKDF_LABELS.CHUNK(chunkIndex));
}

/**
 * Derive thumbnail encryption key
 * @param {Uint8Array} fileKey
 * @returns {Uint8Array}
 */
export function deriveThumbnailKey(fileKey) {
  return deriveKeyHKDF(fileKey, HKDF_LABELS.THUMBNAIL);
}

/**
 * Derive recovery key from BIP39 seed
 * @param {Uint8Array} seed - Full BIP39 seed (64 bytes)
 * @returns {Uint8Array}
 */
export function deriveRecoveryKey(seed) {
  return deriveKeyHKDF(seed, HKDF_LABELS.RECOVERY);
}

// ==================== AES-GCM Encryption with AAD ====================

/**
 * Encrypt data using AES-256-GCM with Additional Authenticated Data
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} key - 32 bytes
 * @param {Uint8Array} aad - Additional authenticated data (optional)
 * @param {Uint8Array} iv - 12 bytes (optional, auto-generated if not provided)
 * @returns {Object} { ciphertext, iv, tag }
 */
export function encryptAESGCM(plaintext, key, aad = null, iv = null) {
  if (key.length !== ZK_CONSTANTS_V2.KEY_LENGTH) {
    throw new Error(`Invalid key length: ${key.length}, expected ${ZK_CONSTANTS_V2.KEY_LENGTH}`);
  }

  const actualIV = iv || generateIV();
  const cipher = aad ? gcm(key, actualIV, aad) : gcm(key, actualIV);
  const encrypted = cipher.encrypt(plaintext);

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS_V2.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS_V2.GCM_TAG_LENGTH);

  return { ciphertext, iv: actualIV, tag };
}

/**
 * Decrypt data using AES-256-GCM with AAD verification
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} tag
 * @param {Uint8Array} aad - Must match encryption AAD
 * @returns {Uint8Array}
 */
export function decryptAESGCM(ciphertext, key, iv, tag, aad = null) {
  if (key.length !== ZK_CONSTANTS_V2.KEY_LENGTH) {
    throw new Error(`Invalid key length: ${key.length}`);
  }
  if (iv.length !== ZK_CONSTANTS_V2.GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: ${iv.length}`);
  }

  // Reconstruct encrypted data
  const encrypted = new Uint8Array(ciphertext.length + tag.length);
  encrypted.set(ciphertext);
  encrypted.set(tag, ciphertext.length);

  const cipher = aad ? gcm(key, iv, aad) : gcm(key, iv);

  try {
    return cipher.decrypt(encrypted);
  } catch (error) {
    throw new Error('Decryption failed: Authentication tag mismatch or corrupted data');
  }
}

// ==================== Chunk Encryption with AAD ====================

/**
 * Encrypt a file chunk with AAD containing file ID and chunk index
 * Format: VERSION (1 byte) + IV (12 bytes) + ciphertext + tag (16 bytes)
 *
 * @param {Uint8Array} chunkData
 * @param {Uint8Array} fileKey
 * @param {string} fileId
 * @param {number} chunkIndex
 * @returns {Uint8Array} Encrypted chunk with version prefix
 */
export function encryptChunkV2(chunkData, fileKey, fileId, chunkIndex) {
  // Derive chunk-specific key
  const chunkKey = deriveChunkKey(fileKey, chunkIndex);

  // AAD prevents chunk reordering/substitution attacks
  const aad = utf8ToBytes(`file:${fileId}:chunk:${chunkIndex}`);

  const { ciphertext, iv, tag } = encryptAESGCM(chunkData, chunkKey, aad);

  // Format: VERSION + IV + ciphertext + tag
  const result = new Uint8Array(1 + iv.length + ciphertext.length + tag.length);
  result[0] = ZK_CONSTANTS_V2.VERSION;
  result.set(iv, 1);
  result.set(ciphertext, 1 + iv.length);
  result.set(tag, 1 + iv.length + ciphertext.length);

  return result;
}

/**
 * Decrypt a V2 encrypted chunk
 * @param {Uint8Array} encryptedChunk
 * @param {Uint8Array} fileKey
 * @param {string} fileId
 * @param {number} chunkIndex
 * @returns {Uint8Array}
 */
export function decryptChunkV2(encryptedChunk, fileKey, fileId, chunkIndex) {
  // Verify version
  if (encryptedChunk[0] !== ZK_CONSTANTS_V2.VERSION) {
    throw new Error(`Unknown encryption version: ${encryptedChunk[0]}`);
  }

  const IV_START = 1;
  const IV_END = 1 + ZK_CONSTANTS_V2.GCM_IV_LENGTH;
  const TAG_LENGTH = ZK_CONSTANTS_V2.GCM_TAG_LENGTH;

  const iv = encryptedChunk.slice(IV_START, IV_END);
  const ciphertextWithTag = encryptedChunk.slice(IV_END);
  const ciphertext = ciphertextWithTag.slice(0, -TAG_LENGTH);
  const tag = ciphertextWithTag.slice(-TAG_LENGTH);

  // Derive chunk-specific key
  const chunkKey = deriveChunkKey(fileKey, chunkIndex);

  // Reconstruct AAD
  const aad = utf8ToBytes(`file:${fileId}:chunk:${chunkIndex}`);

  return decryptAESGCM(ciphertext, chunkKey, iv, tag, aad);
}

// ==================== Master Key Encryption ====================

/**
 * Encrypt master key with password-derived key
 * @param {Uint8Array} masterKey
 * @param {Uint8Array} derivedKey
 * @returns {Object} { encryptedMasterKey: string, iv: string }
 */
export function encryptMasterKeyV2(masterKey, derivedKey) {
  const { ciphertext, iv, tag } = encryptAESGCM(masterKey, derivedKey);

  // Combine ciphertext + tag
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  return {
    encryptedMasterKey: bytesToBase64(combined),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt master key with password-derived key
 * @param {string} encryptedMasterKeyB64
 * @param {Uint8Array} derivedKey
 * @param {string} ivB64
 * @returns {Uint8Array}
 */
export function decryptMasterKeyV2(encryptedMasterKeyB64, derivedKey, ivB64) {
  const encrypted = base64ToBytes(encryptedMasterKeyB64);
  const iv = base64ToBytes(ivB64);

  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS_V2.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS_V2.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, derivedKey, iv, tag);
}

// ==================== Metadata Encryption ====================

/**
 * Encrypt file metadata
 * @param {Object} metadata - { name, path, size, mime, created }
 * @param {Uint8Array} masterKey
 * @returns {string} Base64 encoded encrypted metadata
 */
export function encryptMetadata(metadata, masterKey) {
  const metadataKey = deriveMetadataKey(masterKey);
  const plaintext = utf8ToBytes(JSON.stringify(metadata));

  const { ciphertext, iv, tag } = encryptAESGCM(plaintext, metadataKey);

  // Format: IV + ciphertext + tag
  const result = new Uint8Array(iv.length + ciphertext.length + tag.length);
  result.set(iv);
  result.set(ciphertext, iv.length);
  result.set(tag, iv.length + ciphertext.length);

  return bytesToBase64(result);
}

/**
 * Decrypt file metadata
 * @param {string} encryptedMetadataB64
 * @param {Uint8Array} masterKey
 * @returns {Object}
 */
export function decryptMetadata(encryptedMetadataB64, masterKey) {
  const encrypted = base64ToBytes(encryptedMetadataB64);

  const IV_LENGTH = ZK_CONSTANTS_V2.GCM_IV_LENGTH;
  const TAG_LENGTH = ZK_CONSTANTS_V2.GCM_TAG_LENGTH;

  const iv = encrypted.slice(0, IV_LENGTH);
  const ciphertext = encrypted.slice(IV_LENGTH, -TAG_LENGTH);
  const tag = encrypted.slice(-TAG_LENGTH);

  const metadataKey = deriveMetadataKey(masterKey);
  const plaintext = decryptAESGCM(ciphertext, metadataKey, iv, tag);

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(plaintext));
}

// ==================== Version Detection ====================

/**
 * Detect encryption version from encrypted data
 * @param {Uint8Array} encryptedData
 * @returns {'v1' | 'v2'}
 */
export function detectEncryptionVersion(encryptedData) {
  if (encryptedData[0] === ZK_CONSTANTS_V2.VERSION) {
    return 'v2';
  }
  return 'v1'; // Legacy format
}

// ==================== Hashing ====================

/**
 * Hash a derived key for server verification
 * @param {Uint8Array} derivedKey
 * @returns {string} Hex string
 */
export function hashDerivedKey(derivedKey) {
  const hash = sha256(derivedKey);
  return bytesToHex(hash);
}

// ==================== Encoding Utilities ====================

/**
 * Convert Uint8Array to base64
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 to Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Re-export from noble for convenience
export { bytesToHex, hexToBytes };

// ==================== Memory Management ====================

/**
 * Securely clear sensitive data (best effort in JS)
 * @param {Uint8Array} data
 */
export function secureClear(data) {
  if (data && data.fill) {
    data.fill(0);
  }
}

// ==================== Default Export ====================

export default {
  ZK_CONSTANTS_V2,
  HKDF_LABELS,
  detectBrowser,
  getArgon2Memory,
  generateRandomBytes,
  generateMasterKey,
  generateSalt,
  generateIV,
  deriveKeyArgon2id,
  deriveKeyPBKDF2Fallback,
  deriveKeyHKDF,
  deriveMetadataKey,
  deriveShareKey,
  deriveFileKey,
  deriveChunkKey,
  deriveThumbnailKey,
  deriveRecoveryKey,
  encryptAESGCM,
  decryptAESGCM,
  encryptChunkV2,
  decryptChunkV2,
  encryptMasterKeyV2,
  decryptMasterKeyV2,
  encryptMetadata,
  decryptMetadata,
  detectEncryptionVersion,
  hashDerivedKey,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  secureClear,
};
