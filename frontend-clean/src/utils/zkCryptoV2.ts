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
} as const;

// HKDF context labels - NEVER reuse these
export const HKDF_LABELS = {
  METADATA: 'meta:v1',
  SHARE: 'share:v1',
  FILE: (fileId: string): string => `file:${fileId}`,
  CHUNK: (index: number): string => `chunk:${index}`,
  THUMBNAIL: 'thumb:v1',
  RECOVERY: 'recovery:v1',
  FILENAME: 'filename:v1',
} as const;

// ==================== Browser Detection ====================

export interface BrowserInfo {
  isSafari: boolean;
  isIOS: boolean;
  isMacOS: boolean;
}

/**
 * Detect Safari browser for memory-constrained Argon2 parameters
 */
export function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isMacOS = /Mac OS X/.test(ua) && !isIOS;

  return { isSafari, isIOS, isMacOS };
}

/**
 * Get appropriate Argon2 memory parameter for current browser
 * @returns Memory in KiB
 */
export function getArgon2Memory(): number {
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
 */
export function generateRandomBytes(length: number): Uint8Array {
  return randomBytes(length);
}

/**
 * Generate a random 256-bit master key
 * @returns 32 bytes
 */
export function generateMasterKey(): Uint8Array {
  return generateRandomBytes(ZK_CONSTANTS_V2.KEY_LENGTH);
}

/**
 * Generate a random salt for key derivation
 * @returns 32 bytes
 */
export function generateSalt(): Uint8Array {
  return generateRandomBytes(ZK_CONSTANTS_V2.SALT_LENGTH);
}

/**
 * Generate a random IV for AES-GCM
 * @returns 12 bytes
 */
export function generateIV(): Uint8Array {
  return generateRandomBytes(ZK_CONSTANTS_V2.GCM_IV_LENGTH);
}

// ==================== Argon2id Key Derivation ====================

interface Argon2Module {
  hash: (options: Argon2HashOptions) => Promise<Argon2Result>;
  ArgonType?: {
    Argon2id?: number;
  };
}

interface Argon2HashOptions {
  pass: string;
  salt: Uint8Array;
  time: number;
  mem: number;
  parallelism: number;
  hashLen: number;
  type: number;
}

interface Argon2Result {
  hash: ArrayBuffer;
  hashHex: string;
}

declare global {
  interface Window {
    MSStream?: unknown;
  }
}

let argon2Module: Argon2Module | null = null;
let argon2LoadPromise: Promise<Argon2Module> | null = null;

/**
 * Load Argon2 via ES module import (consistent with web worker implementation)
 */
async function getArgon2(): Promise<Argon2Module> {
  if (argon2Module) return argon2Module;
  if (argon2LoadPromise) return argon2LoadPromise;

  argon2LoadPromise = (async () => {
    try {
      // Dynamic import for better code splitting and tree-shaking
      const argon2 = await import('argon2-browser');
      
      // Handle both default and named exports (consistent with worker implementation)
      argon2Module = (argon2 as { default?: Argon2Module }).default ?? (argon2 as unknown as Argon2Module);
      
      if (!argon2Module || typeof argon2Module.hash !== 'function') {
        throw new Error('Argon2 module loaded but hash function not found');
      }
      
      console.log('[ZK] Argon2 loaded via ES module import');
      return argon2Module;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load Argon2 module: ${errorMessage}`);
    }
  })();

  return argon2LoadPromise;
}

export interface Argon2Options {
  iterations?: number;
  parallelism?: number;
}

/**
 * Derive a key from password using Argon2id
 * Falls back to lower memory if allocation fails
 *
 * @param password - User password
 * @param salt - Salt (32 bytes)
 * @param options - Optional overrides
 * @returns Derived key (32 bytes)
 * @throws {Error} If Argon2id fails completely
 */
export async function deriveKeyArgon2id(
  password: string,
  salt: Uint8Array,
  options: Argon2Options = {}
): Promise<Uint8Array> {
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
        time: options.iterations ?? ZK_CONSTANTS_V2.ARGON2_ITERATIONS,
        mem: memory,
        parallelism: options.parallelism ?? ZK_CONSTANTS_V2.ARGON2_PARALLELISM,
        hashLen: ZK_CONSTANTS_V2.KEY_LENGTH,
        type: ARGON2ID_TYPE,
      });

      return new Uint8Array(result.hash);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isMemoryError =
        errorMessage.includes('memory') ||
        errorMessage.includes('allocation') ||
        errorMessage.includes('OOM');

      if (!isMemoryError || memory === levelsToTry[levelsToTry.length - 1]) {
        throw new Error(`Argon2id failed: ${errorMessage}`);
      }
      // Try next lower memory level
      console.warn(`Argon2id: Memory ${memory}KB failed, trying lower...`);
    }
  }

  throw new Error('Argon2id failed at all memory levels');
}

/**
 * PBKDF2 fallback - ONLY use with explicit user consent
 */
export function deriveKeyPBKDF2Fallback(password: string, salt: Uint8Array): Uint8Array {
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
 * @param masterKey - Input key material
 * @param label - Context label (unique per key type)
 * @returns Derived key (32 bytes)
 */
export function deriveKeyHKDF(masterKey: Uint8Array, label: string): Uint8Array {
  const info = utf8ToBytes(label);
  return hkdf(sha256, masterKey, undefined, info, ZK_CONSTANTS_V2.KEY_LENGTH);
}

/**
 * Derive metadata encryption key
 */
export function deriveMetadataKey(masterKey: Uint8Array): Uint8Array {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.METADATA);
}

/**
 * Derive share encryption key
 */
export function deriveShareKey(masterKey: Uint8Array): Uint8Array {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.SHARE);
}

/**
 * Derive file encryption key
 */
export function deriveFileKey(masterKey: Uint8Array, fileId: string): Uint8Array {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.FILE(fileId));
}

/**
 * Derive chunk encryption key
 */
export function deriveChunkKey(fileKey: Uint8Array, chunkIndex: number): Uint8Array {
  return deriveKeyHKDF(fileKey, HKDF_LABELS.CHUNK(chunkIndex));
}

/**
 * Derive thumbnail encryption key
 */
export function deriveThumbnailKey(fileKey: Uint8Array): Uint8Array {
  return deriveKeyHKDF(fileKey, HKDF_LABELS.THUMBNAIL);
}

/**
 * Derive recovery key from BIP39 seed
 * @param seed - Full BIP39 seed (64 bytes)
 */
export function deriveRecoveryKey(seed: Uint8Array): Uint8Array {
  return deriveKeyHKDF(seed, HKDF_LABELS.RECOVERY);
}

/**
 * Derive filename encryption key
 */
export function deriveFilenameKey(masterKey: Uint8Array): Uint8Array {
  return deriveKeyHKDF(masterKey, HKDF_LABELS.FILENAME);
}

// ==================== AES-GCM Encryption with AAD ====================

interface AESGCMResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/**
 * Encrypt data using AES-256-GCM with Additional Authenticated Data
 * @param plaintext
 * @param key - 32 bytes
 * @param aad - Additional authenticated data (optional)
 * @param iv - 12 bytes (optional, auto-generated if not provided)
 */
export function encryptAESGCM(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array | null = null,
  iv: Uint8Array | null = null
): AESGCMResult {
  if (key.length !== ZK_CONSTANTS_V2.KEY_LENGTH) {
    throw new Error(`Invalid key length: ${key.length}, expected ${ZK_CONSTANTS_V2.KEY_LENGTH}`);
  }

  const actualIV = iv ?? generateIV();
  const cipher = aad ? gcm(key, actualIV, aad) : gcm(key, actualIV);
  const encrypted = cipher.encrypt(plaintext);

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS_V2.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS_V2.GCM_TAG_LENGTH);

  return { ciphertext, iv: actualIV, tag };
}

/**
 * Decrypt data using AES-256-GCM with AAD verification
 * @param ciphertext
 * @param key
 * @param iv
 * @param tag
 * @param aad - Must match encryption AAD
 */
export function decryptAESGCM(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array | null = null
): Uint8Array {
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
 * @param chunkData
 * @param fileKey
 * @param fileId
 * @param chunkIndex
 * @returns Encrypted chunk with version prefix
 */
export function encryptChunkV2(
  chunkData: Uint8Array,
  fileKey: Uint8Array,
  fileId: string,
  chunkIndex: number
): Uint8Array {
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
 */
export function decryptChunkV2(
  encryptedChunk: Uint8Array,
  fileKey: Uint8Array,
  fileId: string,
  chunkIndex: number
): Uint8Array {
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

interface EncryptedMasterKey {
  encryptedMasterKey: string;
  iv: string;
}

/**
 * Encrypt master key with password-derived key
 */
export function encryptMasterKeyV2(
  masterKey: Uint8Array,
  derivedKey: Uint8Array
): EncryptedMasterKey {
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
 */
export function decryptMasterKeyV2(
  encryptedMasterKeyB64: string,
  derivedKey: Uint8Array,
  ivB64: string
): Uint8Array {
  const encrypted = base64ToBytes(encryptedMasterKeyB64);
  const iv = base64ToBytes(ivB64);

  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS_V2.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS_V2.GCM_TAG_LENGTH);

  return decryptAESGCM(ciphertext, derivedKey, iv, tag);
}

// ==================== Metadata Encryption ====================

interface FileMetadata {
  name: string;
  path?: string;
  size: number;
  mime: string;
  created: string | number;
}

/**
 * Encrypt file metadata
 * @param metadata - { name, path, size, mime, created }
 * @param masterKey
 * @returns Base64 encoded encrypted metadata
 */
export function encryptMetadata(metadata: FileMetadata, masterKey: Uint8Array): string {
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
 */
export function decryptMetadata(encryptedMetadataB64: string, masterKey: Uint8Array): FileMetadata {
  const encrypted = base64ToBytes(encryptedMetadataB64);

  const IV_LENGTH = ZK_CONSTANTS_V2.GCM_IV_LENGTH;
  const TAG_LENGTH = ZK_CONSTANTS_V2.GCM_TAG_LENGTH;

  const iv = encrypted.slice(0, IV_LENGTH);
  const ciphertext = encrypted.slice(IV_LENGTH, -TAG_LENGTH);
  const tag = encrypted.slice(-TAG_LENGTH);

  const metadataKey = deriveMetadataKey(masterKey);
  const plaintext = decryptAESGCM(ciphertext, metadataKey, iv, tag);

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(plaintext)) as FileMetadata;
}

// ==================== Filename Encryption ====================

interface EncryptedFilename {
  encryptedFilename: string;
  filenameIV: string;
}

/**
 * Encrypt filename for ZK storage
 * @param filename - Plaintext filename
 * @param masterKey
 * @returns { encryptedFilename, filenameIV } - Base64 encoded
 */
export function encryptFilename(filename: string, masterKey: Uint8Array): EncryptedFilename {
  const filenameKey = deriveFilenameKey(masterKey);
  const plaintext = utf8ToBytes(filename);

  const { ciphertext, iv, tag } = encryptAESGCM(plaintext, filenameKey);

  // Combine ciphertext + tag
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  return {
    encryptedFilename: bytesToBase64(combined),
    filenameIV: bytesToBase64(iv),
  };
}

/**
 * Decrypt filename from ZK storage
 * @param encryptedFilenameB64 - Base64 encoded encrypted filename
 * @param filenameIVB64 - Base64 encoded IV
 * @param masterKey
 * @returns Decrypted filename
 */
export function decryptFilename(
  encryptedFilenameB64: string,
  filenameIVB64: string,
  masterKey: Uint8Array
): string {
  const encrypted = base64ToBytes(encryptedFilenameB64);
  const iv = base64ToBytes(filenameIVB64);

  const ciphertext = encrypted.slice(0, -ZK_CONSTANTS_V2.GCM_TAG_LENGTH);
  const tag = encrypted.slice(-ZK_CONSTANTS_V2.GCM_TAG_LENGTH);

  const filenameKey = deriveFilenameKey(masterKey);
  const plaintext = decryptAESGCM(ciphertext, filenameKey, iv, tag);

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

// ==================== Version Detection ====================

export type EncryptionVersion = 'v1' | 'v2';

/**
 * Detect encryption version from encrypted data
 */
export function detectEncryptionVersion(encryptedData: Uint8Array): EncryptionVersion {
  if (encryptedData[0] === ZK_CONSTANTS_V2.VERSION) {
    return 'v2';
  }
  return 'v1'; // Legacy format
}

// ==================== Hashing ====================

/**
 * Hash a derived key for server verification
 * @returns Hex string
 */
export function hashDerivedKey(derivedKey: Uint8Array): string {
  const hash = sha256(derivedKey);
  return bytesToHex(hash);
}

// ==================== Encoding Utilities ====================

/**
 * Convert Uint8Array to base64
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

/**
 * Convert base64 to Uint8Array
 */
export function base64ToBytes(base64: string): Uint8Array {
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
 */
export function secureClear(data: Uint8Array | null | undefined): void {
  if (data?.fill) {
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
  deriveFilenameKey,
  encryptAESGCM,
  decryptAESGCM,
  encryptChunkV2,
  decryptChunkV2,
  encryptMasterKeyV2,
  decryptMasterKeyV2,
  encryptMetadata,
  decryptMetadata,
  encryptFilename,
  decryptFilename,
  detectEncryptionVersion,
  hashDerivedKey,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  secureClear,
};
