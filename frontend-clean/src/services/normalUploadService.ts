/**
 * Normal Upload Service - Standard File Uploads
 *
 * Features:
 * - Server-side encryption
 * - Parallel chunk uploads (configurable concurrency)
 * - Automatic retry with exponential backoff
 * - Progress tracking per chunk
 * - Network error resilience
 * - Upload resume support (same-session retry + cross-session resume)
 */

import { API_URL } from '../config/constants';

const API_BASE_URL = API_URL;

// ==================== Type Definitions ====================

interface UploadInitResponse {
  upload_id: string;
  storage_strategy: 'inline' | 'single' | 'chunked';
  chunk_size: number;
  total_chunks: number;
  recommended_concurrency?: number;
}

interface UploadInitNormalResponse extends UploadInitResponse {
  zkEnabled: false;
}

interface UploadProgressData {
  progress: number;
  bytesUploaded: number;
  totalBytes: number;
  chunksUploaded: number;
  totalChunks: number;
  speed: number;
  elapsed: number;
  eta: number;
}

export interface ServerUploadStatus {
  upload_id: string;
  status: string;
  strategy: 'inline' | 'single' | 'chunked';
  file_name: string;
  file_size: number;
  chunk_size: number;
  total_chunks: number;
  uploaded_chunks: number[];
  missing_chunks: number[];
  progress: number;
  recommended_concurrency?: number;
}

interface UploadOptions {
  concurrency?: number;
  onProgress?: (data: UploadProgressData) => void;
  onChunkComplete?: (chunkIndex: number, uploadedCount: number, totalChunks: number) => void;
  onSessionCreated?: (uploadId: string, chunkSize: number, totalChunks: number, strategy: string) => void;
  onError?: (error: Error) => void;
  folderId?: string | null;
  signal?: AbortSignal;
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
  abortSignal?: AbortSignal;
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

// ==================== Normal Upload Service Class ====================

class NormalUploadService {
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
   * Uses server-side encryption
   */
  async initUpload(file: File, folderId: string | null = null, signal?: AbortSignal): Promise<UploadInitNormalResponse> {
    // Build query parameters (backend expects query params, not JSON body)
    const params = new URLSearchParams();
    params.append('file_name', file.name);
    params.append('file_size', file.size.toString());
    if (folderId) {
      params.append('folder_id', folderId);
    }

    const response = await fetch(`${API_BASE_URL}/api/v1/upload/init?${params.toString()}`, {
      method: 'POST',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const error = (await response.json()) as { detail?: string | Array<{ msg: string }> };
      const errorMessage = typeof error.detail === 'string'
        ? error.detail
        : Array.isArray(error.detail)
          ? error.detail.map(e => e.msg).join(', ')
          : 'Failed to initialize upload';
      throw new Error(errorMessage);
    }

    const initData = (await response.json()) as UploadInitResponse;

    return {
      ...initData,
      zkEnabled: false,
    };
  }

  /**
   * Upload file with parallel chunks
   *
   * @param file - File to upload
   * @param options - Upload options
   * @returns Upload result with serverUploadId
   */
  async uploadFile(file: File, options: UploadOptions = {}): Promise<UploadCompleteResponse & { serverUploadId?: string }> {
    const {
      concurrency: userConcurrency,
      onProgress,
      onChunkComplete,
      onSessionCreated,
      onError,
      folderId = null,
      signal,
    } = options;

    let serverUploadId: string | null = null;

    try {
      // Step 1: Initialize upload
      const initData = await this.initUpload(file, folderId, signal);
      const { upload_id, storage_strategy, chunk_size, total_chunks } = initData;
      serverUploadId = upload_id;

      // Server hint caps concurrency (protects against bad parallelism on low-plan)
      const serverHint = initData.recommended_concurrency ?? this.defaultConcurrency;
      const concurrency = Math.min(userConcurrency ?? this.defaultConcurrency, serverHint);

      // Fire session created callback so context can checkpoint
      if (onSessionCreated) {
        onSessionCreated(upload_id, chunk_size, total_chunks, storage_strategy);
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
        ...(signal ? { abortSignal: signal } : {}),
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
      const result = await this._completeUpload(upload_id, signal);

      this.activeUploads.delete(upload_id);
      return { ...result, serverUploadId: upload_id };
    } catch (error) {
      if (serverUploadId) {
        this.activeUploads.delete(serverUploadId);

        // Only cancel on server for user-initiated cancels and non-network errors
        // Network errors should preserve the session for resume
        const isAbort = error instanceof DOMException && error.name === 'AbortError';
        const isNetwork = error instanceof Error && error.message.includes('Internet connection lost');

        if (isAbort) {
          // User cancelled — destroy server session
          this._cancelOnServer(serverUploadId);
        } else if (!isNetwork) {
          // Other errors — destroy server session
          this._cancelOnServer(serverUploadId);
        }
        // Network errors: do NOT cancel — preserve session for resume
      }
      if (onError && error instanceof Error) {
        onError(error);
      }
      throw error;
    }
  }

  /**
   * Get server-side upload status for resume.
   * Returns ServerUploadStatus if session alive, null if definitively gone (404/403),
   * or 'unknown' if transient failure (network error, 500, 503, etc.).
   */
  async getServerUploadStatus(uploadId: string): Promise<ServerUploadStatus | null | 'unknown'> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/upload/status/${uploadId}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (response.ok) {
        return (await response.json()) as ServerUploadStatus;
      }
      // 404 = session expired, 403 = wrong user — definitively gone
      if (response.status === 404 || response.status === 403) {
        return null;
      }
      // Other non-OK (401, 500, 503) — transient, preserve checkpoint
      return 'unknown';
    } catch {
      // Network error — can't determine, preserve checkpoint
      return 'unknown';
    }
  }

  /**
   * Resume an upload using an existing server session
   * Picks up where the previous upload left off
   */
  async resumeUpload(
    file: File,
    serverUploadId: string,
    serverStatus: ServerUploadStatus,
    options: UploadOptions = {}
  ): Promise<UploadCompleteResponse & { serverUploadId?: string }> {
    const {
      concurrency: userConcurrency,
      onProgress,
      onChunkComplete,
      onError,
      signal,
    } = options;

    // Server hint caps concurrency (protects against bad parallelism on low-plan)
    const serverHint = serverStatus.recommended_concurrency ?? this.defaultConcurrency;
    const concurrency = Math.min(userConcurrency ?? this.defaultConcurrency, serverHint);

    try {
      // Build context from server status (not from initUpload)
      const uploadContext: UploadContext = {
        uploadId: serverUploadId,
        file,
        strategy: serverStatus.strategy,
        chunkSize: serverStatus.chunk_size,
        totalChunks: serverStatus.total_chunks,
        uploadedChunks: new Set(serverStatus.uploaded_chunks),
        failedChunks: new Set(),
        startTime: Date.now(),
        bytesUploaded: serverStatus.uploaded_chunks.length * serverStatus.chunk_size,
        onProgress,
        onChunkComplete,
        onError,
        ...(signal ? { abortSignal: signal } : {}),
      };

      this.activeUploads.set(serverUploadId, uploadContext);

      // Report initial progress immediately (UI shows "50% — resuming")
      this._updateProgress(uploadContext);

      if (serverStatus.strategy === 'chunked') {
        if (serverStatus.missing_chunks.length > 0) {
          // Upload only the missing chunks
          await this._uploadMissingChunks(uploadContext, serverStatus.missing_chunks, concurrency);
        }
        // else: all chunks already uploaded, just complete
      } else {
        // Non-chunked: if not complete, re-upload directly
        if (serverStatus.progress < 100) {
          await this._uploadDirect(uploadContext);
        }
      }

      // Complete upload
      const result = await this._completeUpload(serverUploadId, signal);

      this.activeUploads.delete(serverUploadId);
      return { ...result, serverUploadId };
    } catch (error) {
      if (serverUploadId) {
        this.activeUploads.delete(serverUploadId);

        // Only cancel on AbortError (user cancel), preserve session on network errors
        const isAbort = error instanceof DOMException && error.name === 'AbortError';
        if (isAbort) {
          this._cancelOnServer(serverUploadId);
        }
        // Network and other errors during resume: preserve session
      }
      if (onError && error instanceof Error) {
        onError(error);
      }
      throw error;
    }
  }

  /**
   * Upload only the missing chunks (for resume)
   */
  private async _uploadMissingChunks(
    context: UploadContext,
    missingChunks: number[],
    concurrency: number
  ): Promise<void> {
    // Create queue from missing chunks only
    const chunkQueue = [...missingChunks];

    // Create worker pool
    const workerCount = Math.min(concurrency, chunkQueue.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(this._chunkUploadWorker(context, chunkQueue));
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    // Verify all chunks uploaded
    if (context.uploadedChunks.size !== context.totalChunks) {
      throw new Error(
        `Upload incomplete: ${context.uploadedChunks.size}/${context.totalChunks} chunks uploaded`
      );
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
      if (context.abortSignal?.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }

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
        // Propagate abort errors immediately — don't retry
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }

        // Propagate network errors — don't re-queue endlessly
        if (error instanceof Error && error.message.includes('Internet connection lost')) {
          throw error;
        }

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
  private async _uploadChunkWithRetry(
    context: UploadContext,
    chunkIndex: number,
    retryCount: number = 0
  ): Promise<ChunkUploadResponse> {
    const { file, chunkSize, uploadId } = context;

    // Calculate chunk boundaries
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBlob = file.slice(start, end);

    const formData = new FormData();
    formData.append('chunk', chunkBlob);
    formData.append('chunk_index', chunkIndex.toString());

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/upload/chunk/${uploadId}?chunk_index=${chunkIndex}`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData,
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
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
      // Don't retry AbortErrors — rethrow immediately
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

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

      // After retries exhausted, provide network-specific error message
      if (this._isNetworkError(error)) {
        throw new Error('Upload failed: Internet connection lost. Please check your connection and try again.');
      }

      throw error;
    }
  }

  /**
   * Upload file directly (for small/medium files)
   */
  private async _uploadDirect(context: UploadContext): Promise<unknown> {
    const { file, uploadId } = context;

    // Report initial progress (0/1 chunks) so UI shows correct total
    this._updateProgress(context);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/upload/direct/${uploadId}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      context.bytesUploaded = file.size;
      this._updateProgress(context);

      return response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      if (this._isNetworkError(error)) {
        throw new Error('Upload failed: Internet connection lost. Please check your connection and try again.');
      }
      throw error;
    }
  }

  /**
   * Complete the upload
   */
  private async _completeUpload(uploadId: string, signal?: AbortSignal): Promise<UploadCompleteResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/upload/complete/${uploadId}`, {
      method: 'POST',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const error = (await response.json()) as { detail?: string };
      throw new Error(error.detail || 'Failed to complete upload');
    }

    return response.json() as Promise<UploadCompleteResponse>;
  }

  /**
   * Best-effort server-side cancel — fire and forget
   */
  private _cancelOnServer(uploadId: string): void {
    fetch(`${API_BASE_URL}/api/v1/upload/cancel/${uploadId}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {
      // Best-effort: swallow errors — orphan cleanup worker handles leftovers
    });
  }

  /**
   * Check if an error is a network connectivity error
   */
  private _isNetworkError(error: unknown): boolean {
    if (error instanceof TypeError) {
      const msg = error.message.toLowerCase();
      return msg.includes('failed to fetch') || msg.includes('load failed') || msg.includes('networkerror');
    }
    return false;
  }

  /**
   * Update progress callback
   */
  private _updateProgress(context: UploadContext): void {
    if (!context.onProgress) return;

    const { bytesUploaded, file, startTime, strategy, totalChunks, uploadedChunks } = context;
    const progress = (bytesUploaded / file.size) * 100;
    const elapsed = (Date.now() - startTime) / 1000; // seconds
    const speed = bytesUploaded / elapsed; // bytes per second

    // Chunk counts: chunked uploads use real counts; direct/single use 1 "chunk"
    const totalChunksForProgress = strategy === 'chunked' ? totalChunks : 1;
    const chunksUploadedForProgress =
      strategy === 'chunked'
        ? uploadedChunks.size
        : bytesUploaded >= file.size
          ? 1
          : 0;

    context.onProgress({
      progress: Math.min(progress, 100),
      bytesUploaded,
      totalBytes: file.size,
      chunksUploaded: chunksUploadedForProgress,
      totalChunks: totalChunksForProgress,
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
const normalUploadService = new NormalUploadService();
export { normalUploadService, NormalUploadService };
export default normalUploadService;
