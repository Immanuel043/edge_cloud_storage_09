/**
 * ChunkManager - Handle encrypted chunk fetch and decrypt operations
 *
 * Integrates with existing ZK infrastructure:
 * - Uses prepareFileForDecryption to get file key
 * - Uses decryptFileChunk for decryption
 * - Supports worker pool for parallel decryption
 */

import { ZK_SERVICE_URL, ZK_CHUNK_SIZE } from '../../config/constants';
import { prepareFileForDecryption, decryptFileChunk } from '../zkEncryptionService';
import { getWorkerPool } from '../zkDecryptWorkerPool';

/**
 * LRU Cache for decrypted chunks
 */
class ChunkCache {
  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;

    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    // Delete if exists to update order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    // Zero out all cached ArrayBuffers for security
    for (const buffer of this.cache.values()) {
      if (buffer instanceof Uint8Array || buffer instanceof ArrayBuffer) {
        try {
          const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
          view.fill(0);
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
    }
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

export class ChunkManager {
  /**
   * @param {string} fileId - ZK file ID
   * @param {Object} metadata - File metadata with encrypted_file_key, file_key_iv, file_size
   * @param {Object} options
   */
  constructor(fileId, metadata, options = {}) {
    this.fileId = fileId;
    this.metadata = metadata;
    this.chunkSize = metadata.chunk_size || ZK_CHUNK_SIZE || 64 * 1024 * 1024;
    this.totalChunks = Math.ceil(metadata.file_size / this.chunkSize);

    this.fileKey = null;
    this.cache = new ChunkCache(options.cacheSize || 10);
    this.pendingFetches = new Map();
    this.abortController = null;
    this.workerPool = null;
    this.useWorkerPool = options.useWorkerPool !== false;
  }

  /**
   * Initialize the chunk manager - decrypt file key
   */
  async init() {
    // Decrypt file key with master key
    this.fileKey = prepareFileForDecryption(
      this.metadata.encrypted_file_key,
      this.metadata.file_key_iv
    );

    // Initialize worker pool if enabled
    if (this.useWorkerPool) {
      try {
        this.workerPool = getWorkerPool();
        await this.workerPool.init();
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
   * @param {number} chunkIndex
   * @param {AbortSignal} signal - Optional abort signal
   * @returns {Promise<Uint8Array>} Decrypted chunk data
   */
  async getChunk(chunkIndex, signal = null) {
    // Check cache first
    const cached = this.cache.get(chunkIndex);
    if (cached) {
      return cached;
    }

    // Check if already fetching
    if (this.pendingFetches.has(chunkIndex)) {
      return this.pendingFetches.get(chunkIndex);
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
   * Fetch encrypted chunk from backend and decrypt
   * @param {number} chunkIndex
   * @param {AbortSignal} signal
   * @returns {Promise<Uint8Array>}
   */
  async _fetchAndDecrypt(chunkIndex, signal = null) {
    // Combine signals
    const combinedSignal = signal || this.abortController?.signal;

    // Fetch encrypted chunk
    const url = `${ZK_SERVICE_URL}/api/v1/zk/files/${this.fileId}/chunk/${chunkIndex}`;

    const response = await fetch(url, {
      credentials: 'include',
      signal: combinedSignal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch chunk ${chunkIndex}: HTTP ${response.status}`);
    }

    const encryptedData = await response.arrayBuffer();
    const encryptedChunk = new Uint8Array(encryptedData);

    // Decrypt using worker pool or main thread
    let decrypted;

    if (this.workerPool) {
      try {
        const result = await this.workerPool.decryptChunk(
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
   * @param {number} startChunk
   * @param {number} count
   * @returns {Promise<Uint8Array>} Concatenated decrypted data
   */
  async getChunks(startChunk, count) {
    const chunks = [];
    const endChunk = Math.min(startChunk + count, this.totalChunks);

    for (let i = startChunk; i < endChunk; i++) {
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
   * @param {number[]} chunkIndices
   */
  async prefetch(chunkIndices) {
    const promises = chunkIndices
      .filter(idx => idx >= 0 && idx < this.totalChunks)
      .filter(idx => !this.cache.has(idx) && !this.pendingFetches.has(idx))
      .map(idx => this.getChunk(idx).catch(() => null)); // Ignore prefetch errors

    await Promise.all(promises);
  }

  /**
   * Calculate which chunks are needed for a time range
   * @param {number} startByte - Start byte offset
   * @param {number} endByte - End byte offset
   * @returns {number[]} Array of chunk indices
   */
  getChunkIndicesForRange(startByte, endByte) {
    const startChunk = Math.floor(startByte / this.chunkSize);
    const endChunk = Math.floor(endByte / this.chunkSize);

    const indices = [];
    for (let i = startChunk; i <= endChunk && i < this.totalChunks; i++) {
      indices.push(i);
    }

    return indices;
  }

  /**
   * Abort all pending fetches
   */
  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = new AbortController();
    }
    this.pendingFetches.clear();
  }

  /**
   * Clear all cached data (for security lock)
   */
  clear() {
    this.abort();
    this.cache.clear();

    // Zero out file key
    if (this.fileKey) {
      try {
        this.fileKey.fill(0);
      } catch (e) {
        // Ignore errors
      }
      this.fileKey = null;
    }
  }

  /**
   * Destroy the chunk manager
   */
  destroy() {
    this.clear();
    this.abortController = null;
  }

  /**
   * Get statistics
   */
  getStats() {
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
