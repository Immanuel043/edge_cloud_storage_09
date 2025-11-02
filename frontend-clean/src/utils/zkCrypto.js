/**
 * Zero-Knowledge Cryptography Utilities
 *
 * Low-level cryptographic operations for client-side encryption.
 * All encryption happens client-side; server never sees plaintext or keys.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { Buffer } from 'buffer';

// ==================== Constants ====================

export const ZK_CONSTANTS = {
  // Key Derivation
  KDF_ALGORITHM: 'pbkdf2',
  KDF_ITERATIONS: 600000,
  PBKDF2_KEY_LENGTH: 32, // 256 bits

  // Encryption
  ENCRYPTION_ALGORITHM: 'AES-256-GCM',
  AES_KEY_LENGTH: 32, // 256 bits
  GCM_IV_LENGTH: 12, // 96 bits (recommended for GCM)
  GCM_TAG_LENGTH: 16, // 128 bits

  // Recovery
  RECOVERY_PHRASE_WORDS: 24, // BIP39 mnemonic
  RECOVERY_PHRASE_STRENGTH: 256, // bits

  // Chunk Processing
  CHUNK_SIZE: 64 * 1024 * 1024, // 64 MiB (match backend)
  MAX_CONCURRENT_CHUNKS: 4,
};

// ==================== Random Generation ====================

/**
 * Generate cryptographically secure random bytes
 * @param {number} length - Number of bytes to generate
 * @returns {Uint8Array} Random bytes
 */
export function generateRandomBytes(length) {
  return randomBytes(length);
}

/**
 * Generate a random 256-bit master key
 * @returns {Uint8Array} Master key (32 bytes)
 */
export function generateMasterKey() {
  return generateRandomBytes(ZK_CONSTANTS.AES_KEY_LENGTH);
}

/**
 * Generate a random 256-bit file encryption key
 * @returns {Uint8Array} File key (32 bytes)
 */
export function generateFileKey() {
  return generateRandomBytes(ZK_CONSTANTS.AES_KEY_LENGTH);
}

/**
 * Generate a random salt for key derivation
 * @returns {Uint8Array} Salt (32 bytes)
 */
export function generateSalt() {
  return generateRandomBytes(32);
}

/**
 * Generate a random IV for AES-GCM encryption
 * @returns {Uint8Array} IV (12 bytes)
 */
export function generateIV() {
  return generateRandomBytes(ZK_CONSTANTS.GCM_IV_LENGTH);
}

// ==================== Key Derivation ====================

/**
 * Derive an encryption key from a password using PBKDF2
 * @param {string} password - User password
 * @param {Uint8Array|string} salt - Salt (Uint8Array or hex string)
 * @param {number} [iterations=600000] - PBKDF2 iterations
 * @returns {Uint8Array} Derived key (32 bytes)
 */
export function deriveKeyFromPassword(password, salt, iterations = ZK_CONSTANTS.KDF_ITERATIONS) {
  const passwordBytes = utf8ToBytes(password);
  const saltBytes = typeof salt === 'string' ? hexToBytes(salt) : salt;

  return pbkdf2(sha256, passwordBytes, saltBytes, {
    c: iterations,
    dkLen: ZK_CONSTANTS.PBKDF2_KEY_LENGTH,
  });
}

/**
 * Hash a derived key for password verification
 * Server stores this hash to verify user without seeing the key
 * @param {Uint8Array} derivedKey - Derived key from password
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashDerivedKey(derivedKey) {
  const hash = sha256(derivedKey);
  return bytesToHex(hash);
}

// ==================== AES-GCM Encryption ====================

/**
 * Encrypt data using AES-256-GCM
 * @param {Uint8Array} plaintext - Data to encrypt
 * @param {Uint8Array} key - Encryption key (32 bytes)
 * @param {Uint8Array} [iv] - Initialization vector (12 bytes, auto-generated if not provided)
 * @returns {Object} { ciphertext: Uint8Array, iv: Uint8Array, tag: Uint8Array }
 */
export function encryptAESGCM(plaintext, key, iv = null) {
  if (key.length !== ZK_CONSTANTS.AES_KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${ZK_CONSTANTS.AES_KEY_LENGTH} bytes, got ${key.length}`);
  }

  const actualIV = iv || generateIV();

  // Create AES-GCM cipher
  const aes = gcm(key, actualIV);

  // Encrypt (GCM produces ciphertext with authentication tag appended)
  const encrypted = aes.encrypt(plaintext);

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS.GCM_TAG_LENGTH);

  return {
    ciphertext,
    iv: actualIV,
    tag,
  };
}

/**
 * Decrypt data using AES-256-GCM
 * @param {Uint8Array} ciphertext - Encrypted data
 * @param {Uint8Array} key - Decryption key (32 bytes)
 * @param {Uint8Array} iv - Initialization vector (12 bytes)
 * @param {Uint8Array} tag - Authentication tag (16 bytes)
 * @returns {Uint8Array} Decrypted plaintext
 * @throws {Error} If authentication fails or decryption fails
 */
export function decryptAESGCM(ciphertext, key, iv, tag) {
  if (key.length !== ZK_CONSTANTS.AES_KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${ZK_CONSTANTS.AES_KEY_LENGTH} bytes, got ${key.length}`);
  }

  if (iv.length !== ZK_CONSTANTS.GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${ZK_CONSTANTS.GCM_IV_LENGTH} bytes, got ${iv.length}`);
  }

  // Reconstruct full encrypted data (ciphertext + tag)
  const encrypted = new Uint8Array(ciphertext.length + tag.length);
  encrypted.set(ciphertext);
  encrypted.set(tag, ciphertext.length);

  // Create AES-GCM cipher
  const aes = gcm(key, iv);

  try {
    // Decrypt and verify authentication tag
    const plaintext = aes.decrypt(encrypted);
    return plaintext;
  } catch (error) {
    throw new Error('Decryption failed: Invalid key, corrupted data, or authentication tag mismatch');
  }
}

// ==================== Master Key Encryption ====================

/**
 * Encrypt the master key with a password-derived key
 * @param {Uint8Array} masterKey - Master key to encrypt (32 bytes)
 * @param {Uint8Array} derivedKey - Key derived from password (32 bytes)
 * @returns {Object} { encryptedMasterKey: string (base64), iv: string (base64) }
 */
export function encryptMasterKey(masterKey, derivedKey) {
  const { ciphertext, iv } = encryptAESGCM(masterKey, derivedKey);

  // Combine ciphertext and tag for storage
  const combined = new Uint8Array(ciphertext.length + ZK_CONSTANTS.GCM_TAG_LENGTH);
  combined.set(ciphertext);

  return {
    encryptedMasterKey: Buffer.from(combined).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

/**
 * Decrypt the master key with a password-derived key
 * @param {string} encryptedMasterKeyB64 - Base64-encoded encrypted master key
 * @param {Uint8Array} derivedKey - Key derived from password (32 bytes)
 * @param {string} ivB64 - Base64-encoded IV
 * @returns {Uint8Array} Decrypted master key (32 bytes)
 * @throws {Error} If decryption fails
 */
export function decryptMasterKey(encryptedMasterKeyB64, derivedKey, ivB64) {
  const encrypted = Buffer.from(encryptedMasterKeyB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, derivedKey, iv, tag);
}

// ==================== File Key Encryption ====================

/**
 * Encrypt a file encryption key with the master key
 * @param {Uint8Array} fileKey - File key to encrypt (32 bytes)
 * @param {Uint8Array} masterKey - Master key (32 bytes)
 * @returns {Object} { encryptedFileKey: string (base64), iv: string (base64) }
 */
export function encryptFileKey(fileKey, masterKey) {
  const { ciphertext, iv, tag } = encryptAESGCM(fileKey, masterKey);

  // Combine ciphertext and tag
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  return {
    encryptedFileKey: Buffer.from(combined).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

/**
 * Decrypt a file encryption key with the master key
 * @param {string} encryptedFileKeyB64 - Base64-encoded encrypted file key
 * @param {Uint8Array} masterKey - Master key (32 bytes)
 * @param {string} ivB64 - Base64-encoded IV
 * @returns {Uint8Array} Decrypted file key (32 bytes)
 * @throws {Error} If decryption fails
 */
export function decryptFileKey(encryptedFileKeyB64, masterKey, ivB64) {
  const encrypted = Buffer.from(encryptedFileKeyB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, masterKey, iv, tag);
}

// ==================== Chunk Encryption ====================

/**
 * Encrypt a file chunk with AES-256-GCM
 * @param {Uint8Array} chunkData - Chunk plaintext
 * @param {Uint8Array} fileKey - File encryption key (32 bytes)
 * @param {number} chunkIndex - Chunk index (used in IV generation for uniqueness)
 * @returns {Object} { encryptedChunk: Uint8Array, iv: string (base64) }
 */
export function encryptChunk(chunkData, fileKey, chunkIndex) {
  // Generate unique IV for this chunk using chunk index
  const baseIV = generateIV();
  const iv = new Uint8Array(ZK_CONSTANTS.GCM_IV_LENGTH);
  iv.set(baseIV);

  // XOR chunk index into last 4 bytes of IV for uniqueness
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, chunkIndex, false);
  for (let i = 0; i < 4; i++) {
    iv[ZK_CONSTANTS.GCM_IV_LENGTH - 4 + i] ^= indexBytes[i];
  }

  const { ciphertext, tag } = encryptAESGCM(chunkData, fileKey, iv);

  // IMPORTANT: Prepend IV to encrypted data (matches backend pattern)
  // Format: IV + ciphertext + tag
  // This allows decryption without storing IV separately
  const encryptedChunk = new Uint8Array(iv.length + ciphertext.length + tag.length);
  encryptedChunk.set(iv, 0);                        // Prepend IV
  encryptedChunk.set(ciphertext, iv.length);         // Then ciphertext
  encryptedChunk.set(tag, iv.length + ciphertext.length);  // Then tag

  return {
    encryptedChunk,  // Now includes IV at the beginning
    iv: Buffer.from(iv).toString('base64'),  // Also return IV for backward compatibility
  };
}

/**
 * Decrypt a file chunk with AES-256-GCM
 * @param {Uint8Array} encryptedChunk - Encrypted chunk (format: IV + ciphertext + tag)
 * @param {Uint8Array} fileKey - File decryption key (32 bytes)
 * @param {string|number} ivOrChunkIndex - Optional: Base64 IV (legacy) or chunk index (for AAD)
 * @returns {Uint8Array} Decrypted chunk data
 * @throws {Error} If decryption fails
 */
export function decryptChunk(encryptedChunk, fileKey, ivOrChunkIndex) {
  // Extract IV from the beginning of encrypted chunk (new format)
  // Format: IV (12 bytes) + ciphertext + tag (16 bytes)
  const IV_LENGTH = ZK_CONSTANTS.GCM_IV_LENGTH;
  const TAG_LENGTH = ZK_CONSTANTS.GCM_TAG_LENGTH;

  const iv = encryptedChunk.slice(0, IV_LENGTH);
  const ciphertextWithTag = encryptedChunk.slice(IV_LENGTH);
  const ciphertext = ciphertextWithTag.slice(0, -TAG_LENGTH);
  const tag = ciphertextWithTag.slice(-TAG_LENGTH);

  return decryptAESGCM(ciphertext, fileKey, iv, tag);
}

// ==================== Recovery Phrase (BIP39) ====================

/**
 * Generate a BIP39 recovery phrase (24 words)
 * @returns {string} Space-separated 24-word mnemonic
 */
export function generateRecoveryPhrase() {
  return generateMnemonic(ZK_CONSTANTS.RECOVERY_PHRASE_STRENGTH);
}

/**
 * Validate a BIP39 recovery phrase
 * @param {string} phrase - Space-separated mnemonic
 * @returns {boolean} True if valid
 */
export function validateRecoveryPhrase(phrase) {
  return validateMnemonic(phrase);
}

/**
 * Derive a key from a recovery phrase
 * @param {string} phrase - Space-separated mnemonic
 * @returns {Uint8Array} Derived key (32 bytes)
 */
export function deriveKeyFromRecoveryPhrase(phrase) {
  if (!validateMnemonic(phrase)) {
    throw new Error('Invalid recovery phrase');
  }

  const seed = mnemonicToSeedSync(phrase);

  // Use first 32 bytes of seed as the recovery key
  return seed.slice(0, 32);
}

/**
 * Hash a recovery phrase for server-side verification
 * @param {string} phrase - Space-separated mnemonic
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashRecoveryPhrase(phrase) {
  const phraseBytes = utf8ToBytes(phrase);
  const hash = sha256(phraseBytes);
  return bytesToHex(hash);
}

/**
 * Encrypt the master key with a recovery phrase-derived key
 * @param {Uint8Array} masterKey - Master key (32 bytes)
 * @param {string} recoveryPhrase - BIP39 mnemonic
 * @returns {Object} { recoveryEncryptedMasterKey: string (base64), recoveryPhraseHash: string (hex) }
 */
export function encryptMasterKeyWithRecovery(masterKey, recoveryPhrase) {
  const recoveryKey = deriveKeyFromRecoveryPhrase(recoveryPhrase);
  const { encryptedMasterKey, iv } = encryptMasterKey(masterKey, recoveryKey);

  return {
    recoveryEncryptedMasterKey: encryptedMasterKey,
    recoveryIV: iv,
    recoveryPhraseHash: hashRecoveryPhrase(recoveryPhrase),
  };
}

// ==================== Hashing ====================

/**
 * Compute SHA-256 hash of data
 * @param {Uint8Array|string} data - Data to hash
 * @returns {string} Hex-encoded hash
 */
export function sha256Hash(data) {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  const hash = sha256(bytes);
  return bytesToHex(hash);
}

/**
 * Compute SHA-256 hash of a file for integrity verification
 * @param {Uint8Array} fileData - File data
 * @returns {string} Hex-encoded hash
 */
export function computeFileHash(fileData) {
  return sha256Hash(fileData);
}

// ==================== Encoding Utilities ====================

/**
 * Convert Uint8Array to base64
 * @param {Uint8Array} bytes - Bytes to encode
 * @returns {string} Base64 string
 */
export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert base64 to Uint8Array
 * @param {string} base64 - Base64 string
 * @returns {Uint8Array} Decoded bytes
 */
export function base64ToBytes(base64) {
  return Buffer.from(base64, 'base64');
}

/**
 * Convert Uint8Array to hex
 * @param {Uint8Array} bytes - Bytes to encode
 * @returns {string} Hex string
 */
export function bytesToHexString(bytes) {
  return bytesToHex(bytes);
}

/**
 * Convert hex to Uint8Array
 * @param {string} hex - Hex string
 * @returns {Uint8Array} Decoded bytes
 */
export function hexStringToBytes(hex) {
  return hexToBytes(hex);
}

// ==================== Memory Management ====================

/**
 * Securely clear sensitive data from memory
 * Note: This is best-effort in JavaScript; true memory wiping isn't guaranteed
 * @param {Uint8Array} data - Sensitive data to clear
 */
export function secureClear(data) {
  if (data && data.fill) {
    data.fill(0);
  }
}

/**
 * Create a secure random ID for uploads
 * @returns {string} Random UUID-like ID
 */
export function generateUploadId() {
  const bytes = generateRandomBytes(16);
  return bytesToHex(bytes);
}

export default {
  ZK_CONSTANTS,
  generateRandomBytes,
  generateMasterKey,
  generateFileKey,
  generateSalt,
  generateIV,
  deriveKeyFromPassword,
  hashDerivedKey,
  encryptAESGCM,
  decryptAESGCM,
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
  sha256Hash,
  computeFileHash,
  bytesToBase64,
  base64ToBytes,
  bytesToHexString,
  hexStringToBytes,
  secureClear,
  generateUploadId,
};
