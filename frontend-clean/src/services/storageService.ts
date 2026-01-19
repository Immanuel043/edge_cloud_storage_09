import { API_URL, ZK_SERVICE_URL, ZK_STORAGE } from '../config/constants';
import { sanitizeInput, validateFileType, validateFileSize } from '../utils/security';
import { rateLimiter } from '../utils/rateLimiter';
import { requestCache } from '../utils/requestCache';
import * as zkEncryptionService from './zkEncryptionService';
import { getWorkerPool } from './zkDecryptWorkerPool';

// Threshold (bytes) above which we prefer native browser download instead of buffering in JS.
// PERFORMANCE FIX: Lowered to 10MB to prevent crashes on mobile devices
const MEMORY_BUFFER_THRESHOLD = 10 * 1024 * 1024; // 10MB

// ==================== Type Definitions ====================

interface DownloadOptions {
  onProgress?: ((progress: DownloadProgress) => void) | null;
  resumeFrom?: number;
  maxRetries?: number;
  bufferThreshold?: number;
}

interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  progress: number | null;
}

interface DownloadInfo {
  chunks: BlobPart[];
  totalBytes: number;
  totalSize: number;
  startTime: number;
}

interface DownloadResult {
  success: boolean;
  fileName: string;
  size?: number;
  duration?: number;
}

interface SavedProgress {
  fileId: string;
  totalBytes: number;
  totalSize: number;
  timestamp: number;
}

interface FileMetadata {
  file_id?: string;
  id?: string;
  file_name?: string;
  encrypted_file_key?: string;
  file_key_iv?: string;
  file_size?: number;
  chunk_size?: number;
  encryption_mode?: string;
  [key: string]: unknown;
}

// ==================== Resumable Download Manager ====================

class ResumableDownloadManager {
  private downloads: Map<string, DownloadInfo>;
  private downloadProgress: Map<string, SavedProgress>;

  constructor() {
    this.downloads = new Map();
    this.downloadProgress = new Map();
  }

  async downloadFile(
    token: string,
    fileId: string,
    fileName: string,
    options: DownloadOptions = {}
  ): Promise<DownloadResult> {
    const {
      onProgress = null,
      resumeFrom = 0,
      maxRetries = 3,
      bufferThreshold = MEMORY_BUFFER_THRESHOLD,
    } = options;

    try {
      // HEAD to get metadata
      const headResp = await fetch(`${API_URL}/api/v1/files/${fileId}/download`, {
        method: 'HEAD',
        credentials: 'include', // Send HTTP-only cookie
      });

      if (!headResp.ok) {
        throw new Error(`Failed to get file info: ${headResp.status}`);
      }

      const totalSize = parseInt(headResp.headers.get('content-length') || '0', 10);
      const acceptRanges = (headResp.headers.get('accept-ranges') || '').toLowerCase() === 'bytes';
      const contentType = headResp.headers.get('content-type') || 'application/octet-stream';

      // If very large file, prefer native download (browser handles resume natively)
      if (totalSize > bufferThreshold) {
        console.log(
          `File is large (${(totalSize / (1024 * 1024)).toFixed(
            1
          )} MB) — using native download to avoid buffering in JS.`
        );
        await this.nativeDownload(token, fileId, fileName);
        return { success: true, fileName, size: totalSize, duration: 0 };
      }

      // initialize or resume info
      let startByte = resumeFrom;
      const existing = this.downloads.get(fileId);
      if (existing && existing.totalBytes) {
        startByte = existing.totalBytes;
      }

      if (!this.downloads.has(fileId)) {
        this.downloads.set(fileId, {
          chunks: [],
          totalBytes: 0,
          totalSize,
          startTime: Date.now(),
        });
      } else {
        // ensure totalSize is set/updated
        const info = this.downloads.get(fileId)!;
        info.totalSize = totalSize;
      }

      const downloadInfo = this.downloads.get(fileId)!;

      // If server supports ranges and we have a resume point > 0, use range requests.
      if (acceptRanges && startByte > 0 && startByte < totalSize) {
        await this.downloadRange(
          token,
          fileId,
          startByte,
          totalSize - 1,
          downloadInfo,
          onProgress,
          maxRetries
        );
      } else if (acceptRanges && startByte === 0) {
        // we can also request range 0-end and still accept 206/200
        await this.downloadRange(token, fileId, 0, totalSize - 1, downloadInfo, onProgress, maxRetries);
      } else {
        await this.downloadFull(token, fileId, downloadInfo, onProgress, maxRetries);
      }

      // build blob and trigger download
      const blob = new Blob(downloadInfo.chunks, { type: contentType });
      this.triggerDownload(blob, fileName);

      // cleanup
      this.downloads.delete(fileId);
      this.downloadProgress.delete(fileId);
      this.clearProgress(fileId);

      const duration = (Date.now() - downloadInfo.startTime) / 1000;
      console.log(`Download complete: ${fileName} in ${duration.toFixed(1)}s`);
      return { success: true, fileName, size: totalSize, duration };
    } catch (err) {
      console.error('Download error:', err);

      // save resumable progress if any bytes downloaded
      const info = this.downloads.get(fileId);
      if (info && info.totalBytes > 0) {
        this.saveProgress(fileId, info);
      }

      throw err;
    }
  }

  // Attempt a range download with retries. Accept both 206 and 200 (server may return 200).
  async downloadRange(
    _token: string,
    fileId: string,
    start: number,
    end: number,
    downloadInfo: DownloadInfo,
    onProgress: ((progress: DownloadProgress) => void) | null,
    maxRetries: number = 3
  ): Promise<void> {
    const url = `${API_URL}/api/v1/files/${fileId}/download`;
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxRetries) {
      attempt += 1;
      try {
        const headers: Record<string, string> = {
          Range: `bytes=${start}-${end}`,
        };

        const resp = await fetch(url, {
          method: 'GET',
          headers,
          credentials: 'include', // Send HTTP-only cookie
        });

        // Accept 206 (partial) or 200 (server responded with full content)
        if (resp.status !== 206 && resp.status !== 200) {
          throw new Error(`Range request failed with status ${resp.status}`);
        }

        // ensure we have reader or fallback to blob
        await this.processResponse(resp, downloadInfo, onProgress);
        return;
      } catch (e) {
        lastError = e as Error;
        console.warn(`Range download attempt ${attempt} failed: ${(e as Error).message}`);
        // small backoff
        await new Promise((r) => setTimeout(r, attempt * 300));
      }
    }

    throw lastError || new Error('Range download failed');
  }

  async downloadFull(
    _token: string,
    fileId: string,
    downloadInfo: DownloadInfo,
    onProgress: ((progress: DownloadProgress) => void) | null,
    maxRetries: number = 3
  ): Promise<void> {
    const url = `${API_URL}/api/v1/files/${fileId}/download`;
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxRetries) {
      attempt += 1;
      try {
        const resp = await fetch(url, { method: 'GET', credentials: 'include' });
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        await this.processResponse(resp, downloadInfo, onProgress);
        return;
      } catch (e) {
        lastError = e as Error;
        console.warn(`Full download attempt ${attempt} failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, attempt * 300));
      }
    }

    throw lastError || new Error('Full download failed');
  }

  // Processes a fetch Response: preferred streaming via body reader; fallback to blob()
  async processResponse(
    response: Response,
    downloadInfo: DownloadInfo,
    onProgress: ((progress: DownloadProgress) => void) | null
  ): Promise<void> {
    // Ensure totalSize known (some HEAD responses may have set it)
    if (!downloadInfo.totalSize) {
      const tl = response.headers.get('content-length');
      downloadInfo.totalSize = tl ? parseInt(tl, 10) : downloadInfo.totalSize || 0;
    }

    // If response.body is not available (some environments), fallback to blob()
    if (!response.body || typeof response.body.getReader !== 'function') {
      const blob = await response.blob();
      downloadInfo.chunks.push(blob);
      downloadInfo.totalBytes += blob.size || 0;
      if (onProgress) {
        onProgress({
          bytesDownloaded: downloadInfo.totalBytes,
          totalBytes: downloadInfo.totalSize,
          progress: downloadInfo.totalSize ? (downloadInfo.totalBytes / downloadInfo.totalSize) * 100 : 100,
        });
      }
      return;
    }

    const reader = response.body.getReader();
    let lastProgressUpdate = Date.now();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        // value is a Uint8Array
        const size = value.byteLength || value.length || 0;
        downloadInfo.chunks.push(value);
        downloadInfo.totalBytes += size;

        // progress callback throttle ~100ms
        if (onProgress && Date.now() - lastProgressUpdate > 100) {
          const pct = downloadInfo.totalSize ? (downloadInfo.totalBytes / downloadInfo.totalSize) * 100 : null;
          onProgress({
            bytesDownloaded: downloadInfo.totalBytes,
            totalBytes: downloadInfo.totalSize,
            progress: pct !== null ? Number(pct.toFixed(2)) : null,
          });
          lastProgressUpdate = Date.now();
        }
      }

      // final progress
      if (onProgress) {
        const pct = downloadInfo.totalSize ? (downloadInfo.totalBytes / downloadInfo.totalSize) * 100 : 100;
        onProgress({
          bytesDownloaded: downloadInfo.totalBytes,
          totalBytes: downloadInfo.totalSize,
          progress: Number(pct.toFixed(2)),
        });
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Save resumable info to localStorage
  saveProgress(fileId: string, downloadInfo: DownloadInfo): void {
    try {
      localStorage.setItem(
        `download_progress_${fileId}`,
        JSON.stringify({
          fileId,
          totalBytes: downloadInfo.totalBytes,
          totalSize: downloadInfo.totalSize,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn('Failed to save download progress', e);
    }
  }

  getProgress(fileId: string): SavedProgress | null {
    try {
      const saved = localStorage.getItem(`download_progress_${fileId}`);
      return saved ? (JSON.parse(saved) as SavedProgress) : null;
    } catch (e) {
      return null;
    }
  }

  clearProgress(fileId: string): void {
    try {
      localStorage.removeItem(`download_progress_${fileId}`);
    } catch (_) {
      /* ignore */
    }
  }

  triggerDownload(blobOrUint8s: Blob | BlobPart[], fileName: string): void {
    // If the accumulated parts are Uint8Arrays, Blob() will handle arrays of them.
    const blob = blobOrUint8s instanceof Blob ? blobOrUint8s : new Blob(blobOrUint8s as BlobPart[]);
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName || '';
    document.body.appendChild(a);
    a.click();
    // cleanup
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch (_) {
        /* ignore */
      }
      try {
        window.URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
    }, 1500);
  }

  // Native anchor fallback (preferred for very large files)
  async nativeDownload(_token: string, fileId: string, fileName: string): Promise<void> {
    const url = `${API_URL}/api/v1/files/${fileId}/download`;

    try {
      // Fetch with authentication via HTTP-only cookie
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      // Get the blob
      const blob = await response.blob();

      // Create object URL and trigger download
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = blobUrl;
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();

      // Cleanup
      setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(blobUrl);
      }, 1000);
    } catch (error) {
      console.error('Native download failed:', error);
      throw error;
    }
  }

  formatBytes(bytes: number, decimals: number = 2): string {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
  }
}

// ==================== Storage Service ====================

class StorageService {
  private downloadManager: ResumableDownloadManager;

  constructor() {
    this.downloadManager = new ResumableDownloadManager();
  }

  async getFiles(_token: string, folderId: string | null = null): Promise<unknown> {
    await rateLimiter.checkLimit();

    // PERFORMANCE FIX: Deduplicate simultaneous requests
    const cacheKey = `files-${folderId || 'root'}`;
    return requestCache.dedupe(
      cacheKey,
      async () => {
        const url = `${API_URL}/api/v1/files${folderId ? `?folder_id=${folderId}` : ''}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load files');
        return await response.json();
      },
      { useCache: true, ttl: 3000 }
    ); // 3s cache
  }

  async getFolders(_token: string, parentId: string | null = null): Promise<unknown> {
    await rateLimiter.checkLimit();

    // PERFORMANCE FIX: Deduplicate simultaneous requests
    const cacheKey = `folders-${parentId || 'root'}`;
    return requestCache.dedupe(
      cacheKey,
      async () => {
        const url = `${API_URL}/api/v1/folders${parentId ? `?parent_id=${parentId}` : ''}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load folders');
        return await response.json();
      },
      { useCache: true, ttl: 3000 }
    ); // 3s cache
  }

  // Resumable download with progress and fallback
  async downloadFile(token: string, fileId: string, fileName: string): Promise<DownloadResult> {
    await rateLimiter.checkLimit();

    try {
      // Check saved progress and prompt to resume if within last 24h
      let resumeFrom = 0;
      const progress = this.downloadManager.getProgress(fileId);
      if (progress && Date.now() - progress.timestamp < 24 * 60 * 60 * 1000) {
        const pct = progress.totalSize ? ((progress.totalBytes / progress.totalSize) * 100).toFixed(1) : null;
        const shouldResume = window.confirm(
          `Resume previous download? ${pct ? `${pct}% complete` : ''}`
        );
        if (shouldResume) resumeFrom = progress.totalBytes;
        else this.downloadManager.clearProgress(fileId);
      }

      return await this.downloadManager.downloadFile(token, fileId, fileName, {
        resumeFrom,
        onProgress: (prog) => {
          // bubble progress to UI
          window.dispatchEvent(
            new CustomEvent('downloadProgress', { detail: { fileId, fileName, ...prog } })
          );
        },
      });
    } catch (error) {
      console.error('Download error:', error);
      // fallback to native (anchor) if range isn't supported or other fatal errors
      try {
        console.log('Falling back to native browser download...');
        await this.downloadManager.nativeDownload(token, fileId, fileName);
        return { success: true, fileName };
      } catch (fallbackErr) {
        console.error('Fallback failed:', fallbackErr);
        throw error;
      }
    }
  }

  // Fallback simple download kept for compatibility (use nativeDownload instead for large files)
  async simpleDownload(_token: string, fileId: string, fileName: string): Promise<DownloadResult> {
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/download`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch (_) {
        /* ignore */
      }
      try {
        window.URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
    }, 10000);
    return { success: true, fileName };
  }

  // Helper function to download a single chunk with retry logic
  // useZKService: if true, uses ZK chunk endpoint (for client-side encrypted files)
  async _downloadChunkWithRetry(
    fileId: string,
    chunkIndex: number,
    retryCount: number = 0,
    maxRetries: number = 3,
    useZKService: boolean = false
  ): Promise<ArrayBuffer> {
    const retryDelay = 1000; // 1 second base delay

    try {
      // For ZK files, use the ZK service endpoint (port 8002)
      // For regular files, use the storage service endpoint (port 8001)
      const endpoint = useZKService
        ? `${ZK_SERVICE_URL}/api/v1/zk/files/${fileId}/chunk/${chunkIndex}`
        : `${API_URL}/api/v1/files/${fileId}/download/chunk/${chunkIndex}`;

      const chunkResponse = await fetch(endpoint, { credentials: 'include' });

      if (!chunkResponse.ok) {
        throw new Error(`HTTP ${chunkResponse.status}: ${chunkResponse.statusText}`);
      }

      return await chunkResponse.arrayBuffer();
    } catch (error) {
      // Retry with exponential backoff
      if (retryCount < maxRetries) {
        const delay = retryDelay * Math.pow(2, retryCount);
        console.log(
          `[Download] Chunk ${chunkIndex} failed, retrying in ${delay}ms (attempt ${
            retryCount + 1
          }/${maxRetries})`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this._downloadChunkWithRetry(fileId, chunkIndex, retryCount + 1, maxRetries, useZKService);
      }

      // Max retries exceeded
      throw new Error(
        `Failed to download chunk ${chunkIndex} after ${maxRetries} retries: ${(error as Error).message}`
      );
    }
  }

  // Zero-Knowledge file download with client-side decryption
  async downloadZKFile(
    fileId: string,
    fileName: string,
    metadata: FileMetadata,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<DownloadResult> {
    console.log('[Download] Starting ZK file download:', fileName);

    // 1. Check if ZK session is unlocked
    if (!zkEncryptionService.isZKSessionUnlocked()) {
      throw new Error('ZK session is locked. Please unlock to download encrypted files.');
    }

    try {
      // 2. Decrypt file key with master key
      console.log('[Download] Decrypting file key...');
      const fileKey = zkEncryptionService.prepareFileForDecryption(
        metadata.encrypted_file_key!,
        metadata.file_key_iv!
      );

      // 3. Determine number of chunks
      const chunkSize = metadata.chunk_size || 32 * 1024 * 1024; // 32MB default
      const totalChunks = Math.ceil((metadata.file_size || 0) / chunkSize);
      console.log(`[Download] File has ${totalChunks} chunks`);

      // 4. Download and decrypt chunks
      const decryptedChunks: Uint8Array[] = [];

      for (let i = 0; i < totalChunks; i++) {
        // Update progress: downloading stage
        if (onProgress) {
          onProgress({
            currentStage: 'downloading',
            currentChunk: i + 1,
            totalChunks,
            downloadProgress: ((i + 1) / totalChunks) * 100,
            decryptProgress: 0,
            bytesDownloaded: i * chunkSize,
            totalBytes: metadata.file_size,
            isZK: true,
            retrying: false,
          });
        }

        // Download encrypted chunk with retry logic (use ZK service for ZK files)
        const encryptedChunk = await this._downloadChunkWithRetry(fileId, i, 0, 3, true);
        console.log(`[Download] Downloaded chunk ${i}: ${encryptedChunk.byteLength} bytes`);

        // Update progress: decrypting stage
        if (onProgress) {
          onProgress({
            currentStage: 'decrypting',
            currentChunk: i + 1,
            totalChunks,
            downloadProgress: 100,
            decryptProgress: ((i + 1) / totalChunks) * 100,
            bytesDownloaded: (i + 1) * chunkSize,
            totalBytes: metadata.file_size,
            chunksDecrypted: i + 1,
            isZK: true,
          });
        }

        // Decrypt chunk with corruption detection
        let decryptedChunk: Uint8Array;
        try {
          decryptedChunk = zkEncryptionService.decryptFileChunk(
            new Uint8Array(encryptedChunk),
            fileKey,
            i
          );
          console.log(`[Download] Decrypted chunk ${i}: ${decryptedChunk.length} bytes`);
        } catch (decryptError) {
          // Detect corruption or authentication errors
          const errorMessage = (decryptError as Error).message;
          if (
            errorMessage &&
            (errorMessage.includes('authentication') ||
              errorMessage.includes('corrupted') ||
              errorMessage.includes('tag mismatch') ||
              errorMessage.includes('Decryption failed'))
          ) {
            throw new Error(
              `File corruption detected in chunk ${i}. The file may have been tampered with or corrupted during storage. ` +
                `Please try re-uploading the file or contact support if this persists.`
            );
          }
          // Re-throw other decryption errors
          throw new Error(`Failed to decrypt chunk ${i}: ${errorMessage}`);
        }

        decryptedChunks.push(decryptedChunk);

        // Dispatch progress event (for backward compatibility)
        window.dispatchEvent(
          new CustomEvent('downloadProgress', {
            detail: {
              fileId,
              fileName,
              progress: ((i + 1) / totalChunks) * 100,
              bytesDownloaded: (i + 1) * chunkSize,
              totalBytes: metadata.file_size,
              decrypting: true,
              isZK: true,
            },
          })
        );
      }

      // 5. Assemble decrypted chunks into Blob
      console.log('[Download] Assembling decrypted chunks...');
      const blob = new Blob(decryptedChunks as BlobPart[], {
        type: (metadata as Record<string, unknown>).mime_type as string || 'application/octet-stream',
      });

      // 6. Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try {
          document.body.removeChild(a);
        } catch (_) {
          /* ignore */
        }
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* ignore */
        }
      }, 10000);

      console.log('[Download] ZK file downloaded and decrypted successfully!');

      // Final progress update
      if (onProgress) {
        onProgress({
          currentStage: 'completed',
          currentChunk: totalChunks,
          totalChunks,
          downloadProgress: 100,
          decryptProgress: 100,
          bytesDownloaded: metadata.file_size,
          totalBytes: metadata.file_size,
          chunksDecrypted: totalChunks,
          isZK: true,
        });
      }

      return { success: true, fileName, size: metadata.file_size || 0 };
    } catch (error) {
      console.error('[Download] ZK download failed:', error);
      throw new Error(`ZK download failed: ${(error as Error).message}`);
    }
  }

  // Zero-Knowledge file PREVIEW - returns blob URL for in-browser display
  // Used for previewing ZK-encrypted images, PDFs, and other viewable files
  async previewZKFile(
    fileId: string,
    metadata: FileMetadata,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<{ blobUrl: string; blob: Blob; mimeType: string | undefined }> {
    console.log('[Preview] Starting ZK file preview:', fileId);

    // 1. Check if ZK session is unlocked
    if (!zkEncryptionService.isZKSessionUnlocked()) {
      throw new Error('ZK session is locked. Please unlock to preview encrypted files.');
    }

    try {
      // 2. Decrypt file key with master key
      const fileKey = zkEncryptionService.prepareFileForDecryption(
        metadata.encrypted_file_key!,
        metadata.file_key_iv!
      );

      // 3. Determine number of chunks
      const chunkSize = metadata.chunk_size || 32 * 1024 * 1024;
      const totalChunks = Math.ceil((metadata.file_size || 0) / chunkSize);
      console.log(`[Preview] File has ${totalChunks} chunks`);

      // 4. Download and decrypt chunks
      const decryptedChunks: Uint8Array[] = [];

      for (let i = 0; i < totalChunks; i++) {
        if (onProgress) {
          onProgress({
            stage: 'downloading',
            chunk: i + 1,
            totalChunks,
            progress: Math.round((i / totalChunks) * 50),
          });
        }

        // Download encrypted chunk from ZK service
        const encryptedChunk = await this._downloadChunkWithRetry(fileId, i, 0, 3, true);

        if (onProgress) {
          onProgress({
            stage: 'decrypting',
            chunk: i + 1,
            totalChunks,
            progress: 50 + Math.round(((i + 1) / totalChunks) * 50),
          });
        }

        // Decrypt chunk
        const decryptedChunk = zkEncryptionService.decryptFileChunk(
          new Uint8Array(encryptedChunk),
          fileKey,
          i
        );
        decryptedChunks.push(decryptedChunk);
      }

      // 5. Assemble decrypted chunks into Blob
      const blob = new Blob(decryptedChunks as BlobPart[], {
        type: (metadata as Record<string, unknown>).mime_type as string || 'application/octet-stream',
      });
      const blobUrl = URL.createObjectURL(blob);

      console.log('[Preview] ZK file decrypted successfully for preview');

      if (onProgress) {
        onProgress({ stage: 'complete', progress: 100 });
      }

      return { blobUrl, blob, mimeType: (metadata as Record<string, unknown>).mime_type as string };
    } catch (error) {
      console.error('[Preview] ZK preview failed:', error);
      throw new Error(`ZK preview failed: ${(error as Error).message}`);
    }
  }

  // Zero-Knowledge file download with STREAMING DECRYPTION using Web Workers
  // This is a performance-optimized version that decrypts chunks in parallel
  async downloadZKFileStreaming(
    fileId: string,
    fileName: string,
    metadata: FileMetadata,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<DownloadResult> {
    console.log('[Download] Starting ZK file download with streaming decryption:', fileName);

    // 1. Check if ZK session is unlocked
    if (!zkEncryptionService.isZKSessionUnlocked()) {
      throw new Error('ZK session is locked. Please unlock to download encrypted files.');
    }

    try {
      // 2. Decrypt file key with master key
      console.log('[Download] Decrypting file key...');
      const fileKey = zkEncryptionService.prepareFileForDecryption(
        metadata.encrypted_file_key!,
        metadata.file_key_iv!
      );

      // 3. Determine number of chunks
      const chunkSize = metadata.chunk_size || 32 * 1024 * 1024; // 32MB default
      const totalChunks = Math.ceil((metadata.file_size || 0) / chunkSize);
      console.log(`[Download] File has ${totalChunks} chunks - using parallel decryption`);

      // 4. Initialize worker pool
      const workerPool = getWorkerPool();
      await workerPool.init();

      // 5. Download and decrypt chunks in parallel (streaming approach)
      const decryptedChunks: Uint8Array[] = new Array(totalChunks); // Preallocate array
      const PARALLEL_DOWNLOADS = Math.min(3, totalChunks); // Download 3 chunks at a time

      let downloadedCount = 0;
      let decryptedCount = 0;

      // Helper function to download and decrypt a single chunk
      const downloadAndDecryptChunk = async (chunkIndex: number): Promise<void> => {
        // Download phase
        if (onProgress) {
          onProgress({
            currentStage: 'downloading',
            currentChunk: chunkIndex + 1,
            totalChunks,
            downloadProgress: ((downloadedCount + 1) / totalChunks) * 100,
            decryptProgress: (decryptedCount / totalChunks) * 100,
            bytesDownloaded: downloadedCount * chunkSize,
            totalBytes: metadata.file_size,
            isZK: true,
            streaming: true,
            workersActive: workerPool.getStats().activeJobs,
          });
        }

        // Download encrypted chunk from ZK service (useZKService = true)
        const encryptedChunk = await this._downloadChunkWithRetry(fileId, chunkIndex, 0, 3, true);
        downloadedCount++;
        console.log(`[Download] Downloaded chunk ${chunkIndex}: ${encryptedChunk.byteLength} bytes`);

        // Decrypt phase (using worker pool)
        if (onProgress) {
          onProgress({
            currentStage: 'decrypting',
            currentChunk: chunkIndex + 1,
            totalChunks,
            downloadProgress: (downloadedCount / totalChunks) * 100,
            decryptProgress: ((decryptedCount + 1) / totalChunks) * 100,
            bytesDownloaded: downloadedCount * chunkSize,
            totalBytes: metadata.file_size,
            chunksDecrypted: decryptedCount + 1,
            isZK: true,
            streaming: true,
            workersActive: workerPool.getStats().activeJobs,
          });
        }

        // Decrypt using worker pool (this happens in parallel across workers)
        const result = await workerPool.decryptChunk(new Uint8Array(encryptedChunk), fileKey, chunkIndex);

        decryptedCount++;
        console.log(
          `[Download] Decrypted chunk ${chunkIndex}: ${result.decryptedChunk.length} bytes (Worker pool: ${JSON.stringify(workerPool.getStats())})`
        );

        // Store in the correct position
        decryptedChunks[chunkIndex] = result.decryptedChunk;
      };

      // Process chunks in batches with parallel downloads/decryptions
      for (let i = 0; i < totalChunks; i += PARALLEL_DOWNLOADS) {
        const batchPromises: Promise<void>[] = [];

        for (let j = 0; j < PARALLEL_DOWNLOADS && i + j < totalChunks; j++) {
          const chunkIndex = i + j;
          batchPromises.push(
            downloadAndDecryptChunk(chunkIndex).catch((error) => {
              // Handle corruption errors
              const errorMessage = (error as Error).message;
              if (
                errorMessage &&
                (errorMessage.includes('authentication') ||
                  errorMessage.includes('corrupted') ||
                  errorMessage.includes('tag mismatch') ||
                  errorMessage.includes('Decryption failed'))
              ) {
                throw new Error(
                  `File corruption detected in chunk ${chunkIndex}. The file may have been tampered with or corrupted during storage. ` +
                    `Please try re-uploading the file or contact support if this persists.`
                );
              }
              throw error;
            })
          );
        }

        // Wait for batch to complete
        await Promise.all(batchPromises);
      }

      // 6. Assemble decrypted chunks into Blob
      console.log('[Download] Assembling decrypted chunks...');
      const blob = new Blob(decryptedChunks as BlobPart[], {
        type: (metadata as Record<string, unknown>).mime_type as string || 'application/octet-stream',
      });

      // 7. Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try {
          document.body.removeChild(a);
        } catch (_) {
          /* ignore */
        }
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* ignore */
        }
      }, 10000);

      console.log('[Download] ZK file downloaded and decrypted successfully with streaming!');

      // Final progress update
      if (onProgress) {
        onProgress({
          currentStage: 'completed',
          currentChunk: totalChunks,
          totalChunks,
          downloadProgress: 100,
          decryptProgress: 100,
          bytesDownloaded: metadata.file_size,
          totalBytes: metadata.file_size,
          chunksDecrypted: totalChunks,
          isZK: true,
          streaming: true,
        });
      }

      return { success: true, fileName, size: metadata.file_size || 0 };
    } catch (error) {
      console.error('[Download] ZK streaming download failed:', error);
      throw new Error(`ZK download failed: ${(error as Error).message}`);
    }
  }

  async uploadFile(
    _token: string,
    file: File,
    folderId: string | null | undefined,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<Record<string, unknown>> {
    // Validate file
    if (!validateFileType(file)) {
      throw new Error('File type not allowed');
    }
    if (!validateFileSize(file)) {
      throw new Error('File size exceeds limit (20GB)');
    }

    try {
      // Initialize upload
      await rateLimiter.checkLimit();
      const params = new URLSearchParams({
        file_name: file.name,
        file_size: file.size.toString(),
        ...(folderId && { folder_id: folderId }),
      });

      const initResponse = await fetch(`${API_URL}/api/v1/upload/init?${params}`, {
        method: 'POST',
        credentials: 'include', // Send HTTP-only cookie
      });

      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        throw new Error(`Failed to initialize upload: ${errorText}`);
      }

      const initData = await initResponse.json();
      const { upload_id, storage_strategy, chunk_size, total_chunks, direct_upload } = initData;

      console.log('Upload initialized:', {
        upload_id,
        storage_strategy,
        chunk_size,
        total_chunks,
        direct_upload,
      });

      const controller = new AbortController();

      // Handle based on storage strategy
      if (direct_upload || storage_strategy === 'inline' || storage_strategy === 'single') {
        // For inline and single strategies, use direct upload
        console.log('Using direct upload for', storage_strategy, 'strategy');

        const formData = new FormData();
        formData.append('file', file);

        await rateLimiter.checkLimit();
        const directResponse = await fetch(`${API_URL}/api/v1/upload/direct/${upload_id}`, {
          method: 'POST',
          credentials: 'include', // Send HTTP-only cookie
          body: formData,
          signal: controller.signal,
        });

        if (!directResponse.ok) {
          const errorText = await directResponse.text();

          // Parse error response for better user feedback
          let errorMessage = `Direct upload failed: ${errorText}`;
          let retryAfter: string | null = null;

          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.detail) {
              errorMessage = errorJson.detail;
            }
          } catch (e) {
            // Not JSON, use text as-is
          }

          // Extract Retry-After header for 429 errors
          if (directResponse.status === 429) {
            retryAfter = directResponse.headers.get('Retry-After');
            if (retryAfter) {
              errorMessage = `${errorMessage} (Retry in ${retryAfter}s)`;
            }
          }

          const error = new Error(errorMessage) as Error & { status?: number; retryAfter?: string | null };
          error.status = directResponse.status;
          error.retryAfter = retryAfter;
          throw error;
        }

        // Report progress for direct upload
        if (onProgress) {
          onProgress({
            uploadId: upload_id,
            progress: 50, // Show 50% after upload
            chunksUploaded: 0,
            totalChunks: 0,
          });
        }
      } else if (storage_strategy === 'chunked' && total_chunks > 0) {
        // For chunked strategy, upload chunks
        console.log(`Using chunked upload with ${total_chunks} chunks`);

        const uploadedChunks: number[] = [];
        for (let i = 0; i < total_chunks; i++) {
          const start = i * chunk_size;
          const end = Math.min(start + chunk_size, file.size);
          const chunk = file.slice(start, end);

          const formData = new FormData();
          formData.append('chunk', chunk);

          await rateLimiter.checkLimit();
          const response = await fetch(`${API_URL}/api/v1/upload/chunk/${upload_id}?chunk_index=${i}`, {
            method: 'POST',
            credentials: 'include', // Send HTTP-only cookie
            body: formData,
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Chunk ${i} upload failed: ${errorText}`);
          }

          uploadedChunks.push(i);

          // Report progress
          if (onProgress) {
            onProgress({
              uploadId: upload_id,
              progress: (uploadedChunks.length / total_chunks) * 100,
              chunksUploaded: uploadedChunks.length,
              totalChunks: total_chunks,
            });
          }
        }
      }

      // Complete upload (for all strategies)
      console.log('Completing upload...');
      await rateLimiter.checkLimit();

      const completeResponse = await fetch(`${API_URL}/api/v1/upload/complete/${upload_id}`, {
        method: 'POST',
        credentials: 'include', // Send HTTP-only cookie
      });

      if (!completeResponse.ok) {
        const errorText = await completeResponse.text();
        throw new Error(`Failed to complete upload: ${errorText}`);
      }

      const result = await completeResponse.json();

      // Check if upload is incomplete (missing chunks)
      if (result.status === 'incomplete' && result.missing_chunks) {
        throw new Error(`Upload incomplete. Missing chunks: ${result.missing_chunks.join(', ')}`);
      }

      // Report completion
      if (onProgress) {
        onProgress({
          uploadId: upload_id,
          progress: 100,
          chunksUploaded: total_chunks || 0,
          totalChunks: total_chunks || 0,
        });
      }

      console.log('Upload completed successfully:', result);

      return {
        uploadId: upload_id,
        status: 'completed',
        controller,
        fileId: result.file_id,
        fileName: result.file_name,
        fileSize: result.file_size,
        storageType: result.storage_type,
      };
    } catch (error) {
      console.error('Upload error:', error);
      throw error;
    }
  }

  async deleteFile(_token: string, fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to delete file');
    return await response.json();
  }

  async renameFile(_token: string, fileId: string, newName: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: sanitizeInput(newName) }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to rename file');
    }
    return await response.json();
  }

  async createFolder(_token: string, name: string, parentId?: string | null): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: sanitizeInput(name), parent_id: parentId }),
    });
    if (!response.ok) throw new Error('Failed to create folder');
    return await response.json();
  }

  async createShareLink(
    _token: string,
    fileId: string,
    options: { expiresHours?: number; password?: string | null; maxDownloads?: number | null } = {}
  ): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expires_hours: options.expiresHours || 24,
        password: options.password || null,
        max_downloads: options.maxDownloads || null,
      }),
    });
    if (!response.ok) throw new Error('Failed to create share link');
    return await response.json();
  }

  async getStorageStats(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/storage/stats`, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load storage stats');
    return await response.json();
  }

  async getActivityLogs(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/activity`, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load activity logs');
    return await response.json();
  }

  async getFilePreview(_token: string, fileId: string): Promise<Blob> {
    await rateLimiter.checkLimit();
    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/preview`, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to get preview');
    return await response.blob();
  }

  // Fixed deduplication methods
  async getDedupAnalytics(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/dedup/analytics`, {
      method: 'GET',
      credentials: 'include', // Send HTTP-only cookie
    });

    if (!response.ok) {
      console.error(
        'Failed to load dedup analytics:',
        response.status,
        'URL:',
        `${API_URL}/api/v1/dedup/analytics`
      );
      throw new Error('Failed to load deduplication analytics');
    }

    return await response.json();
  }

  async getDedupSavings(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    // Add timeout to prevent hanging on large dedup calculations
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await fetch(`${API_URL}/api/v1/dedup/savings`, {
        method: 'GET',
        credentials: 'include', // Send HTTP-only cookie
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(
          'Failed to load dedup savings:',
          response.status,
          'URL:',
          `${API_URL}/api/v1/dedup/savings`
        );
        throw new Error('Failed to load deduplication savings');
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Deduplication calculation timed out. Try again later.');
      }
      throw error;
    }
  }

  async optimizeFileDedup(_token: string, fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    if (!fileId) {
      console.error('No fileId provided for optimization');
      throw new Error('File ID required');
    }

    const response = await fetch(`${API_URL}/api/v1/dedup/optimize/${fileId}`, {
      method: 'POST',
      credentials: 'include', // Send HTTP-only cookie
    });

    if (!response.ok) {
      console.error('Failed to optimize file:', response.status, 'FileId:', fileId);
      throw new Error('Failed to optimize file');
    }

    return await response.json();
  }

  async runGarbageCollection(_token: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/dedup/gc`, {
      method: 'POST',
      credentials: 'include', // Send HTTP-only cookie
    });

    if (!response.ok) {
      console.error('Failed to run GC:', response.status);
      throw new Error('Failed to run garbage collection');
    }

    return await response.json();
  }

  // Recents - Get recently accessed files
  async getRecentFiles(days: number = 30): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/recents?days=${days}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // If endpoint doesn't exist yet, return mock data for frontend development
      console.warn('Recents endpoint not available, using mock data');
      return this.getMockRecentFiles();
    }

    return await response.json();
  }

  // Favorites - Get favorited files
  async getFavorites(): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/favorites`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // If endpoint doesn't exist yet, return empty array
      console.warn('Favorites endpoint not available, using mock data');
      return [];
    }

    return await response.json();
  }

  // Toggle favorite status of a file
  async toggleFavorite(fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/favorite`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to toggle favorite');
    }

    return await response.json();
  }

  // Shared with me - Get files shared by others
  async getSharedWithMe(): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/shared-with-me`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // If endpoint doesn't exist yet, return empty array
      console.warn('Shared with me endpoint not available yet');
      return [];
    }

    return await response.json();
  }

  // Remove a file/folder from "Shared with me" (removes access, not the original file)
  async removeSharedAccess(shareAccessId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/shared-with-me/${shareAccessId}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to remove shared access');
    }

    return await response.json();
  }

  // Get activity history for a specific file
  async getFileActivity(fileId: string, limit: number = 50): Promise<unknown> {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/api/v1/files/${fileId}/activity?limit=${limit}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn('File activity endpoint not available yet');
      return [];
    }

    return await response.json();
  }

  // Trash/Bin functionality
  async getTrash(): Promise<unknown[]> {
    await rateLimiter.checkLimit();

    // Check if ZK mode is active - use proper ZK service functions
    const zkEnabled = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
    const zkSessionUnlocked = zkEncryptionService.isZKSessionUnlocked();
    const useZKService = zkEnabled && zkSessionUnlocked;

    // Use ZK service URL for ZK users, otherwise use normal storage service
    const baseUrl = useZKService ? ZK_SERVICE_URL : API_URL;
    // ZK service uses /files endpoint with is_deleted query param (if supported)
    // Otherwise fallback to normal trash endpoint
    const endpoint = useZKService
      ? `${baseUrl}/api/v1/zk/files?is_deleted=true&limit=1000`
      : `${baseUrl}/api/v1/files/trash`;

    const response = await fetch(endpoint, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch trash');
    }

    const data = await response.json();

    // ZK service returns { files: [...], total_files: ..., total_size: ... }
    // Normal storage service returns array directly
    // Normalize to always return an array
    if (useZKService && (data as Record<string, unknown>).files) {
      // Decrypt ZK file names for display
      const files = (data as Record<string, unknown>).files as FileMetadata[];
      const decryptedFiles = files.map((file) => {
        try {
          // Decrypt filename if encrypted
          if (file.encrypted_file_key && file.file_key_iv) {
            const decryptedName = zkEncryptionService.decryptFilename(
              (file as Record<string, unknown>).encrypted_file_name as string,
              (file as Record<string, unknown>).file_name_iv as string
            );
            return {
              ...file,
              id: file.file_id || file.id,
              name: decryptedName,
              size: file.file_size,
              mimeType: (file as Record<string, unknown>).mime_type,
              uploadedAt: (file as Record<string, unknown>).uploaded_at,
              // Keep encrypted fields for operations
              encrypted_file_name: (file as Record<string, unknown>).encrypted_file_name,
              file_name_iv: (file as Record<string, unknown>).file_name_iv,
              encrypted_file_key: file.encrypted_file_key,
              file_key_iv: file.file_key_iv,
              is_encrypted: true,
            };
          }
          return file;
        } catch (error) {
          console.error('[Trash] Failed to decrypt filename:', error);
          return {
            ...file,
            id: file.file_id || file.id,
            name: '[Encrypted File]',
            size: file.file_size || 0,
            mimeType: (file as Record<string, unknown>).mime_type || 'application/octet-stream',
          };
        }
      });
      return decryptedFiles;
    }

    // If it's already an array (normal service), return as-is
    if (Array.isArray(data)) {
      return data;
    }

    // Fallback: return empty array if format is unexpected
    console.warn('Unexpected trash response format:', data);
    return [];
  }

  async restoreFromTrash(fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    // Check if ZK mode is active - use proper ZK service functions
    const zkEnabled = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
    const zkSessionUnlocked = zkEncryptionService.isZKSessionUnlocked();
    const useZKService = zkEnabled && zkSessionUnlocked;

    // Use ZK service URL for ZK users, otherwise use normal storage service
    const baseUrl = useZKService ? ZK_SERVICE_URL : API_URL;
    // ZK service has dedicated restore endpoint
    const endpoint = useZKService
      ? `${baseUrl}/api/v1/zk/files/${fileId}/restore`
      : `${baseUrl}/api/v1/files/trash/${fileId}/restore`;

    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error as Record<string, string>).detail || 'Failed to restore file');
    }

    return await response.json();
  }

  async permanentDelete(fileId: string): Promise<unknown> {
    await rateLimiter.checkLimit();

    // Check if ZK mode is active - use proper ZK service functions
    const zkEnabled = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
    const zkSessionUnlocked = zkEncryptionService.isZKSessionUnlocked();
    const useZKService = zkEnabled && zkSessionUnlocked;

    // Use ZK service URL for ZK users, otherwise use normal storage service
    const baseUrl = useZKService ? ZK_SERVICE_URL : API_URL;
    // ZK service uses delete endpoint with permanent query param
    const endpoint = useZKService
      ? `${baseUrl}/api/v1/zk/files/${fileId}?permanent=true`
      : `${baseUrl}/api/v1/files/trash/${fileId}/permanent`;

    const response = await fetch(endpoint, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error as Record<string, string>).detail || 'Failed to permanently delete file');
    }

    return await response.json();
  }

  async emptyTrash(): Promise<unknown> {
    await rateLimiter.checkLimit();

    // Check if ZK mode is active - use proper ZK service functions
    const zkEnabled = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';
    const zkSessionUnlocked = zkEncryptionService.isZKSessionUnlocked();
    const useZKService = zkEnabled && zkSessionUnlocked;

    // Use ZK service URL for ZK users, otherwise use normal storage service
    const baseUrl = useZKService ? ZK_SERVICE_URL : API_URL;
    // ZK service might not have empty-trash endpoint, so we'll use the normal one
    // If it fails, we can implement client-side loop through trash and delete each
    const endpoint = useZKService
      ? `${baseUrl}/api/v1/zk/files/empty-trash` // This might not exist, will need backend support
      : `${baseUrl}/api/v1/files/trash/empty`;

    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error as Record<string, string>).detail || 'Failed to empty trash');
    }

    return await response.json();
  }

  // Mock data for development (until backend endpoints are ready)
  getMockRecentFiles(): unknown[] {
    const now = new Date();
    const mockFiles: unknown[] = [];

    for (let i = 0; i < 20; i++) {
      const daysAgo = Math.floor(Math.random() * 30);
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);

      mockFiles.push({
        id: `mock-${i}`,
        name: `Document_${i + 1}.pdf`,
        size: Math.floor(Math.random() * 10000000),
        mime_type: 'application/pdf',
        created_at: date.toISOString(),
        last_accessed: date.toISOString(),
        tier: ['hot', 'warm', 'cold'][Math.floor(Math.random() * 3)],
      });
    }

    return mockFiles;
  }
}

export const storageService = new StorageService();
