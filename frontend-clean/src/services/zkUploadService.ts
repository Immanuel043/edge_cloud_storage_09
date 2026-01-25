/**
 * ZK Upload Service - Zero-Knowledge Encrypted File Uploads
 *
 * Features:
 * - Client-side encryption before upload (AES-256-GCM with HKDF)
 * - Parallel chunk uploads (configurable concurrency)
 * - Automatic retry with exponential backoff
 * - Progress tracking per chunk
 * - V2 encryption with AAD for tamper protection
 * - Encrypted filename support
 * - Encrypted thumbnail support
 */

import * as zkEncryptionService from './zkEncryptionService';
import { ZK_SERVICE_URL } from '../config/constants';
import { generateEncryptedThumbnail, supportsThumbnail } from '../utils/zkThumbnails';
import { generateUploadId } from '../utils/zkCrypto';

const API_BASE_URL = ZK_SERVICE_URL;

// ==================== Type Definitions ====================

interface UploadInitZKRequest {
  upload_id: string;
  encrypted_file_name: string;
  file_name_iv: string;
  file_size: number;
  mime_type: string;
  encrypted_file_key: string;
  file_key_iv: string;
  encryption_algorithm: string;
  encryption_version: number;
  chunk_size: number;
  parent_folder_id: string | null;
  encrypted_thumbnail: string | null;
  thumbnail_iv: string | null;
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
  generateThumbnail?: boolean;
}

// Extended progress data for ZK uploads (includes encryption status)
export interface ZKUploadProgressData extends UploadProgressData {
  status?: string;
  uploadId?: string;
  chunk?: number;
  totalChunks?: number;
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
  fileKey: Uint8Array;
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

// ==================== ZK Upload Service Class ====================

class ZKUploadService {
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
   * Initialize a new ZK upload session
   * - Generates uploadId for V2 AAD binding
   * - Generates and encrypts file key
   * - Encrypts filename
   * - Optionally generates encrypted thumbnail
   */
  async initUpload(
    file: File,
    folderId: string | null = null,
    options: { generateThumbnail?: boolean } = {}
  ): Promise<UploadInitZKResponse> {
    console.log('[ZK Upload] Initializing V2 encrypted upload:', file.name);

    // Generate uploadId FIRST for V2 AAD binding
    const uploadId = generateUploadId();
    console.log('[ZK Upload] Generated uploadId for V2 AAD:', uploadId);

    // Generate file key and encrypt with master key
    const zkPrepResult = await zkEncryptionService.prepareFileForEncryption(file);
    const { fileKey, encryptedFileKey, fileKeyIV } = zkPrepResult;

    // Encrypt filename with master key
    const { encryptedFilename, filenameIV } = zkEncryptionService.encryptFilename(file.name);

    // Generate encrypted thumbnail (if supported and requested)
    let encryptedThumbnail: string | null = null;
    let thumbnailIV: string | null = null;

    if (options.generateThumbnail !== false && supportsThumbnail(file.type)) {
      try {
        const thumbnailResult = await generateEncryptedThumbnail(file, fileKey);
        if (thumbnailResult) {
          encryptedThumbnail = thumbnailResult.encryptedThumbnail;
          thumbnailIV = thumbnailResult.iv;
          console.log('[ZK Upload] Generated encrypted thumbnail');
        }
      } catch (thumbnailError) {
        console.warn('[ZK Upload] Thumbnail generation failed:', thumbnailError);
      }
    }

    // Call ZK upload init endpoint with pre-generated uploadId
    const requestBody: UploadInitZKRequest = {
      upload_id: uploadId,
      encrypted_file_name: encryptedFilename,
      file_name_iv: filenameIV,
      file_size: file.size,
      mime_type: file.type,
      encrypted_file_key: encryptedFileKey,
      file_key_iv: fileKeyIV,
      encryption_algorithm: 'AES-256-GCM',
      encryption_version: 2, // V2 encryption (HKDF + AAD)
      chunk_size: 1024 * 1024, // 1MB chunks
      parent_folder_id: folderId,
      encrypted_thumbnail: encryptedThumbnail,
      thumbnail_iv: thumbnailIV,
    };

    const response = await fetch(`${API_BASE_URL}/api/v1/zk/upload/init`, {
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

    // Return with ZK metadata (use our pre-generated uploadId)
    return {
      ...initData,
      upload_id: uploadId, // Override with our pre-generated ID for V2 AAD
      zkEnabled: true,
      fileKey, // Keep file key in memory for chunk encryption
    };
  }

  /**
   * Upload file with parallel chunks and client-side encryption
   *
   * @param file - File to upload
   * @param options - Upload options
   * @returns Upload result with file_id
   */
  async uploadFile(file: File, options: UploadOptions = {}): Promise<UploadCompleteResponse> {
    const {
      concurrency = this.defaultConcurrency,
      onProgress,
      onChunkComplete,
      onError,
      folderId = null,
      generateThumbnail = true,
    } = options;

    try {
      // Report initial progress
      if (onProgress) {
        (onProgress as (data: ZKUploadProgressData) => void)({
          progress: 0,
          bytesUploaded: 0,
          totalBytes: file.size,
          speed: 0,
          elapsed: 0,
          eta: 0,
          status: 'Encrypting file (V2)...',
        });
      }

      // Step 1: Initialize upload (encrypts file key, filename, thumbnail)
      const initData = await this.initUpload(file, folderId, { generateThumbnail });
      const { upload_id, storage_strategy, chunk_size, total_chunks, fileKey } = initData;

      // Report encryption complete
      if (onProgress) {
        (onProgress as (data: ZKUploadProgressData) => void)({
          progress: 10,
          bytesUploaded: 0,
          totalBytes: file.size,
          speed: 0,
          elapsed: 0,
          eta: 0,
          status: 'Initializing upload...',
          uploadId: upload_id,
        });
      }

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
        fileKey, // File key for chunk encryption
      };

      this.activeUploads.set(upload_id, uploadContext);

      // Step 2: Handle different upload strategies
      if (storage_strategy === 'chunked') {
        await this._uploadChunked(uploadContext, concurrency);
      } else {
        // Direct upload for small/medium files (still encrypted)
        await this._uploadDirect(uploadContext);
      }

      // Report finalizing
      if (onProgress) {
        (onProgress as (data: ZKUploadProgressData) => void)({
          progress: 95,
          bytesUploaded: file.size,
          totalBytes: file.size,
          speed: 0,
          elapsed: (Date.now() - uploadContext.startTime) / 1000,
          eta: 0,
          status: 'Finalizing upload...',
          uploadId: upload_id,
        });
      }

      // Step 3: Complete upload
      const result = await this._completeUpload(upload_id, total_chunks);

      // Report complete
      if (onProgress) {
        (onProgress as (data: ZKUploadProgressData) => void)({
          progress: 100,
          bytesUploaded: file.size,
          totalBytes: file.size,
          speed: 0,
          elapsed: (Date.now() - uploadContext.startTime) / 1000,
          eta: 0,
          status: 'Upload complete!',
          uploadId: upload_id,
        });
      }

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
   * Upload single chunk with encryption and exponential backoff retry
   */
  private async _uploadChunkWithRetry(
    context: UploadContext,
    chunkIndex: number,
    retryCount: number = 0
  ): Promise<ChunkUploadResponse> {
    const { file, chunkSize, uploadId, fileKey } = context;

    // Calculate chunk boundaries
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBlob = file.slice(start, end);

    try {
      // Read chunk as ArrayBuffer
      const chunkArrayBuffer = await chunkBlob.arrayBuffer();
      const chunkBytes = new Uint8Array(chunkArrayBuffer);

      // Encrypt chunk with V2 encryption (HKDF + AAD)
      // V2 returns single Uint8Array: VERSION + IV + ciphertext + tag
      const encryptedChunk = zkEncryptionService.encryptFileChunkV2(
        chunkBytes,
        fileKey,
        uploadId, // Use uploadId as fileId for AAD binding
        chunkIndex
      );

      // Convert encrypted bytes to Blob
      const finalChunkData = new Blob([encryptedChunk as BlobPart]);

      console.log(
        `[ZK Upload] Encrypted chunk ${chunkIndex} (V2): ${chunkBytes.length} → ${encryptedChunk.length} bytes`
      );

      const formData = new FormData();
      formData.append('chunk', finalChunkData);
      formData.append('chunk_index', chunkIndex.toString());

      const response = await fetch(`${API_BASE_URL}/api/v1/zk/upload/chunk/${uploadId}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

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
   * Still encrypted before upload
   */
  private async _uploadDirect(context: UploadContext): Promise<unknown> {
    const { file, uploadId, fileKey } = context;

    // For direct upload, encrypt the entire file
    const fileArrayBuffer = await file.arrayBuffer();
    const fileBytes = new Uint8Array(fileArrayBuffer);

    // Encrypt with V2 encryption
    const encryptedFile = zkEncryptionService.encryptFileChunkV2(
      fileBytes,
      fileKey,
      uploadId,
      0 // Chunk index 0 for single file
    );

    const formData = new FormData();
    formData.append('file', new Blob([encryptedFile as BlobPart]));

    const response = await fetch(`${API_BASE_URL}/api/v1/zk/upload/direct/${uploadId}`, {
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
   * Complete the ZK upload
   */
  private async _completeUpload(
    uploadId: string,
    totalChunks: number
  ): Promise<UploadCompleteResponse> {
    const body = { total_chunks: totalChunks };

    const response = await fetch(`${API_BASE_URL}/api/v1/zk/upload/complete/${uploadId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json()) as { detail?: string };
      throw new Error(error.detail || 'Failed to complete upload');
    }

    return response.json() as Promise<UploadCompleteResponse>;
  }

  /**
   * Update progress callback with chunk status
   */
  private _updateProgress(context: UploadContext): void {
    if (!context.onProgress) return;

    const { bytesUploaded, file, startTime, uploadedChunks, totalChunks, uploadId } = context;
    // Scale progress: 10% for init, 10-95% for chunks, 95-100% for finalize
    const chunkProgress = 10 + ((bytesUploaded / file.size) * 85);
    const elapsed = (Date.now() - startTime) / 1000; // seconds
    const speed = elapsed > 0 ? bytesUploaded / elapsed : 0; // bytes per second

    (context.onProgress as (data: ZKUploadProgressData) => void)({
      progress: Math.min(chunkProgress, 95),
      bytesUploaded,
      totalBytes: file.size,
      speed,
      elapsed,
      eta: speed > 0 ? (file.size - bytesUploaded) / speed : 0,
      status: `Uploading chunk ${uploadedChunks.size}/${totalChunks}...`,
      uploadId,
      chunk: uploadedChunks.size,
      totalChunks,
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
const zkUploadService = new ZKUploadService();
export { zkUploadService, ZKUploadService };
export default zkUploadService;
