/**
 * Zero-Knowledge Encryption Service
 *
 * High-level service for managing client-side encryption.
 * Handles master key management, file encryption/decryption, and recovery.
 *
 * Key Derivation:
 * - New registrations use Argon2id (memory-hard, GPU-resistant)
 * - Backward compatible with PBKDF2 for existing users
 */

import {
  generateMasterKey,
  generateFileKey,
  generateSalt,
  deriveKeyFromPassword,
  hashDerivedKey,
  encryptMasterKey,
  decryptMasterKey,
  encryptFileKey,
  decryptFileKey,
  encryptChunk,
  decryptChunk,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  deriveKeyFromRecoveryPhrase,
  hashRecoveryPhrase,
  encryptMasterKeyWithRecovery,
  computeFileHash,
  bytesToBase64,
  base64ToBytes,
  bytesToHexString,
  secureClear,
  generateUploadId,
  ZK_CONSTANTS,
} from '../utils/zkCrypto.js';

// Import Argon2id functions from V2
import {
  deriveKeyArgon2id,
  getArgon2Memory,
  ZK_CONSTANTS_V2,
} from '../utils/zkCryptoV2.js';

// ==================== Session State Management ====================

class ZKEncryptionSession {
  constructor() {
    this.masterKey = null;
    this.derivedKey = null;
    this.isUnlocked = false;
  }

  /**
   * Set the master key in memory (session only)
   * @param {Uint8Array} masterKey - Master key (32 bytes)
   */
  setMasterKey(masterKey) {
    this.masterKey = masterKey;
    this.isUnlocked = true;
  }

  /**
   * Set the derived key in memory (for password verification)
   * @param {Uint8Array} derivedKey - Derived key from password
   */
  setDerivedKey(derivedKey) {
    this.derivedKey = derivedKey;
  }

  /**
   * Get the master key
   * @returns {Uint8Array|null} Master key or null if locked
   */
  getMasterKey() {
    if (!this.isUnlocked || !this.masterKey) {
      throw new Error('ZK encryption session is locked. Please unlock first.');
    }
    return this.masterKey;
  }

  /**
   * Get the derived key
   * @returns {Uint8Array|null} Derived key or null
   */
  getDerivedKey() {
    return this.derivedKey;
  }

  /**
   * Check if session is unlocked
   * @returns {boolean} True if unlocked
   */
  isSessionUnlocked() {
    return this.isUnlocked && this.masterKey !== null;
  }

  /**
   * Lock the session and clear sensitive data from memory
   */
  lock() {
    if (this.masterKey) {
      secureClear(this.masterKey);
      this.masterKey = null;
    }
    if (this.derivedKey) {
      secureClear(this.derivedKey);
      this.derivedKey = null;
    }
    this.isUnlocked = false;
  }

  /**
   * Clear session on logout
   */
  clear() {
    this.lock();
  }
}

// Global session instance
const zkSession = new ZKEncryptionSession();

// ==================== Registration ====================

/**
 * Generate ZK registration data using Argon2id (async)
 * Uses memory-hard Argon2id for better resistance against GPU attacks
 *
 * @param {string} password - User password
 * @returns {Promise<Object>} Registration data for backend
 */
export async function generateZKRegistrationData(password) {
  // Generate salt for password derivation
  const salt = generateSalt();

  // Derive key from password using Argon2id (memory-hard, GPU-resistant)
  const derivedKey = await deriveKeyArgon2id(password, salt);

  // Hash the derived key (server stores this, never the key itself)
  const passwordHash = hashDerivedKey(derivedKey);

  // Generate master encryption key
  const masterKey = generateMasterKey();

  // Encrypt master key with derived key
  const { encryptedMasterKey, iv } = encryptMasterKey(masterKey, derivedKey);

  // Store keys in session
  zkSession.setMasterKey(masterKey);
  zkSession.setDerivedKey(derivedKey);

  // Get Argon2 parameters used
  const argon2Memory = getArgon2Memory();

  return {
    passwordHash,
    encryptedMasterKey,
    kdfSalt: bytesToHexString(salt),
    kdfAlgorithm: 'argon2id',  // New registrations use Argon2id
    kdfIterations: ZK_CONSTANTS_V2.ARGON2_ITERATIONS,
    kdfMemory: argon2Memory,
    kdfParallelism: ZK_CONSTANTS_V2.ARGON2_PARALLELISM,
    masterKeyIV: iv,
  };
}

/**
 * Unlock ZK session after login (async)
 * Supports Argon2id (primary) and PBKDF2 (low-memory device fallback)
 *
 * @param {string} password - User password
 * @param {Object} zkData - ZK data from backend (kdfSalt, encryptedMasterKey, kdfAlgorithm, etc.)
 * @returns {Promise<boolean>} True if unlock successful
 */
export async function unlockZKSession(password, zkData) {
  try {
    console.log('[ZK] unlockZKSession called');

    const {
      kdfSalt,
      encryptedMasterKey,
      kdfAlgorithm = 'argon2id',  // Default to argon2id (primary algorithm)
      kdfIterations = ZK_CONSTANTS.KDF_ITERATIONS,
    } = zkData;

    console.log('[ZK] KDF Algorithm:', kdfAlgorithm);

    if (!kdfSalt) {
      throw new Error('KDF salt is missing');
    }
    if (!encryptedMasterKey) {
      throw new Error('Encrypted master key is missing');
    }

    // Derive key from password using appropriate algorithm
    let derivedKey;
    if (kdfAlgorithm === 'argon2id') {
      // Use Argon2id (primary - memory-hard, GPU-resistant)
      console.log('[ZK] Using Argon2id for key derivation...');
      const saltBytes = typeof kdfSalt === 'string'
        ? new Uint8Array(kdfSalt.match(/.{1,2}/g).map(byte => parseInt(byte, 16)))
        : kdfSalt;
      derivedKey = await deriveKeyArgon2id(password, saltBytes);
    } else {
      // Use PBKDF2 (fallback for low-memory devices)
      console.log('[ZK] Using PBKDF2 for key derivation (low-memory fallback)...');
      derivedKey = deriveKeyFromPassword(password, kdfSalt, kdfIterations);
    }
    console.log('[ZK] Derived key length:', derivedKey.length);

    // Hash derived key for verification
    const passwordHash = hashDerivedKey(derivedKey);

    // Extract IV
    const iv = zkData.masterKeyIV || zkData.kdf_iv;
    if (!iv) {
      throw new Error('Master key IV is missing');
    }

    // Decrypt master key
    console.log('[ZK] Decrypting master key...');
    const masterKey = decryptMasterKey(encryptedMasterKey, derivedKey, iv);
    console.log('[ZK] Master key decrypted successfully');

    // Store in session
    zkSession.setMasterKey(masterKey);
    zkSession.setDerivedKey(derivedKey);

    console.log('[ZK] Session unlocked successfully!');
    return true;
  } catch (error) {
    console.error('[ZK] Failed to unlock ZK session:', error.message);
    return false;
  }
}

/**
 * Lock ZK session (on logout or manual lock)
 */
export function lockZKSession() {
  zkSession.lock();
}

/**
 * Check if ZK session is unlocked
 * @returns {boolean} True if session is unlocked
 */
export function isZKSessionUnlocked() {
  return zkSession.isSessionUnlocked();
}

/**
 * Get password hash for login (async)
 * Supports Argon2id (primary) and PBKDF2 (low-memory device fallback)
 *
 * @param {string} password - User password
 * @param {string} kdfSalt - KDF salt (hex string)
 * @param {number} [kdfIterations=600000] - KDF iterations
 * @param {string} [kdfAlgorithm='argon2id'] - KDF algorithm ('argon2id' or 'pbkdf2')
 * @returns {Promise<string>} Password hash for backend verification
 */
export async function getPasswordHashForLogin(password, kdfSalt, kdfIterations = ZK_CONSTANTS.KDF_ITERATIONS, kdfAlgorithm = 'argon2id') {
  let derivedKey;

  if (kdfAlgorithm === 'argon2id') {
    // Use Argon2id (primary - memory-hard, GPU-resistant)
    console.log('[ZK] Login: Using Argon2id for key derivation');
    const saltBytes = typeof kdfSalt === 'string'
      ? new Uint8Array(kdfSalt.match(/.{1,2}/g).map(byte => parseInt(byte, 16)))
      : kdfSalt;
    derivedKey = await deriveKeyArgon2id(password, saltBytes);
  } else {
    // Use PBKDF2 (fallback for low-memory devices)
    console.log('[ZK] Login: Using PBKDF2 for key derivation (low-memory fallback)');
    derivedKey = deriveKeyFromPassword(password, kdfSalt, kdfIterations);
  }

  return hashDerivedKey(derivedKey);
}

// ==================== Recovery Phrase ====================

/**
 * Generate and encrypt master key with recovery phrase
 * @returns {Object} { recoveryPhrase, recoveryEncryptedMasterKey, recoveryPhraseHash }
 */
export function generateRecoveryPhraseData() {
  const masterKey = zkSession.getMasterKey();

  // Generate BIP39 recovery phrase (now synchronous with @scure/bip39)
  const recoveryPhrase = generateRecoveryPhrase();

  // Encrypt master key with recovery phrase
  const { recoveryEncryptedMasterKey, recoveryIV, recoveryPhraseHash } =
    encryptMasterKeyWithRecovery(masterKey, recoveryPhrase);

  return {
    recoveryPhrase, // Show this to user ONCE
    recoveryEncryptedMasterKey,
    recoveryIV,
    recoveryPhraseHash, // Send to backend for verification
  };
}

/**
 * Verify recovery phrase
 * @param {string} recoveryPhrase - Recovery phrase entered by user
 * @returns {boolean} True if valid
 */
export function verifyRecoveryPhrase(recoveryPhrase) {
  return validateRecoveryPhrase(recoveryPhrase);
}

/**
 * Recover master key from recovery phrase
 * @param {string} recoveryPhrase - Recovery phrase
 * @param {string} recoveryEncryptedMasterKey - Encrypted master key (base64)
 * @param {string} recoveryIV - Recovery IV (base64)
 * @returns {boolean} True if recovery successful
 */
export function recoverMasterKeyFromPhrase(recoveryPhrase, recoveryEncryptedMasterKey, recoveryIV) {
  try {
    // Validate phrase first
    if (!validateRecoveryPhrase(recoveryPhrase)) {
      throw new Error('Invalid recovery phrase format');
    }

    // Derive key from recovery phrase
    const recoveryKey = deriveKeyFromRecoveryPhrase(recoveryPhrase);

    // Decrypt master key
    const masterKey = decryptMasterKey(recoveryEncryptedMasterKey, recoveryKey, recoveryIV);

    // Store in session
    zkSession.setMasterKey(masterKey);

    return true;
  } catch (error) {
    console.error('Failed to recover master key:', error);
    return false;
  }
}

/**
 * Get recovery phrase hash for backend verification
 * @param {string} recoveryPhrase - Recovery phrase
 * @returns {string} SHA-256 hash (hex)
 */
export function getRecoveryPhraseHash(recoveryPhrase) {
  return hashRecoveryPhrase(recoveryPhrase);
}

/**
 * Re-encrypt the current session's master key with a new password
 * Used after recovery to set a new password
 * @param {string} newPassword - New password
 * @returns {Promise<Object>} { passwordHash, encryptedMasterKey, kdfSalt, kdfAlgorithm, kdfIterations, kdfMemory, kdfParallelism, masterKeyIV }
 */
export async function reEncryptMasterKeyWithNewPassword(newPassword) {
  const masterKey = zkSession.getMasterKey();
  if (!masterKey) {
    throw new Error('No master key in session. Recovery must be performed first.');
  }

  // Generate new salt for password derivation
  const salt = generateSalt();

  // Derive key from new password using Argon2id
  const derivedKey = await deriveKeyArgon2id(newPassword, salt);

  // Hash the derived key (server stores this)
  const passwordHash = hashDerivedKey(derivedKey);

  // Encrypt master key with new derived key
  const { encryptedMasterKey, iv } = encryptMasterKey(masterKey, derivedKey);

  // Update session with new derived key
  zkSession.setDerivedKey(derivedKey);

  // Get Argon2 parameters used
  const argon2Memory = getArgon2Memory();

  return {
    passwordHash,
    encryptedMasterKey,
    kdfSalt: bytesToHexString(salt),
    kdfAlgorithm: 'argon2id',
    kdfIterations: ZK_CONSTANTS_V2.ARGON2_ITERATIONS,
    kdfMemory: argon2Memory,
    kdfParallelism: ZK_CONSTANTS_V2.ARGON2_PARALLELISM,
    masterKeyIV: iv,
  };
}

// ==================== File Encryption ====================

/**
 * Prepare file for encrypted upload
 * @param {File} file - File to encrypt
 * @param {Function} progressCallback - Progress callback (optional)
 * @returns {Promise<Object>} Upload preparation data
 */
export async function prepareFileForEncryption(file, progressCallback = null) {
  const masterKey = zkSession.getMasterKey();

  // Generate unique file encryption key
  const fileKey = generateFileKey();

  // Encrypt file key with master key
  const { encryptedFileKey, iv: fileKeyIV } = encryptFileKey(fileKey, masterKey);

  // Generate upload ID
  const uploadId = generateUploadId();

  return {
    fileKey, // Keep in memory for chunk encryption
    encryptedFileKey, // Send to backend
    fileKeyIV, // Send to backend
    uploadId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    encryptionAlgorithm: ZK_CONSTANTS.ENCRYPTION_ALGORITHM,
    chunkSize: ZK_CONSTANTS.CHUNK_SIZE,
  };
}

/**
 * Encrypt a file chunk
 * @param {Uint8Array} chunkData - Chunk data
 * @param {Uint8Array} fileKey - File encryption key
 * @param {number} chunkIndex - Chunk index
 * @returns {Object} { encryptedChunk, iv }
 */
export function encryptFileChunk(chunkData, fileKey, chunkIndex) {
  return encryptChunk(chunkData, fileKey, chunkIndex);
}

/**
 * Encrypt entire file in chunks
 * @param {File} file - File to encrypt
 * @param {Function} progressCallback - Progress callback (bytesEncrypted, totalBytes)
 * @returns {Promise<Object>} { encryptedChunks, fileKey, encryptedFileKey, metadata }
 */
export async function encryptFile(file, progressCallback = null) {
  const masterKey = zkSession.getMasterKey();

  // Generate file encryption key
  const fileKey = generateFileKey();

  // Encrypt file key with master key
  const { encryptedFileKey, iv: fileKeyIV } = encryptFileKey(fileKey, masterKey);

  // Read file as ArrayBuffer
  const fileBuffer = await file.arrayBuffer();
  const fileData = new Uint8Array(fileBuffer);

  // Calculate file hash (before encryption)
  const fileHash = computeFileHash(fileData);

  const chunkSize = ZK_CONSTANTS.CHUNK_SIZE;
  const totalChunks = Math.ceil(fileData.length / chunkSize);
  const encryptedChunks = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileData.length);
    const chunkData = fileData.slice(start, end);

    const { encryptedChunk, iv } = encryptChunk(chunkData, fileKey, i);

    encryptedChunks.push({
      index: i,
      data: encryptedChunk,
      iv,
      size: encryptedChunk.length,
    });

    if (progressCallback) {
      progressCallback(end, fileData.length);
    }
  }

  return {
    encryptedChunks,
    encryptedFileKey,
    fileKeyIV,
    fileKey,  // Include plaintext file key for thumbnail encryption
    fileHash,
    totalChunks,
    originalSize: file.size,
    encryptedSize: encryptedChunks.reduce((sum, chunk) => sum + chunk.size, 0),
    metadata: {
      fileName: file.name,
      mimeType: file.type,
      encryptionAlgorithm: ZK_CONSTANTS.ENCRYPTION_ALGORITHM,
    },
  };
}

// ==================== File Decryption ====================

/**
 * Decrypt a file chunk
 * @param {Uint8Array} encryptedChunk - Encrypted chunk data (format: IV + ciphertext + tag)
 * @param {Uint8Array} fileKey - File decryption key
 * @param {number} chunkIndex - Chunk index (optional, for logging/AAD)
 * @returns {Uint8Array} Decrypted chunk data
 */
export function decryptFileChunk(encryptedChunk, fileKey, chunkIndex = 0) {
  // IV is now prepended to the encrypted chunk, no need to pass separately
  return decryptChunk(encryptedChunk, fileKey, chunkIndex);
}

/**
 * Prepare for file decryption by decrypting the file key
 * @param {string} encryptedFileKeyB64 - Encrypted file key (base64)
 * @param {string} fileKeyIVB64 - File key IV (base64)
 * @returns {Uint8Array} Decrypted file key
 */
export function prepareFileForDecryption(encryptedFileKeyB64, fileKeyIVB64) {
  const masterKey = zkSession.getMasterKey();

  // Decrypt file key with master key
  const fileKey = decryptFileKey(encryptedFileKeyB64, masterKey, fileKeyIVB64);

  return fileKey;
}

/**
 * Decrypt entire file from encrypted chunks
 * @param {Array} encryptedChunks - Array of { data, iv, index }
 * @param {string} encryptedFileKey - Encrypted file key (base64)
 * @param {string} fileKeyIV - File key IV (base64)
 * @param {Function} progressCallback - Progress callback (bytesDecrypted, totalBytes)
 * @returns {Promise<Blob>} Decrypted file as Blob
 */
export async function decryptFile(encryptedChunks, encryptedFileKey, fileKeyIV, progressCallback = null) {
  const masterKey = zkSession.getMasterKey();

  // Decrypt file key
  const fileKey = decryptFileKey(encryptedFileKey, masterKey, fileKeyIV);

  const decryptedChunks = [];
  const totalBytes = encryptedChunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  let bytesDecrypted = 0;

  // Sort chunks by index to ensure correct order
  const sortedChunks = [...encryptedChunks].sort((a, b) => a.index - b.index);

  for (const chunk of sortedChunks) {
    const decryptedChunk = decryptChunk(chunk.data, fileKey, chunk.iv);
    decryptedChunks.push(decryptedChunk);

    bytesDecrypted += chunk.data.length;

    if (progressCallback) {
      progressCallback(bytesDecrypted, totalBytes);
    }
  }

  // Combine chunks into single Blob
  const blob = new Blob(decryptedChunks);

  // Clear file key from memory
  secureClear(fileKey);

  return blob;
}

// ==================== Metadata Encryption ====================

// Import V2 crypto for HKDF-based key derivation (ZK_CONSTANTS_V2 already imported at top)
import {
  deriveMetadataKey,
  deriveFilenameKey,
  encryptAESGCM as encryptAESGCMv2,
  decryptAESGCM as decryptAESGCMv2,
  bytesToBase64 as bytesToBase64v2,
  base64ToBytes as base64ToBytesv2,
  encryptFilename as encryptFilenameV2,
  decryptFilename as decryptFilenameV2,
} from '../utils/zkCryptoV2.js';

/**
 * Encrypt file metadata (name, path, size, MIME type)
 * Uses HKDF-derived MetadataKey for encryption
 *
 * @param {Object} metadata - { name, path, size, mime, created }
 * @returns {string} Base64 encoded encrypted metadata
 */
export function encryptMetadata(metadata) {
  const masterKey = zkSession.getMasterKey();
  const metadataKey = deriveMetadataKey(masterKey);

  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(metadata));

  const { ciphertext, iv, tag } = encryptAESGCMv2(plaintext, metadataKey);

  // Format: IV + ciphertext + tag
  const result = new Uint8Array(iv.length + ciphertext.length + tag.length);
  result.set(iv);
  result.set(ciphertext, iv.length);
  result.set(tag, iv.length + ciphertext.length);

  return bytesToBase64v2(result);
}

/**
 * Decrypt file metadata
 * @param {string} encryptedMetadataB64 - Base64 encrypted metadata
 * @returns {Object} Decrypted metadata object
 */
export function decryptMetadata(encryptedMetadataB64) {
  const masterKey = zkSession.getMasterKey();
  const metadataKey = deriveMetadataKey(masterKey);

  const encrypted = base64ToBytesv2(encryptedMetadataB64);

  const IV_LENGTH = ZK_CONSTANTS_V2.GCM_IV_LENGTH;
  const TAG_LENGTH = ZK_CONSTANTS_V2.GCM_TAG_LENGTH;

  const iv = encrypted.slice(0, IV_LENGTH);
  const ciphertext = encrypted.slice(IV_LENGTH, -TAG_LENGTH);
  const tag = encrypted.slice(-TAG_LENGTH);

  const plaintext = decryptAESGCMv2(ciphertext, metadataKey, iv, tag);

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(plaintext));
}

/**
 * Prepare encrypted file metadata for upload
 * @param {File} file - File to get metadata from
 * @param {string} path - Folder path (optional)
 * @returns {Object} { encryptedMetadata, plaintextHints }
 */
export function prepareEncryptedMetadata(file, path = '/') {
  const metadata = {
    name: file.name,
    path: path,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    created: new Date().toISOString(),
  };

  const encryptedMetadata = encryptMetadata(metadata);

  // Provide some hints for server (non-sensitive)
  const plaintextHints = {
    sizeHint: Math.ceil(file.size / 1024), // Size in KB (approximate)
    typeHint: file.type ? file.type.split('/')[0] : 'unknown', // Just the type category
  };

  return { encryptedMetadata, plaintextHints };
}

// ==================== Filename Encryption ====================

/**
 * Encrypt filename for ZK storage
 * @param {string} filename - Plaintext filename
 * @returns {Object} { encryptedFilename: string, filenameIV: string } - Base64 encoded
 */
export function encryptFilename(filename) {
  const masterKey = zkSession.getMasterKey();
  return encryptFilenameV2(filename, masterKey);
}

/**
 * Decrypt filename from ZK storage
 * @param {string} encryptedFilenameB64 - Base64 encoded encrypted filename
 * @param {string} filenameIVB64 - Base64 encoded IV
 * @returns {string} Decrypted filename
 */
export function decryptFilename(encryptedFilenameB64, filenameIVB64) {
  const masterKey = zkSession.getMasterKey();
  return decryptFilenameV2(encryptedFilenameB64, filenameIVB64, masterKey);
}

/**
 * Safely decrypt filename, returning fallback if decryption fails
 * Handles legacy files that have base64-encoded plaintext filenames
 * @param {string} encryptedFilenameB64 - Base64 encoded encrypted filename
 * @param {string} filenameIVB64 - Base64 encoded IV
 * @param {string} fallback - Fallback value if decryption fails
 * @returns {string} Decrypted filename or fallback
 */
export function decryptFilenameSafe(encryptedFilenameB64, filenameIVB64, fallback = 'Encrypted File') {
  try {
    if (!zkSession.isSessionUnlocked()) {
      return fallback;
    }
    if (!encryptedFilenameB64 || !filenameIVB64) {
      return fallback;
    }
    return decryptFilename(encryptedFilenameB64, filenameIVB64);
  } catch (error) {
    console.warn('Failed to decrypt filename:', error.message);
    return fallback;
  }
}

// ==================== Utility Functions ====================

/**
 * Convert file to chunks without encryption (for progress tracking)
 * @param {File} file - File to chunk
 * @returns {Promise<Array>} Array of chunk metadata
 */
export async function getFileChunks(file) {
  const chunkSize = ZK_CONSTANTS.CHUNK_SIZE;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const chunks = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);

    chunks.push({
      index: i,
      start,
      end,
      size: end - start,
    });
  }

  return chunks;
}

/**
 * Read file chunk as Uint8Array
 * @param {File} file - File to read
 * @param {number} start - Start byte
 * @param {number} end - End byte
 * @returns {Promise<Uint8Array>} Chunk data
 */
export async function readFileChunk(file, start, end) {
  const slice = file.slice(start, end);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Get ZK session status
 * @returns {Object} Session status
 */
export function getZKSessionStatus() {
  return {
    isUnlocked: zkSession.isSessionUnlocked(),
    hasMasterKey: zkSession.masterKey !== null,
    hasDerivedKey: zkSession.derivedKey !== null,
  };
}

/**
 * Export session (for debugging only - NOT for production use)
 * @returns {Object} Session data
 */
export function exportSessionDebug() {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Session export only available in development mode');
  }

  return {
    isUnlocked: zkSession.isSessionUnlocked(),
    hasMasterKey: zkSession.masterKey !== null,
    hasDerivedKey: zkSession.derivedKey !== null,
    masterKeyLength: zkSession.masterKey?.length,
    derivedKeyLength: zkSession.derivedKey?.length,
  };
}

// ==================== Exports ====================

export default {
  // Registration & Login
  generateZKRegistrationData,
  unlockZKSession,
  lockZKSession,
  isZKSessionUnlocked,
  getPasswordHashForLogin,

  // Recovery
  generateRecoveryPhraseData,
  verifyRecoveryPhrase,
  recoverMasterKeyFromPhrase,
  getRecoveryPhraseHash,
  reEncryptMasterKeyWithNewPassword,

  // File Encryption
  prepareFileForEncryption,
  encryptFileChunk,
  encryptFile,

  // File Decryption
  prepareFileForDecryption,
  decryptFileChunk,
  decryptFile,

  // Metadata Encryption
  encryptMetadata,
  decryptMetadata,
  prepareEncryptedMetadata,

  // Filename Encryption
  encryptFilename,
  decryptFilename,
  decryptFilenameSafe,

  // Utilities
  getFileChunks,
  readFileChunk,
  getZKSessionStatus,
  exportSessionDebug,

  // Constants
  ZK_CONSTANTS,
};
