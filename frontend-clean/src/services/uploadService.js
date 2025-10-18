/**
 * Advanced Upload Service with Parallel Multipart Uploads
 *
 * Features:
 * - Parallel chunk uploads (configurable concurrency)
 * - Automatic retry with exponential backoff
 * - Progress tracking per chunk
 * - Network error resilience
 * - Bandwidth estimation
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

class UploadService {
  constructor() {
    this.activeUploads = new Map();
    this.defaultConcurrency = 4; // Upload 4 chunks in parallel
    this.maxRetries = 3;
    this.retryDelay = 1000; // Start with 1 second
  }

  /**
   * Initialize a new upload session
   */
  async initUpload(file, folderId = null) {
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

    return response.json();
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
      // Step 1: Initialize upload
      const initData = await this.initUpload(file, folderId);
      const { upload_id, storage_strategy, chunk_size, total_chunks } = initData;

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
   */
  async _uploadChunkWithRetry(context, chunkIndex, retryCount = 0) {
    const { file, chunkSize, uploadId } = context;

    // Calculate chunk boundaries
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBlob = file.slice(start, end);

    const formData = new FormData();
    formData.append('chunk', chunkBlob);

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
