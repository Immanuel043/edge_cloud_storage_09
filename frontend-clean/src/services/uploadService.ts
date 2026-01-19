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

// ==================== Type Definitions ====================

interface UploadInitZKRequest {
  file_name: string;
  file_size: number;
  encrypted_file_key: string;
  file_key_iv: string;
  encryption_algorithm: string;
  mime_type: string;
  folder_id: string | null;
}

interface UploadInitRequest {
  file_name: string;
  file_size: number;
  folder_id: string | null;
}

interface UploadInitResponse {
  upload_id: string;
  storage_strategy: 'inline' | 'single' | 'chunked';
  chunk_size: number;
  total_chunks: number;
}

interface UploadInitZKResponse extends UploadInitResponse {
  zkEnabled: true;
  fileKey: Uint8Array;
}

interface UploadInitNormalResponse extends UploadInitResponse {
  zkEnabled: false;
}

type UploadInitResult = UploadInitZKResponse | UploadInitNormalResponse;

interface UploadProgressData {
  progress: number;
  bytesUploaded: number;
  totalBytes: number;
  speed: number;
  elapsed: number;
  eta: number;
}

interface UploadOptions {
  concurrency?: number;
  onProgress?: (data: UploadProgressData) => void;
  onChunkComplete?: (chunkIndex: number, uploadedCount: number, totalChunks: number) => void;
  onError?: (error: Error) => void;
  folderId?: string | null;
}

interface UploadContext {
  uploadId: string;
  file: File;
  strategy: 'inline' | 'single' | 'chunked';
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: Set<number>;
  failedChunks: Set<number>;
  startTime: number;
  bytesUploaded: number;
  onProgress?: ((data: UploadProgressData) => void) | undefined;
  onChunkComplete?: ((chunkIndex: number, uploadedCount: number, totalChunks: number) => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
  zkEnabled: boolean;
  fileKey?: Uint8Array | undefined;
}

interface UploadCompleteResponse {
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type?: string;
  created_at?: string;
}

interface ChunkUploadResponse {
  chunk_index: number;
  success: boolean;
}

// ==================== Upload Service Class ====================

class UploadService {
  private activeUploads: Map<string, UploadContext>;
  private defaultConcurrency: number;
  private maxRetries: number;
  private retryDelay: number;

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
  async initUpload(file: File, folderId: string | null = null): Promise<UploadInitResult> {
    // Check if ZK (Zero-Knowledge) mode is enabled
    const zkEnabled = zkEncryptionService.isZKSessionUnlocked();

    if (zkEnabled) {
      // ZK Mode: Generate file key and encrypt it with master key
      console.log('[Upload] ZK mode detected - generating file key');

      const zkPrepResult = await zkEncryptionService.prepareFileForEncryption(file);
      const { fileKey, encryptedFileKey, fileKeyIV } = zkPrepResult;

      // Call ZK upload init endpoint
      const requestBody: UploadInitZKRequest = {
        file_name: file.name,
        file_size: file.size,
        encrypted_file_key: encryptedFileKey,
        file_key_iv: fileKeyIV,
        encryption_algorithm: 'AES-256-GCM',
        mime_type: file.type,
        folder_id: folderId,
      };

      const response = await fetch(`${API_BASE_URL}/api/v1/upload/init/zk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as { detail?: string };
        throw new Error(error.detail || 'Failed to initialize ZK upload');
      }

      const initData = (await response.json()) as UploadInitResponse;

      // Return with ZK metadata
      return {
        ...initData,
        zkEnabled: true,
        fileKey, // Keep file key in memory for chunk encryption
      };
    } else {
      // Standard Mode: Use existing server-side encryption flow
      const requestBody: UploadInitRequest = {
        file_name: file.name,
        file_size: file.size,
        folder_id: folderId,
      };

      const response = await fetch(`${API_BASE_URL}/api/v1/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = (await response.json()) as { detail?: string };
        throw new Error(error.detail || 'Failed to initialize upload');
      }

      const initData = (await response.json()) as UploadInitResponse;

      return {
        ...initData,
        zkEnabled: false,
      };
    }
  }

  /**
   * Upload file with parallel chunks
   *
   * @param file - File to upload
   * @param options - Upload options
   * @returns Upload result
   */
  async uploadFile(file: File, options: UploadOptions = {}): Promise<UploadCompleteResponse> {
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
      const { upload_id, storage_strategy, chunk_size, total_chunks, zkEnabled } = initData;
      const fileKey = zkEnabled ? initData.fileKey : undefined;

      // Create upload context
      const uploadContext: UploadContext = {
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
        fileKey, // File key for chunk encryption (ZK mode only)
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
      if (onError && error instanceof Error) {
        onError(error);
      }
      throw error;
    }
  }

  /**
   * Upload chunks in parallel with queue management
   */
  private async _uploadChunked(context: UploadContext, concurrency: number): Promise<void> {
    const { totalChunks } = context;

    // Create chunk queue
    const chunkQueue = Array.from({ length: totalChunks }, (_, i) => i);

    // Create worker pool
    const workers: Promise<void>[] = [];
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
  private async _chunkUploadWorker(context: UploadContext, chunkQueue: number[]): Promise<void> {
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
  private async _uploadChunkWithRetry(
    context: UploadContext,
    chunkIndex: number,
    retryCount: number = 0
  ): Promise<ChunkUploadResponse> {
    const { file, chunkSize, uploadId, zkEnabled, fileKey } = context;

    // Calculate chunk boundaries
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBlob = file.slice(start, end);

    let finalChunkData: Blob = chunkBlob;

    // ZK Mode: Encrypt chunk before upload
    if (zkEnabled && fileKey) {
      try {
        // Read chunk as ArrayBuffer
        const chunkArrayBuffer = await chunkBlob.arrayBuffer();
        const chunkBytes = new Uint8Array(chunkArrayBuffer);

        // Encrypt chunk with file key
        const encryptResult = zkEncryptionService.encryptFileChunk(chunkBytes, fileKey, chunkIndex);
        const { encryptedData } = encryptResult;

        // Convert encrypted bytes to Blob
        finalChunkData = new Blob([encryptedData as BlobPart]);

        console.log(
          `[Upload] Encrypted chunk ${chunkIndex}: ${chunkBytes.length} → ${encryptedData.length} bytes`
        );
      } catch (encryptError) {
        const errorMessage =
          encryptError instanceof Error ? encryptError.message : String(encryptError);
        console.error(`[Upload] Encryption failed for chunk ${chunkIndex}:`, encryptError);
        throw new Error(`Encryption failed: ${errorMessage}`);
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

      const result = (await response.json()) as ChunkUploadResponse;

      // Track bytes uploaded
      context.bytesUploaded += end - start;

      return result;
    } catch (error) {
      // Retry with exponential backoff
      if (retryCount < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        console.log(
          `Retrying chunk ${chunkIndex} after ${delay}ms (attempt ${retryCount + 1}/${
            this.maxRetries
          })`
        );

        await this._sleep(delay);
        return this._uploadChunkWithRetry(context, chunkIndex, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Upload file directly (for small/medium files)
   */
  private async _uploadDirect(context: UploadContext): Promise<unknown> {
    const { file, uploadId } = context;

    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE_URL}/api/v1/upload/direct/${uploadId}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });

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
  private async _completeUpload(uploadId: string): Promise<UploadCompleteResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/upload/complete/${uploadId}`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = (await response.json()) as { detail?: string };
      throw new Error(error.detail || 'Failed to complete upload');
    }

    return response.json() as Promise<UploadCompleteResponse>;
  }

  /**
   * Update progress callback
   */
  private _updateProgress(context: UploadContext): void {
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
  cancelUpload(uploadId: string): boolean {
    if (this.activeUploads.has(uploadId)) {
      this.activeUploads.delete(uploadId);
      return true;
    }
    return false;
  }

  /**
   * Get upload status
   */
  getUploadStatus(uploadId: string): UploadContext | undefined {
    return this.activeUploads.get(uploadId);
  }

  /**
   * Helper: Sleep for delay milliseconds
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Format bytes to human readable
   */
  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Format speed to human readable
   */
  static formatSpeed(bytesPerSecond: number): string {
    return this.formatBytes(bytesPerSecond) + '/s';
  }
}

// Export singleton instance
export default new UploadService();
