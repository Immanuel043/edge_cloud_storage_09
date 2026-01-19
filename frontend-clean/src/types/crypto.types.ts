/**
 * Cryptography and ZK Encryption Types
 */

export interface EncryptionMetadata {
  algorithm: 'AES-256-GCM' | 'ChaCha20-Poly1305';
  version: 1 | 2;
  iv: string;  // Base64
  salt?: string;  // For KDF
}

export interface DerivedKeyResult {
  derivedKey: Uint8Array;
  salt: Uint8Array;
}

export interface EncryptionResult {
  encrypted: Uint8Array;
  iv: Uint8Array;
  authTag?: Uint8Array;  // For GCM
}

export interface DecryptionResult {
  decrypted: Uint8Array;
}

export interface HashResult {
  hash: string;  // Hex or Base64
  algorithm: 'SHA-256' | 'BLAKE2b';
}

export type CompressionAlgorithm = 'zstd' | 'gzip' | 'brotli';
export type EncryptionAlgorithm = 'AES-256-GCM' | 'ChaCha20-Poly1305';
export type KDFAlgorithm = 'pbkdf2' | 'argon2id' | 'scrypt';

export interface ZKRegistrationRequest {
  email: string;
  username: string;
  passwordHash: string;  // SHA-256 hex
  encryptedMasterKey: string;  // Base64
  masterKeyIv: string;  // Base64
  kdfSalt: string;  // Hex
  kdfAlgorithm: KDFAlgorithm;
  kdfIterations: number;
  kdfMemory?: number;
  kdfParallelism?: number;
}

export interface ZKConfig {
  KDF_ALGORITHM: 'pbkdf2' | 'argon2id';
  KDF_ITERATIONS: number;
  PBKDF2_KEY_LENGTH: number;
  ENCRYPTION_ALGORITHM: 'AES-256-GCM';
  AES_KEY_LENGTH: number;
  GCM_IV_LENGTH: number;
  RECOVERY_PHRASE_WORDS: number;
  ZK_CHUNK_SIZE: number;
  MAX_CONCURRENT_CHUNKS: number;
  SESSION_TIMEOUT: number;
  SESSION_WARNING_TIME: number;
}
