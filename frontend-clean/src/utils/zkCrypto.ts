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
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

// ==================== Constants ====================

export const ZK_CONSTANTS = {
  // Key Derivation
  KDF_ALGORITHM: 'pbkdf2' as const,
  KDF_ITERATIONS: 600000,
  PBKDF2_KEY_LENGTH: 32, // 256 bits

  // Encryption
  ENCRYPTION_ALGORITHM: 'AES-256-GCM' as const,
  AES_KEY_LENGTH: 32, // 256 bits
  GCM_IV_LENGTH: 12, // 96 bits (recommended for GCM)
  GCM_TAG_LENGTH: 16, // 128 bits

  // Recovery
  RECOVERY_PHRASE_WORDS: 24, // BIP39 mnemonic
  RECOVERY_PHRASE_STRENGTH: 256, // bits

  // Chunk Processing
  CHUNK_SIZE: 64 * 1024 * 1024, // 64 MiB (match backend)
  MAX_CONCURRENT_CHUNKS: 4,
} as const;

// ==================== Random Generation ====================

/**
 * Generate cryptographically secure random bytes
 */
export function generateRandomBytes(length: number): Uint8Array {
  return randomBytes(length);
}

/**
 * Generate a random 256-bit master key
 */
export function generateMasterKey(): Uint8Array {
  return generateRandomBytes(ZK_CONSTANTS.AES_KEY_LENGTH);
}

/**
 * Generate a random 256-bit file encryption key
 */
export function generateFileKey(): Uint8Array {
  return generateRandomBytes(ZK_CONSTANTS.AES_KEY_LENGTH);
}

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  return generateRandomBytes(32);
}

/**
 * Generate a random IV for AES-GCM encryption
 */
export function generateIV(): Uint8Array {
  return generateRandomBytes(ZK_CONSTANTS.GCM_IV_LENGTH);
}

// ==================== Key Derivation ====================

/**
 * Derive an encryption key from a password using PBKDF2
 */
export function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array | string,
  iterations: number = ZK_CONSTANTS.KDF_ITERATIONS
): Uint8Array {
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
 */
export function hashDerivedKey(derivedKey: Uint8Array): string {
  const hash = sha256(derivedKey);
  return bytesToHex(hash);
}

// ==================== AES-GCM Encryption ====================

interface AESGCMResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encryptAESGCM(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array | null = null
): AESGCMResult {
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
 * @throws {Error} If authentication fails or decryption fails
 */
export function decryptAESGCM(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array
): Uint8Array {
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

interface EncryptedMasterKey {
  encryptedMasterKey: string; // Base64
  iv: string; // Base64
}

/**
 * Encrypt the master key with a password-derived key
 */
export function encryptMasterKey(masterKey: Uint8Array, derivedKey: Uint8Array): EncryptedMasterKey {
  const { ciphertext, iv, tag } = encryptAESGCM(masterKey, derivedKey);

  // Combine ciphertext and tag for storage
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  return {
    encryptedMasterKey: bytesToBase64(combined),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt the master key with a password-derived key
 * @throws {Error} If decryption fails
 */
export function decryptMasterKey(
  encryptedMasterKeyB64: string,
  derivedKey: Uint8Array,
  ivB64: string
): Uint8Array {
  const encrypted = base64ToBytes(encryptedMasterKeyB64);
  const iv = base64ToBytes(ivB64);

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, derivedKey, iv, tag);
}

// ==================== File Key Encryption ====================

interface EncryptedFileKey {
  encryptedFileKey: string; // Base64
  iv: string; // Base64
}

/**
 * Encrypt a file encryption key with the master key
 */
export function encryptFileKey(fileKey: Uint8Array, masterKey: Uint8Array): EncryptedFileKey {
  const { ciphertext, iv, tag } = encryptAESGCM(fileKey, masterKey);

  // Combine ciphertext and tag
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  return {
    encryptedFileKey: bytesToBase64(combined),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt a file encryption key with the master key
 * @throws {Error} If decryption fails
 */
export function decryptFileKey(
  encryptedFileKeyB64: string,
  masterKey: Uint8Array,
  ivB64: string
): Uint8Array {
  const encrypted = base64ToBytes(encryptedFileKeyB64);
  const iv = base64ToBytes(ivB64);

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, masterKey, iv, tag);
}

// ==================== Chunk Encryption ====================

interface EncryptedChunk {
  encryptedData: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/**
 * Encrypt a file chunk with deterministic IV based on chunk index
 */
export function encryptChunk(chunkData: Uint8Array, fileKey: Uint8Array, chunkIndex: number): EncryptedChunk {
  // Generate deterministic IV from file key + chunk index
  const ivSeed = new Uint8Array(fileKey.length + 4);
  ivSeed.set(fileKey);

  // Add chunk index as 4 bytes (big-endian)
  const indexView = new DataView(ivSeed.buffer, fileKey.length, 4);
  indexView.setUint32(0, chunkIndex, false);

  const ivHash = sha256(ivSeed);
  const iv = ivHash.slice(0, ZK_CONSTANTS.GCM_IV_LENGTH);

  const { ciphertext, tag } = encryptAESGCM(chunkData, fileKey, iv);

  return {
    encryptedData: ciphertext,
    iv,
    tag,
  };
}

/**
 * Decrypt a file chunk
 * @param ivOrChunkIndex - Can be the IV directly (Uint8Array) or chunk index (number) for deterministic IV
 */
export function decryptChunk(
  encryptedChunk: Uint8Array,
  fileKey: Uint8Array,
  ivOrChunkIndex: Uint8Array | number
): Uint8Array {
  let iv: Uint8Array;

  if (typeof ivOrChunkIndex === 'number') {
    // Regenerate deterministic IV from chunk index
    const ivSeed = new Uint8Array(fileKey.length + 4);
    ivSeed.set(fileKey);
    const indexView = new DataView(ivSeed.buffer, fileKey.length, 4);
    indexView.setUint32(0, ivOrChunkIndex, false);
    const ivHash = sha256(ivSeed);
    iv = ivHash.slice(0, ZK_CONSTANTS.GCM_IV_LENGTH);
  } else {
    iv = ivOrChunkIndex;
  }

  // Assume encryptedChunk = ciphertext + tag
  const ciphertext = encryptedChunk.slice(0, -ZK_CONSTANTS.GCM_TAG_LENGTH);
  const tag = encryptedChunk.slice(-ZK_CONSTANTS.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, fileKey, iv, tag);
}

// ==================== Recovery Phrase ====================

/**
 * Generate a 24-word BIP39 recovery phrase
 */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(englishWordlist, ZK_CONSTANTS.RECOVERY_PHRASE_STRENGTH);
}

/**
 * Validate a recovery phrase
 */
export function validateRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(phrase, englishWordlist);
}

/**
 * Derive a master key from a recovery phrase
 */
export function deriveKeyFromRecoveryPhrase(phrase: string): Uint8Array {
  if (!validateRecoveryPhrase(phrase)) {
    throw new Error('Invalid recovery phrase');
  }

  // Derive 512-bit seed from mnemonic
  const seed = mnemonicToSeedSync(phrase);

  // Use first 32 bytes as master key
  return seed.slice(0, ZK_CONSTANTS.AES_KEY_LENGTH);
}

/**
 * Hash recovery phrase for verification (server-side storage)
 */
export function hashRecoveryPhrase(phrase: string): string {
  const phraseBytes = utf8ToBytes(phrase);
  return sha256Hash(phraseBytes);
}

/**
 * Encrypt master key with recovery phrase
 */
export function encryptMasterKeyWithRecovery(masterKey: Uint8Array, recoveryPhrase: string): EncryptedMasterKey {
  const recoveryKey = deriveKeyFromRecoveryPhrase(recoveryPhrase);
  return encryptMasterKey(masterKey, recoveryKey);
}

// ==================== Hashing ====================

/**
 * Compute SHA-256 hash of data
 */
export function sha256Hash(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  const hash = sha256(bytes);
  return bytesToHex(hash);
}

/**
 * Compute SHA-256 hash of a file for integrity verification
 */
export function computeFileHash(fileData: Uint8Array): string {
  return sha256Hash(fileData);
}

// ==================== Encoding Utilities ====================

/**
 * Convert Uint8Array to base64 (browser-native implementation)
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Use native browser APIs instead of Buffer for better compatibility
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

/**
 * Convert base64 to Uint8Array (browser-native implementation)
 */
export function base64ToBytes(base64: string): Uint8Array {
  // Use native browser APIs instead of Buffer for better compatibility
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex
 */
export function bytesToHexString(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/**
 * Convert hex to Uint8Array
 */
export function hexStringToBytes(hex: string): Uint8Array {
  return hexToBytes(hex);
}

// ==================== Memory Management ====================

/**
 * Securely clear sensitive data from memory
 * Note: This is best-effort in JavaScript; true memory wiping isn't guaranteed
 */
export function secureClear(data: Uint8Array | undefined | null): void {
  if (data?.fill) {
    data.fill(0);
  }
}

/**
 * Create a secure random ID for uploads
 */
export function generateUploadId(): string {
  const bytes = generateRandomBytes(16);
  return bytesToHex(bytes);
}

// Default export for backward compatibility
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
