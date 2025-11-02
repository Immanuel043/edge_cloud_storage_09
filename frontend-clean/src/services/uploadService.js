/**
 * Advanced Upload Service with Parallel Multipart Uploads
 *
 * Features:
 * - Parallel chunk uploads (configurable concurrency)
 * - Automatic retry with exponential backoff
 * - Progress tracking per chunk
 * - Network error resilience
 * - Bandwidth estimation
 * - Zero-Knowledge encryption support (client-side encryption)
 */

import * as zkEncryptionService from './zkEncryptionService';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const ZK_SERVICE_URL = import.meta.env.VITE_ZK_SERVICE_URL || 'http://localhost:8002';

class UploadService {
  constructor() {
    this.activeUploads = new Map();
    this.defaultConcurrency = 4; // Upload 4 chunks in parallel
    this.maxRetries = 3;
    this.retryDelay = 1000; // Start with 1 second
  }

  /**
   * Initialize a new upload session
   * Automatically detects ZK mode and calls appropriate endpoint
   */
  async initUpload(file, folderId = null) {
    // Check if ZK (Zero-Knowledge) mode is enabled
    const zkEnabled = zkEncryptionService.isZKSessionUnlocked();

    if (zkEnabled) {
      // ZK Mode: Generate file key and encrypt it with master key
      console.log('[Upload] ZK mode detected - generating file key');

      const zkPrepResult = await zkEncryptionService.prepareFileForEncryption(file);
      const { fileKey, encryptedFileKey, fileKeyIV } = zkPrepResult;

      // Call ZK upload init endpoint
      const response = await fetch(`${API_BASE_URL}/api/v1/upload/init/zk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          file_name: file.name,
          file_size: file.size,
          encrypted_file_key: encryptedFileKey,
          file_key_iv: fileKeyIV,
          encryption_algorithm: 'AES-256-GCM',
          mime_type: file.type,
          folder_id: folderId,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to initialize ZK upload');
      }

      const initData = await response.json();

      // Return with ZK metadata
      return {
        ...initData,
        zkEnabled: true,
        fileKey,  // Keep file key in memory for chunk encryption
      };
    } else {
      // Standard Mode: Use existing server-side encryption flow
      const response = await fetch(`${API_BASE_URL}/api/v1/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          file_name: file.name,
          file_size: file.size,
          folder_id: folderId,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to initialize upload');
      }

      return {
        ...await response.json(),
        zkEnabled: false,
      };
    }
  }

  /**
   * Upload file with parallel chunks
   *
   * @param {File} file - File to upload
   * @param {Object} options - Upload options
   * @param {number} options.concurrency - Number of parallel uploads (default: 4)
   * @param {Function} options.onProgress - Progress callback (chunkIndex, progress, speed)
   * @param {Function} options.onChunkComplete - Chunk completion callback
   * @param {Function} options.onError - Error callback
   * @param {string} options.folderId - Target folder ID
   * @returns {Promise<Object>} - Upload result
   */
  async uploadFile(file, options = {}) {
    const {
      concurrency = this.defaultConcurrency,
      onProgress,
      onChunkComplete,
      onError,
      folderId = null,
    } = options;

    try {
      // Step 1: Initialize upload (auto-detects ZK mode)
      const initData = await this.initUpload(file, folderId);
      const { upload_id, storage_strategy, chunk_size, total_chunks, zkEnabled, fileKey } = initData;

      // Create upload context
      const uploadContext = {
        uploadId: upload_id,
        file,
        strategy: storage_strategy,
        chunkSize: chunk_size,
        totalChunks: total_chunks,
        uploadedChunks: new Set(),
        failedChunks: new Set(),
        startTime: Date.now(),
        bytesUploaded: 0,
        onProgress,
        onChunkComplete,
        onError,

        // ZK-specific fields
        zkEnabled,
        fileKey,  // File key for chunk encryption (ZK mode only)
      };

      this.activeUploads.set(upload_id, uploadContext);

      // Step 2: Handle different upload strategies
      if (storage_strategy === 'chunked') {
        await this._uploadChunked(uploadContext, concurrency);
      } else {
        // Direct upload for small/medium files
        await this._uploadDirect(uploadContext);
      }

      // Step 3: Complete upload
      const result = await this._completeUpload(upload_id);

      this.activeUploads.delete(upload_id);
      return result;

    } catch (error) {
      if (onError) {
        onError(error);
      }
      throw error;
    }
  }

  /**
   * Upload chunks in parallel with queue management
   */
  async _uploadChunked(context, concurrency) {
    const { file, chunkSize, totalChunks, uploadId } = context;

    // Create chunk queue
    const chunkQueue = Array.from({ length: totalChunks }, (_, i) => i);

    // Create worker pool
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(this._chunkUploadWorker(context, chunkQueue));
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    // Verify all chunks uploaded
    if (context.uploadedChunks.size !== totalChunks) {
      throw new Error(
        `Upload incomplete: ${context.uploadedChunks.size}/${totalChunks} chunks uploaded`
      );
    }
  }

  /**
   * Worker that processes chunks from queue
   */
  async _chunkUploadWorker(context, chunkQueue) {
    while (chunkQueue.length > 0) {
      const chunkIndex = chunkQueue.shift();
      if (chunkIndex === undefined) break;

      try {
        await this._uploadChunkWithRetry(context, chunkIndex);
        context.uploadedChunks.add(chunkIndex);

        if (context.onChunkComplete) {
          context.onChunkComplete(chunkIndex, context.uploadedChunks.size, context.totalChunks);
        }

        // Update progress
        this._updateProgress(context);

      } catch (error) {
        console.error(`Failed to upload chunk ${chunkIndex}:`, error);
        context.failedChunks.add(chunkIndex);

        // Retry failed chunk (add back to queue)
        if (chunkQueue.length === 0 && context.failedChunks.size > 0) {
          // All chunks processed but some failed - retry them
          chunkQueue.push(...Array.from(context.failedChunks));
          context.failedChunks.clear();
        }
      }
    }
  }

  /**
   * Upload single chunk with exponential backoff retry
   * Automatically encrypts chunk if ZK mode is enabled
   */
  async _uploadChunkWithRetry(context, chunkIndex, retryCount = 0) {
    const { file, chunkSize, uploadId, zkEnabled, fileKey } = context;

    // Calculate chunk boundaries
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBlob = file.slice(start, end);

    let finalChunkData = chunkBlob;

    // ZK Mode: Encrypt chunk before upload
    if (zkEnabled) {
      try {
        // Read chunk as ArrayBuffer
        const chunkArrayBuffer = await chunkBlob.arrayBuffer();
        const chunkBytes = new Uint8Array(chunkArrayBuffer);

        // Encrypt chunk with file key
        const encryptResult = zkEncryptionService.encryptFileChunk(chunkBytes, fileKey, chunkIndex);
        const { encryptedChunk } = encryptResult;

        // Convert encrypted bytes to Blob
        finalChunkData = new Blob([encryptedChunk]);

        console.log(`[Upload] Encrypted chunk ${chunkIndex}: ${chunkBytes.length} → ${encryptedChunk.length} bytes`);

      } catch (encryptError) {
        console.error(`[Upload] Encryption failed for chunk ${chunkIndex}:`, encryptError);
        throw new Error(`Encryption failed: ${encryptError.message}`);
      }
    }

    const formData = new FormData();
    formData.append('chunk', finalChunkData);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/upload/chunk/${uploadId}?chunk_index=${chunkIndex}`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      // Track bytes uploaded
      context.bytesUploaded += (end - start);

      return result;

    } catch (error) {
      // Retry with exponential backoff
      if (retryCount < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        console.log(`Retrying chunk ${chunkIndex} after ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries})`);

        await this._sleep(delay);
        return this._uploadChunkWithRetry(context, chunkIndex, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Upload file directly (for small/medium files)
   */
  async _uploadDirect(context) {
    const { file, uploadId } = context;

    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(
      `${API_BASE_URL}/api/v1/upload/direct/${uploadId}`,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    );

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    context.bytesUploaded = file.size;
    this._updateProgress(context);

    return response.json();
  }

  /**
   * Complete the upload
   */
  async _completeUpload(uploadId) {
    const response = await fetch(
      `${API_BASE_URL}/api/v1/upload/complete/${uploadId}`,
      {
        method: 'POST',
        credentials: 'include',
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to complete upload');
    }

    return response.json();
  }

  /**
   * Update progress callback
   */
  _updateProgress(context) {
    if (!context.onProgress) return;

    const { bytesUploaded, file, startTime } = context;
    const progress = (bytesUploaded / file.size) * 100;
    const elapsed = (Date.now() - startTime) / 1000; // seconds
    const speed = bytesUploaded / elapsed; // bytes per second

    context.onProgress({
      progress: Math.min(progress, 100),
      bytesUploaded,
      totalBytes: file.size,
      speed,
      elapsed,
      eta: speed > 0 ? (file.size - bytesUploaded) / speed : 0,
    });
  }

  /**
   * Cancel an active upload
   */
  cancelUpload(uploadId) {
    if (this.activeUploads.has(uploadId)) {
      this.activeUploads.delete(uploadId);
      return true;
    }
    return false;
  }

  /**
   * Get upload status
   */
  getUploadStatus(uploadId) {
    return this.activeUploads.get(uploadId);
  }

  /**
   * Helper: Sleep for delay milliseconds
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Format bytes to human readable
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Format speed to human readable
   */
  static formatSpeed(bytesPerSecond) {
    return this.formatBytes(bytesPerSecond) + '/s';
  }
}

// Export singleton instance
export default new UploadService();
