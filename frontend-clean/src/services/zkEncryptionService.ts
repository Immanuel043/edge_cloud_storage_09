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
  decryptAESGCM,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  deriveKeyFromRecoveryPhrase,
  hashRecoveryPhrase,
  encryptMasterKeyWithRecovery,
  computeFileHash,
  bytesToHexString,
  secureClear,
  generateUploadId,
  ZK_CONSTANTS,
} from '../utils/zkCrypto';

// Import Argon2id functions from V2
import {
  deriveKeyArgon2id,
  getArgon2Memory,
  ZK_CONSTANTS_V2,
  deriveMetadataKey,
  encryptAESGCM as encryptAESGCMv2,
  decryptAESGCM as decryptAESGCMv2,
  bytesToBase64 as bytesToBase64v2,
  base64ToBytes as base64ToBytesv2,
  encryptFilename as encryptFilenameV2,
  decryptFilename as decryptFilenameV2,
  encryptChunkV2,
  decryptChunkV2,
} from '../utils/zkCryptoV2';

// Import worker pool for background encryption
import { getEncryptWorkerPool } from '../workers/zkEncryptWorkerPool';

// ==================== Type Definitions ====================

interface ZKRegistrationData {
  passwordHash: string;
  encryptedMasterKey: string;
  kdfSalt: string;
  kdfAlgorithm: 'argon2id';
  kdfIterations: number;
  kdfMemory: number;
  kdfParallelism: number;
  masterKeyIV: string;
}

interface ZKData {
  kdfSalt: string;
  encryptedMasterKey: string;
  kdfAlgorithm?: 'argon2id' | 'pbkdf2';
  kdfIterations?: number;
  masterKeyIV?: string;
  kdf_iv?: string;
}

interface RecoveryPhraseData {
  recoveryPhrase: string;
  recoveryEncryptedMasterKey: string;
  recoveryIV: string;
  recoveryPhraseHash: string;
}

interface FilePreparationData {
  fileKey: Uint8Array;
  encryptedFileKey: string;
  fileKeyIV: string;
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  encryptionAlgorithm: string;
  chunkSize: number;
}

interface EncryptedChunk {
  index: number;
  data: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  size: number;
}

interface EncryptedFileResult {
  encryptedChunks: EncryptedChunk[];
  encryptedFileKey: string;
  fileKeyIV: string;
  fileKey: Uint8Array;
  fileHash: string;
  totalChunks: number;
  originalSize: number;
  encryptedSize: number;
  metadata: {
    fileName: string;
    mimeType: string;
    encryptionAlgorithm: string;
  };
}

interface FileMetadata {
  name: string;
  path: string;
  size: number;
  mime: string;
  created: string;
}

interface EncryptedMetadataResult {
  encryptedMetadata: string;
  plaintextHints: {
    sizeHint: number;
    typeHint: string;
  };
}

interface EncryptedFilenameResult {
  encryptedFilename: string;
  filenameIV: string;
}

interface FileChunkInfo {
  index: number;
  start: number;
  end: number;
  size: number;
}

interface ZKSessionStatus {
  isUnlocked: boolean;
  hasMasterKey: boolean;
  hasDerivedKey: boolean;
}

interface ZKSessionDebugInfo extends ZKSessionStatus {
  masterKeyLength?: number | undefined;
  derivedKeyLength?: number | undefined;
}

interface ReEncryptionData {
  passwordHash: string;
  encryptedMasterKey: string;
  kdfSalt: string;
  kdfAlgorithm: 'argon2id';
  kdfIterations: number;
  kdfMemory: number;
  kdfParallelism: number;
  masterKeyIV: string;
}

// ==================== Session State Management ====================

class ZKEncryptionSession {
  private masterKey: Uint8Array | null;
  private derivedKey: Uint8Array | null;
  private isUnlocked: boolean;

  constructor() {
    this.masterKey = null;
    this.derivedKey = null;
    this.isUnlocked = false;
  }

  /**
   * Set the master key in memory (session only)
   * @param masterKey - Master key (32 bytes)
   */
  setMasterKey(masterKey: Uint8Array): void {
    this.masterKey = masterKey;
    this.isUnlocked = true;
  }

  /**
   * Set the derived key in memory (for password verification)
   * @param derivedKey - Derived key from password
   */
  setDerivedKey(derivedKey: Uint8Array): void {
    this.derivedKey = derivedKey;
  }

  /**
   * Get the master key
   * @returns Master key or throws if locked
   */
  getMasterKey(): Uint8Array {
    if (!this.isUnlocked || !this.masterKey) {
      throw new Error('ZK encryption session is locked. Please unlock first.');
    }
    return this.masterKey;
  }

  /**
   * Get the derived key
   * @returns Derived key or null
   */
  getDerivedKey(): Uint8Array | null {
    return this.derivedKey;
  }

  /**
   * Check if session is unlocked
   * @returns True if unlocked
   */
  isSessionUnlocked(): boolean {
    return this.isUnlocked && this.masterKey !== null;
  }

  /**
   * Lock the session and clear sensitive data from memory
   */
  lock(): void {
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
  clear(): void {
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
 * @param password - User password
 * @returns Registration data for backend
 */
export async function generateZKRegistrationData(password: string): Promise<ZKRegistrationData> {
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
    kdfAlgorithm: 'argon2id', // New registrations use Argon2id
    kdfIterations: ZK_CONSTANTS_V2.ARGON2_ITERATIONS,
    kdfMemory: argon2Memory,
    kdfParallelism: ZK_CONSTANTS_V2.ARGON2_PARALLELISM,
    masterKeyIV: iv,
  };
}

// In-flight promise guard to prevent duplicate Argon2 execution
let unlockInFlight: Promise<boolean> | null = null;

/**
 * Unlock ZK session after login (async)
 * Supports Argon2id (primary) and PBKDF2 (low-memory device fallback)
 * 
 * Includes guards to prevent:
 * - Re-unlocking an already unlocked session
 * - Concurrent unlock attempts (shares single Argon2 execution)
 *
 * @param password - User password
 * @param zkData - ZK data from backend (kdfSalt, encryptedMasterKey, kdfAlgorithm, etc.)
 * @returns True if unlock successful
 */
export async function unlockZKSession(password: string, zkData: ZKData): Promise<boolean> {
  // Guard 1: Already unlocked - skip expensive Argon2
  if (zkSession.isSessionUnlocked()) {
    console.log('[ZK] Session already unlocked, skipping duplicate unlock');
    return true;
  }

  // Guard 2: Unlock already in progress - share the promise
  if (unlockInFlight) {
    console.log('[ZK] Unlock already in progress, waiting for existing operation');
    return unlockInFlight;
  }

  // Start the unlock operation
  unlockInFlight = (async () => {
    try {
      console.log('[ZK] Starting session unlock...');

      const {
        kdfSalt,
        encryptedMasterKey,
        kdfAlgorithm = 'argon2id',
        kdfIterations = ZK_CONSTANTS.KDF_ITERATIONS,
      } = zkData;

      if (!kdfSalt) {
        throw new Error('KDF salt is missing');
      }
      if (!encryptedMasterKey) {
        throw new Error('Encrypted master key is missing');
      }

      // Derive key from password using appropriate algorithm
      let derivedKey: Uint8Array;
      if (kdfAlgorithm === 'argon2id') {
        const saltBytes =
          typeof kdfSalt === 'string'
            ? new Uint8Array(
                (kdfSalt.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16))
              )
            : kdfSalt;
        derivedKey = await deriveKeyArgon2id(password, saltBytes);
      } else {
        derivedKey = deriveKeyFromPassword(password, kdfSalt, kdfIterations);
      }

      // Extract IV
      const iv = zkData.masterKeyIV || zkData.kdf_iv;
      if (!iv) {
        throw new Error('Master key IV is missing');
      }

      // Decrypt master key
      const masterKey = decryptMasterKey(encryptedMasterKey, derivedKey, iv);

      // Store in session
      zkSession.setMasterKey(masterKey);
      zkSession.setDerivedKey(derivedKey);

      console.log('[ZK] Session unlocked successfully');
      return true;
    } catch (error) {
      console.error('[ZK] Failed to unlock ZK session:', (error as Error).message);
      return false;
    } finally {
      // Clear the in-flight guard
      unlockInFlight = null;
    }
  })();

  return unlockInFlight;
}

/**
 * Lock ZK session (on logout or manual lock)
 */
export function lockZKSession(): void {
  zkSession.lock();
}

/**
 * Check if ZK session is unlocked
 * @returns True if session is unlocked
 */
export function isZKSessionUnlocked(): boolean {
  return zkSession.isSessionUnlocked();
}

/**
 * Get password hash for login (async)
 * Supports Argon2id (primary) and PBKDF2 (low-memory device fallback)
 *
 * @param password - User password
 * @param kdfSalt - KDF salt (hex string)
 * @param kdfIterations - KDF iterations
 * @param kdfAlgorithm - KDF algorithm ('argon2id' or 'pbkdf2')
 * @returns Password hash for backend verification
 */
export async function getPasswordHashForLogin(
  password: string,
  kdfSalt: string,
  kdfIterations: number = ZK_CONSTANTS.KDF_ITERATIONS,
  kdfAlgorithm: 'argon2id' | 'pbkdf2' = 'argon2id'
): Promise<string> {
  let derivedKey: Uint8Array;

  if (kdfAlgorithm === 'argon2id') {
    // Use Argon2id (primary - memory-hard, GPU-resistant)
    console.log('[ZK] Login: Using Argon2id for key derivation');
    const saltBytes =
      typeof kdfSalt === 'string'
        ? new Uint8Array((kdfSalt.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16)))
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
 * @returns { recoveryPhrase, recoveryEncryptedMasterKey, recoveryPhraseHash }
 */
export function generateRecoveryPhraseData(): RecoveryPhraseData {
  const masterKey = zkSession.getMasterKey();

  // Generate BIP39 recovery phrase (now synchronous with @scure/bip39)
  const recoveryPhrase = generateRecoveryPhrase();

  // Encrypt master key with recovery phrase
  const { encryptedMasterKey, iv } = encryptMasterKeyWithRecovery(masterKey, recoveryPhrase);

  // Hash recovery phrase for backend verification
  const recoveryPhraseHash = hashRecoveryPhrase(recoveryPhrase);

  return {
    recoveryPhrase, // Show this to user ONCE
    recoveryEncryptedMasterKey: encryptedMasterKey,
    recoveryIV: iv,
    recoveryPhraseHash, // Send to backend for verification
  };
}

/**
 * Verify recovery phrase
 * @param recoveryPhrase - Recovery phrase entered by user
 * @returns True if valid
 */
export function verifyRecoveryPhrase(recoveryPhrase: string): boolean {
  return validateRecoveryPhrase(recoveryPhrase);
}

/**
 * Recover master key from recovery phrase
 * @param recoveryPhrase - Recovery phrase
 * @param recoveryEncryptedMasterKey - Encrypted master key (base64)
 * @param recoveryIV - Recovery IV (base64)
 * @returns True if recovery successful
 */
export function recoverMasterKeyFromPhrase(
  recoveryPhrase: string,
  recoveryEncryptedMasterKey: string,
  recoveryIV: string
): boolean {
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
 * @param recoveryPhrase - Recovery phrase
 * @returns SHA-256 hash (hex)
 */
export function getRecoveryPhraseHash(recoveryPhrase: string): string {
  return hashRecoveryPhrase(recoveryPhrase);
}

/**
 * Re-encrypt the current session's master key with a new password
 * Used after recovery to set a new password
 * @param newPassword - New password
 * @returns { passwordHash, encryptedMasterKey, kdfSalt, kdfAlgorithm, kdfIterations, kdfMemory, kdfParallelism, masterKeyIV }
 */
export async function reEncryptMasterKeyWithNewPassword(
  newPassword: string
): Promise<ReEncryptionData> {
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
 * @param file - File to encrypt
 * @param _progressCallback - Progress callback (optional)
 * @returns Upload preparation data
 */
export async function prepareFileForEncryption(
  file: File,
  _progressCallback: ((progress: number) => void) | null = null
): Promise<FilePreparationData> {
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
 * Encrypt a file chunk (V1 - backward compatibility)
 * @param chunkData - Chunk data
 * @param fileKey - File encryption key
 * @param chunkIndex - Chunk index
 * @returns { encryptedData, iv, tag }
 */
export function encryptFileChunk(
  chunkData: Uint8Array,
  fileKey: Uint8Array,
  chunkIndex: number
): { encryptedData: Uint8Array; iv: Uint8Array; tag: Uint8Array } {
  return encryptChunk(chunkData, fileKey, chunkIndex);
}

/**
 * Encrypt a file chunk with V2 encryption (HKDF + AAD)
 * @param chunkData - Chunk data
 * @param fileKey - File encryption key
 * @param fileId - File/Upload ID (used in AAD to prevent chunk reordering)
 * @param chunkIndex - Chunk index
 * @returns Encrypted chunk as single Uint8Array (VERSION + IV + ciphertext + tag)
 */
export function encryptFileChunkV2(
  chunkData: Uint8Array,
  fileKey: Uint8Array,
  fileId: string,
  chunkIndex: number
): Uint8Array {
  return encryptChunkV2(chunkData, fileKey, fileId, chunkIndex);
}

/**
 * Encrypt entire file in chunks
 * @param file - File to encrypt
 * @param progressCallback - Progress callback (bytesEncrypted, totalBytes)
 * @returns { encryptedChunks, fileKey, encryptedFileKey, metadata }
 */
export async function encryptFile(
  file: File,
  progressCallback: ((bytesEncrypted: number, totalBytes: number) => void) | null = null
): Promise<EncryptedFileResult> {
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
  const encryptedChunks: EncryptedChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileData.length);
    const chunkData = fileData.slice(start, end);

    const { encryptedData, iv, tag } = encryptChunk(chunkData, fileKey, i);

    encryptedChunks.push({
      index: i,
      data: encryptedData,
      iv,
      tag,
      size: encryptedData.length,
    });

    if (progressCallback) {
      progressCallback(end, fileData.length);
    }
  }

  return {
    encryptedChunks,
    encryptedFileKey,
    fileKeyIV,
    fileKey, // Include plaintext file key for thumbnail encryption
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

/**
 * Encrypt entire file in chunks using V2 encryption (HKDF + AAD)
 * @param file - File to encrypt
 * @param fileId - File/Upload ID (used in AAD to prevent chunk reordering attacks)
 * @param progressCallback - Progress callback (bytesEncrypted, totalBytes)
 * @returns { encryptedChunks, fileKey, encryptedFileKey, metadata }
 */
export async function encryptFileV2(
  file: File,
  fileId: string,
  progressCallback: ((bytesEncrypted: number, totalBytes: number) => void) | null = null
): Promise<EncryptedFileResult> {
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

  // ✅ OPTIMIZED: Parallel encryption using worker pool (non-blocking)
  const workerPool = getEncryptWorkerPool();
  const encryptionPromises: Promise<{ index: number; data: Uint8Array }>[] = [];

  console.log(`[ZK Encrypt] Starting parallel encryption of ${totalChunks} chunks using worker pool`);

  // Queue all chunks for parallel encryption
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileData.length);
    const chunkData = fileData.slice(start, end);

    // ✅ Offload to worker pool (non-blocking)
    const encryptPromise = workerPool
      .encryptChunk(chunkData, fileKey, fileId, i)
      .then((encryptedData) => ({
        index: i,
        data: encryptedData,
      }));

    encryptionPromises.push(encryptPromise);
  }

  // Wait for all chunks to be encrypted in parallel
  const encryptedChunkResults = await Promise.all(encryptionPromises);

  // Sort by index to maintain order
  encryptedChunkResults.sort((a, b) => a.index - b.index);

  // Convert to EncryptedChunk format
  const encryptedChunks: EncryptedChunk[] = encryptedChunkResults.map(({ index, data }) => ({
    index,
    data, // Complete V2 chunk with VERSION byte
    iv: new Uint8Array(0), // Empty - IV is embedded in data
    tag: new Uint8Array(0), // Empty - tag is embedded in data
    size: data.length,
  }));

  // Call progress callback with final value
  if (progressCallback) {
    progressCallback(fileData.length, fileData.length);
  }

  console.log(`[ZK Encrypt] Parallel encryption complete: ${encryptedChunks.length} chunks`);

  return {
    encryptedChunks,
    encryptedFileKey,
    fileKeyIV,
    fileKey, // Include plaintext file key for thumbnail encryption
    fileHash,
    totalChunks,
    originalSize: file.size,
    encryptedSize: encryptedChunks.reduce((sum, chunk) => sum + chunk.size, 0),
    metadata: {
      fileName: file.name,
      mimeType: file.type,
      encryptionAlgorithm: 'AES-256-GCM',
    },
  };
}

// ==================== File Decryption ====================

/**
 * Decrypt a file chunk with automatic version detection and fallback strategies
 * @param encryptedChunk - Encrypted chunk data
 * @param fileKey - File decryption key
 * @param fileIdOrChunkIndex - File ID (for V2) or chunk index (for V1)
 * @param chunkIndex - Chunk index (optional, only used if first param is fileId)
 * @returns Decrypted chunk data
 */
export function decryptFileChunk(
  encryptedChunk: Uint8Array,
  fileKey: Uint8Array,
  fileIdOrChunkIndex: string | number = 0,
  chunkIndex?: number
): Uint8Array {
  const version = encryptedChunk[0];
  const fileId = typeof fileIdOrChunkIndex === 'string' ? fileIdOrChunkIndex : '';
  const index = chunkIndex !== undefined ? chunkIndex : (typeof fileIdOrChunkIndex === 'number' ? fileIdOrChunkIndex : 0);

  // Strategy 1: V2 encryption (VERSION + IV + ciphertext + tag)
  if (version === ZK_CONSTANTS_V2.VERSION) {
    try {
      return decryptChunkV2(encryptedChunk, fileKey, fileId, index);
    } catch (v2Error) {
      console.warn('[ZK] V2 decryption failed, trying fallbacks:', v2Error);
    }
  }

  // Strategy 2: V1 encryption (deterministic IV from fileKey + chunkIndex)
  // Format: ciphertext + tag (no prepended IV)
  try {
    const result = decryptChunk(encryptedChunk, fileKey, index);
    console.log('[ZK] Decryption succeeded with V1 strategy (deterministic IV)');
    return result;
  } catch (v1Error) {
    console.warn('[ZK] V1 decryption failed, trying IV-prepended format');
  }

  // Strategy 3: IV-prepended format (IV + ciphertext + tag) - no version byte
  // This handles legacy encryption that may have stored IV at the beginning
  try {
    const IV_LENGTH = 12;
    const TAG_LENGTH = 16;
    
    if (encryptedChunk.length > IV_LENGTH + TAG_LENGTH) {
      const iv = encryptedChunk.slice(0, IV_LENGTH);
      const ciphertextWithTag = encryptedChunk.slice(IV_LENGTH);
      const ciphertext = ciphertextWithTag.slice(0, -TAG_LENGTH);
      const tag = ciphertextWithTag.slice(-TAG_LENGTH);
      
      const result = decryptAESGCM(ciphertext, fileKey, iv, tag);
      console.log('[ZK] Decryption succeeded with IV-prepended strategy');
      return result;
    }
  } catch (ivPrependError) {
    console.warn('[ZK] IV-prepended decryption failed');
  }

  // All strategies failed
  console.error('[ZK] All decryption strategies failed for chunk');
  throw new Error('Decryption failed: Invalid key, corrupted data, or authentication tag mismatch');
}

/**
 * Prepare for file decryption by decrypting the file key
 * @param encryptedFileKeyB64 - Encrypted file key (base64)
 * @param fileKeyIVB64 - File key IV (base64)
 * @returns Decrypted file key
 */
export function prepareFileForDecryption(
  encryptedFileKeyB64: string,
  fileKeyIVB64: string
): Uint8Array {
  const masterKey = zkSession.getMasterKey();

  // Decrypt file key with master key
  const fileKey = decryptFileKey(encryptedFileKeyB64, masterKey, fileKeyIVB64);

  return fileKey;
}

/**
 * Decrypt entire file from encrypted chunks
 * @param encryptedChunks - Array of { data, iv, index }
 * @param encryptedFileKey - Encrypted file key (base64)
 * @param fileKeyIV - File key IV (base64)
 * @param progressCallback - Progress callback (bytesDecrypted, totalBytes)
 * @returns Decrypted file as Blob
 */
export async function decryptFile(
  encryptedChunks: { data: Uint8Array; iv: string; index: number }[],
  encryptedFileKey: string,
  fileKeyIV: string,
  progressCallback: ((bytesDecrypted: number, totalBytes: number) => void) | null = null
): Promise<Blob> {
  const masterKey = zkSession.getMasterKey();

  // Decrypt file key
  const fileKey = decryptFileKey(encryptedFileKey, masterKey, fileKeyIV);

  const decryptedChunks: BlobPart[] = [];
  const totalBytes = encryptedChunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  let bytesDecrypted = 0;

  // Sort chunks by index to ensure correct order
  const sortedChunks = [...encryptedChunks].sort((a, b) => a.index - b.index);

  for (const chunk of sortedChunks) {
    const decryptedChunk = decryptChunk(chunk.data, fileKey, chunk.index);
    decryptedChunks.push(decryptedChunk as BlobPart);

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

/**
 * Encrypt file metadata (name, path, size, MIME type)
 * Uses HKDF-derived MetadataKey for encryption
 *
 * @param metadata - { name, path, size, mime, created }
 * @returns Base64 encoded encrypted metadata
 */
export function encryptMetadata(metadata: FileMetadata): string {
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
 * @param encryptedMetadataB64 - Base64 encrypted metadata
 * @returns Decrypted metadata object
 */
export function decryptMetadata(encryptedMetadataB64: string): FileMetadata {
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
  return JSON.parse(decoder.decode(plaintext)) as FileMetadata;
}

/**
 * Prepare encrypted file metadata for upload
 * @param file - File to get metadata from
 * @param path - Folder path (optional)
 * @returns { encryptedMetadata, plaintextHints }
 */
export function prepareEncryptedMetadata(file: File, path: string = '/'): EncryptedMetadataResult {
  const metadata: FileMetadata = {
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
    typeHint: (file.type ? file.type.split('/')[0] : 'unknown') as string, // Just the type category
  };

  return { encryptedMetadata, plaintextHints };
}

// ==================== Filename Encryption ====================

/**
 * Encrypt filename for ZK storage
 * @param filename - Plaintext filename
 * @returns { encryptedFilename: string, filenameIV: string } - Base64 encoded
 */
export function encryptFilename(filename: string): EncryptedFilenameResult {
  const masterKey = zkSession.getMasterKey();
  return encryptFilenameV2(filename, masterKey);
}

/**
 * Decrypt filename from ZK storage
 * @param encryptedFilenameB64 - Base64 encoded encrypted filename
 * @param filenameIVB64 - Base64 encoded IV
 * @returns Decrypted filename
 */
export function decryptFilename(encryptedFilenameB64: string, filenameIVB64: string): string {
  const masterKey = zkSession.getMasterKey();
  return decryptFilenameV2(encryptedFilenameB64, filenameIVB64, masterKey);
}

/**
 * Safely decrypt filename, returning fallback if decryption fails
 * Handles legacy files that have base64-encoded plaintext filenames
 * @param encryptedFilenameB64 - Base64 encoded encrypted filename
 * @param filenameIVB64 - Base64 encoded IV
 * @param fallback - Fallback value if decryption fails
 * @returns Decrypted filename or fallback
 */
export function decryptFilenameSafe(
  encryptedFilenameB64: string,
  filenameIVB64: string,
  fallback: string = 'Encrypted File'
): string {
  try {
    if (!zkSession.isSessionUnlocked()) {
      return fallback;
    }
    if (!encryptedFilenameB64 || !filenameIVB64) {
      return fallback;
    }
    return decryptFilename(encryptedFilenameB64, filenameIVB64);
  } catch (error) {
    console.warn('Failed to decrypt filename:', (error as Error).message);
    return fallback;
  }
}

// ==================== Utility Functions ====================

/**
 * Convert file to chunks without encryption (for progress tracking)
 * @param file - File to chunk
 * @returns Array of chunk metadata
 */
export async function getFileChunks(file: File): Promise<FileChunkInfo[]> {
  const chunkSize = ZK_CONSTANTS.CHUNK_SIZE;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const chunks: FileChunkInfo[] = [];

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
 * @param file - File to read
 * @param start - Start byte
 * @param end - End byte
 * @returns Chunk data
 */
export async function readFileChunk(file: File, start: number, end: number): Promise<Uint8Array> {
  const slice = file.slice(start, end);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Get ZK session status
 * @returns Session status
 */
export function getZKSessionStatus(): ZKSessionStatus {
  return {
    isUnlocked: zkSession.isSessionUnlocked(),
    hasMasterKey: zkSession['masterKey'] !== null,
    hasDerivedKey: zkSession['derivedKey'] !== null,
  };
}

/**
 * Export session (for debugging only - NOT for production use)
 * @returns Session data
 */
export function exportSessionDebug(): ZKSessionDebugInfo {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Session export only available in development mode');
  }

  return {
    isUnlocked: zkSession.isSessionUnlocked(),
    hasMasterKey: zkSession['masterKey'] !== null,
    hasDerivedKey: zkSession['derivedKey'] !== null,
    masterKeyLength: zkSession['masterKey']?.length,
    derivedKeyLength: zkSession['derivedKey']?.length,
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
  encryptFileChunkV2,
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
