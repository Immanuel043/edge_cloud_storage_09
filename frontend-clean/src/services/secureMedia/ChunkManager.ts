/**
 * ChunkManager - Handle encrypted chunk fetch and decrypt operations
 *
 * Integrates with existing ZK infrastructure:
 * - Uses prepareFileForDecryption to get file key
 * - Uses decryptFileChunk for decryption
 * - Supports worker pool for parallel decryption
 */

import { ZK_SERVICE_URL, CHUNK_SIZE } from '../../config/constants';
import { prepareFileForDecryption, decryptFileChunk } from '../zkEncryptionService';
import { getWorkerPool } from '../zkDecryptWorkerPool';

interface FileMetadata {
  encrypted_file_key: string;
  file_key_iv: string;
  file_size: number;
  chunk_size?: number;
}

interface ChunkManagerOptions {
  cacheSize?: number;
  useWorkerPool?: boolean;
}

interface ChunkManagerStats {
  fileId: string;
  totalChunks: number;
  chunkSize: number;
  cachedChunks: number;
  pendingFetches: number;
  hasFileKey: boolean;
}

/**
 * LRU Cache for decrypted chunks
 */
class ChunkCache {
  private maxSize: number;
  private cache: Map<number, Uint8Array>;

  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key: number): Uint8Array | null {
    if (!this.cache.has(key)) return null;

    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: number, value: Uint8Array): void {
    // Delete if exists to update order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value as number;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, value);
  }

  has(key: number): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    // Zero out all cached ArrayBuffers for security
    for (const buffer of this.cache.values()) {
      try {
        buffer.fill(0);
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export class ChunkManager {
  private fileId: string;
  public metadata: FileMetadata; // Made public for access from controllers
  private chunkSize: number;
  public totalChunks: number; // Made public for access from controllers
  public fileKey: Uint8Array | null; // Made public for validation checks
  private cache: ChunkCache;
  private pendingFetches: Map<number, Promise<Uint8Array>>;
  private abortController: AbortController | null;
  private workerPool: unknown | null;
  private useWorkerPool: boolean;
  public isDestroyed: boolean; // Made public for cleanup coordination

  /**
   * @param fileId - ZK file ID
   * @param metadata - File metadata with encrypted_file_key, file_key_iv, file_size
   * @param options - Configuration options
   */
  constructor(fileId: string, metadata: FileMetadata, options: ChunkManagerOptions = {}) {
    this.fileId = fileId;
    this.metadata = metadata;
    // Use chunk_size from metadata (from storage-service), fallback to CHUNK_SIZE constant (32MB)
    this.chunkSize = metadata.chunk_size || CHUNK_SIZE || 32 * 1024 * 1024;
    this.totalChunks = Math.ceil(metadata.file_size / this.chunkSize);

    this.fileKey = null;
    this.cache = new ChunkCache(options.cacheSize || 10);
    this.pendingFetches = new Map();
    this.abortController = null;
    this.workerPool = null;
    this.useWorkerPool = options.useWorkerPool !== false;
    this.isDestroyed = false;
  }

  /**
   * Initialize the chunk manager - decrypt file key
   */
  async init(): Promise<void> {
    console.log('[ChunkManager] Initializing...', {
      fileId: this.fileId,
      hasEncryptedFileKey: !!this.metadata.encrypted_file_key,
      hasFileKeyIV: !!this.metadata.file_key_iv,
      fileSize: this.metadata.file_size,
      chunkSize: this.chunkSize,
      totalChunks: this.totalChunks,
    });

    // Validate metadata
    if (!this.metadata.encrypted_file_key) {
      throw new Error('Missing encrypted_file_key in metadata');
    }
    if (!this.metadata.file_key_iv) {
      throw new Error('Missing file_key_iv in metadata');
    }
    if (!this.metadata.file_size || this.metadata.file_size <= 0) {
      throw new Error('Invalid or missing file_size in metadata');
    }

    // Decrypt file key with master key
    try {
      const decryptedFileKey = prepareFileForDecryption(
        this.metadata.encrypted_file_key,
        this.metadata.file_key_iv
      );
      // Create defensive copy to ensure it's independent and won't be affected by external clearing
      this.fileKey = new Uint8Array(decryptedFileKey);
      console.log('[ChunkManager] File key decrypted successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[ChunkManager] Failed to decrypt file key:', error);
      throw new Error(`Failed to decrypt file key: ${errorMessage}. Make sure your ZK session is unlocked.`);
    }

    // Initialize worker pool if enabled
    if (this.useWorkerPool) {
      try {
        this.workerPool = getWorkerPool();
        await (this.workerPool as { init: () => Promise<void> }).init();
      } catch (error) {
        console.warn('[ChunkManager] Worker pool not available, using main thread decryption');
        this.workerPool = null;
      }
    }

    this.abortController = new AbortController();
    console.log(`[ChunkManager] Initialized for file ${this.fileId}, ${this.totalChunks} chunks`);
  }

  /**
   * Fetch and decrypt a single chunk
   * @param chunkIndex - Index of the chunk
   * @param signal - Optional abort signal
   * @returns Decrypted chunk data
   */
  async getChunk(chunkIndex: number, signal: AbortSignal | null = null): Promise<Uint8Array> {
    // Check if destroyed (React cleanup race condition)
    if (this.isDestroyed) {
      throw new Error('ChunkManager has been destroyed');
    }

    // Check cache first
    const cached = this.cache.get(chunkIndex);
    if (cached) {
      return cached;
    }

    // Check if already fetching
    if (this.pendingFetches.has(chunkIndex)) {
      return this.pendingFetches.get(chunkIndex)!;
    }

    // Start fetch
    const fetchPromise = this._fetchAndDecrypt(chunkIndex, signal);
    this.pendingFetches.set(chunkIndex, fetchPromise);

    try {
      const decrypted = await fetchPromise;
      this.cache.set(chunkIndex, decrypted);
      return decrypted;
    } finally {
      this.pendingFetches.delete(chunkIndex);
    }
  }

  /**
   * Ensure file key is valid, re-decrypt if needed
   */
  public _ensureFileKey(): void {
    if (!this.fileKey || this.fileKey.length !== 32) {
      // Re-decrypt if cleared (but not if destroyed)
      if (this.isDestroyed) {
        throw new Error('ChunkManager has been destroyed');
      }

      try {
        const decryptedFileKey = prepareFileForDecryption(
          this.metadata.encrypted_file_key,
          this.metadata.file_key_iv
        );
        // Create defensive copy
        this.fileKey = new Uint8Array(decryptedFileKey);
        console.log('[ChunkManager] File key re-decrypted successfully');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[ChunkManager] Failed to re-decrypt file key:', error);
        throw new Error(
          `File key was cleared and re-decryption failed: ${errorMessage}. ` +
          'Make sure your ZK session is still unlocked.'
        );
      }
    }
  }

  /**
   * Fetch encrypted chunk from backend and decrypt
   * @param chunkIndex - Index of the chunk
   * @param signal - Optional abort signal
   * @returns Decrypted chunk data
   */
  private async _fetchAndDecrypt(chunkIndex: number, signal: AbortSignal | null = null): Promise<Uint8Array> {
    // Check if destroyed (React cleanup race condition)
    if (this.isDestroyed) {
      throw new Error('ChunkManager has been destroyed');
    }

    // Ensure file key is valid before attempting decryption
    this._ensureFileKey();

    // Combine signals
    const combinedSignal = signal || this.abortController?.signal;

    // Fetch encrypted chunk from ZK service (port 8002)
    const url = `${ZK_SERVICE_URL}/api/v1/zk/files/${this.fileId}/chunk/${chunkIndex}`;

    const fetchOptions: RequestInit = {
      credentials: 'include',
    };
    if (combinedSignal) {
      fetchOptions.signal = combinedSignal;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`Failed to fetch chunk ${chunkIndex}: HTTP ${response.status}`);
    }

    const encryptedData = await response.arrayBuffer();
    const encryptedChunk = new Uint8Array(encryptedData);

    // Check again after async fetch (React cleanup race condition)
    if (this.isDestroyed) {
      throw new Error('ChunkManager was destroyed during fetch');
    }

    // Validate file key again before decryption (it could have been cleared during fetch)
    if (!this.fileKey || this.fileKey.length !== 32) {
      throw new Error(
        `Invalid file key after fetch: expected 32 bytes, got ${this.fileKey?.length || 0}. ` +
        'ChunkManager was cleared during async operation.'
      );
    }

    // Decrypt using worker pool or main thread
    let decrypted: Uint8Array;

    if (this.workerPool) {
      try {
        const result = await (this.workerPool as {
          decryptChunk: (chunk: Uint8Array, key: Uint8Array, index: number) => Promise<{ decryptedChunk: Uint8Array }>;
        }).decryptChunk(
          encryptedChunk,
          this.fileKey,
          chunkIndex
        );
        decrypted = result.decryptedChunk;
      } catch (error) {
        console.warn('[ChunkManager] Worker decryption failed, falling back to main thread');
        decrypted = decryptFileChunk(encryptedChunk, this.fileKey, chunkIndex);
      }
    } else {
      decrypted = decryptFileChunk(encryptedChunk, this.fileKey, chunkIndex);
    }

    return decrypted;
  }

  /**
   * Fetch multiple chunks with optional retry
   * @param startChunk - Starting chunk index
   * @param count - Number of chunks to fetch
   * @returns Concatenated decrypted data
   */
  async getChunks(startChunk: number, count: number): Promise<Uint8Array> {
    // Ensure file key is valid before starting multi-chunk fetch
    this._ensureFileKey();

    const chunks: Uint8Array[] = [];
    const endChunk = Math.min(startChunk + count, this.totalChunks);

    for (let i = startChunk; i < endChunk; i++) {
      // Check before each chunk fetch (React cleanup race condition)
      if (this.isDestroyed) {
        throw new Error('ChunkManager was destroyed during multi-chunk fetch');
      }
      const chunk = await this.getChunk(i);
      chunks.push(chunk);
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Prefetch chunks in background
   * @param chunkIndices - Array of chunk indices to prefetch
   */
  async prefetch(chunkIndices: number[]): Promise<void> {
    const promises = chunkIndices
      .filter(idx => idx >= 0 && idx < this.totalChunks)
      .filter(idx => !this.cache.has(idx) && !this.pendingFetches.has(idx))
      .map(idx => this.getChunk(idx).catch(() => null)); // Ignore prefetch errors

    await Promise.all(promises);
  }

  /**
   * Calculate which chunks are needed for a time range
   * @param startByte - Start byte offset
   * @param endByte - End byte offset
   * @returns Array of chunk indices
   */
  getChunkIndicesForRange(startByte: number, endByte: number): number[] {
    const startChunk = Math.floor(startByte / this.chunkSize);
    const endChunk = Math.floor(endByte / this.chunkSize);

    const indices: number[] = [];
    for (let i = startChunk; i <= endChunk && i < this.totalChunks; i++) {
      indices.push(i);
    }

    return indices;
  }

  /**
   * Abort all pending fetches
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = new AbortController();
    }
    this.pendingFetches.clear();
  }

  /**
   * Clear all cached data (for security lock)
   */
  clear(): void {
    this.abort();
    this.cache.clear();

    // Zero out file key
    if (this.fileKey) {
      try {
        this.fileKey.fill(0);
      } catch {
        // Ignore errors
      }
      this.fileKey = null;
    }
  }

  /**
   * Destroy the chunk manager
   */
  destroy(): void {
    this.isDestroyed = true;
    this.clear();
    this.abortController = null;
  }

  /**
   * Get statistics
   */
  getStats(): ChunkManagerStats {
    return {
      fileId: this.fileId,
      totalChunks: this.totalChunks,
      chunkSize: this.chunkSize,
      cachedChunks: this.cache.size(),
      pendingFetches: this.pendingFetches.size,
      hasFileKey: !!this.fileKey,
    };
  }
}

export default ChunkManager;
