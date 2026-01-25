/**
 * Normal Download Service - Standard File Downloads
 *
 * Features:
 * - Resumable downloads with progress tracking
 * - Range request support for partial downloads
 * - Native browser download for large files
 * - Automatic retry with exponential backoff
 * - Progress persistence to localStorage
 */

import { API_URL } from '../config/constants';

// Threshold (bytes) above which we prefer native browser download instead of buffering in JS.
// PERFORMANCE FIX: Lowered to 10MB to prevent crashes on mobile devices
const MEMORY_BUFFER_THRESHOLD = 10 * 1024 * 1024; // 10MB

// ==================== Type Definitions ====================

export interface DownloadOptions {
  onProgress?: ((progress: DownloadProgress) => void) | null;
  resumeFrom?: number;
  maxRetries?: number;
  bufferThreshold?: number;
}

export interface DownloadProgress {
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

export interface DownloadResult {
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

// ==================== Normal Download Service Class ====================

class NormalDownloadService {
  private downloads: Map<string, DownloadInfo>;
  private downloadProgress: Map<string, SavedProgress>;

  constructor() {
    this.downloads = new Map();
    this.downloadProgress = new Map();
  }

  /**
   * Download file with progress tracking and resume support
   */
  async downloadFile(
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
          `[Normal Download] File is large (${(totalSize / (1024 * 1024)).toFixed(
            1
          )} MB) — using native download to avoid buffering in JS.`
        );
        await this._nativeDownload(fileId, fileName);
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
        await this._downloadRange(fileId, startByte, totalSize - 1, downloadInfo, onProgress, maxRetries);
      } else if (acceptRanges && startByte === 0) {
        // we can also request range 0-end and still accept 206/200
        await this._downloadRange(fileId, 0, totalSize - 1, downloadInfo, onProgress, maxRetries);
      } else {
        await this._downloadFull(fileId, downloadInfo, onProgress, maxRetries);
      }

      // build blob and trigger download
      const blob = new Blob(downloadInfo.chunks, { type: contentType });
      this._triggerDownload(blob, fileName);

      // cleanup
      this.downloads.delete(fileId);
      this.downloadProgress.delete(fileId);
      this.clearProgress(fileId);

      const duration = (Date.now() - downloadInfo.startTime) / 1000;
      console.log(`[Normal Download] Complete: ${fileName} in ${duration.toFixed(1)}s`);
      return { success: true, fileName, size: totalSize, duration };
    } catch (err) {
      console.error('[Normal Download] Error:', err);

      // save resumable progress if any bytes downloaded
      const info = this.downloads.get(fileId);
      if (info && info.totalBytes > 0) {
        this._saveProgress(fileId, info);
      }

      throw err;
    }
  }

  /**
   * Attempt a range download with retries. Accept both 206 and 200 (server may return 200).
   */
  private async _downloadRange(
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
        await this._processResponse(resp, downloadInfo, onProgress);
        return;
      } catch (e) {
        lastError = e as Error;
        console.warn(`[Normal Download] Range download attempt ${attempt} failed: ${(e as Error).message}`);
        // small backoff
        await new Promise((r) => setTimeout(r, attempt * 300));
      }
    }

    throw lastError || new Error('Range download failed');
  }

  /**
   * Download full file with retries
   */
  private async _downloadFull(
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
        await this._processResponse(resp, downloadInfo, onProgress);
        return;
      } catch (e) {
        lastError = e as Error;
        console.warn(`[Normal Download] Full download attempt ${attempt} failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, attempt * 300));
      }
    }

    throw lastError || new Error('Full download failed');
  }

  /**
   * Processes a fetch Response: preferred streaming via body reader; fallback to blob()
   */
  private async _processResponse(
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

  /**
   * Save resumable info to localStorage
   */
  private _saveProgress(fileId: string, downloadInfo: DownloadInfo): void {
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
      console.warn('[Normal Download] Failed to save download progress', e);
    }
  }

  /**
   * Get saved progress from localStorage
   */
  getProgress(fileId: string): SavedProgress | null {
    try {
      const saved = localStorage.getItem(`download_progress_${fileId}`);
      return saved ? (JSON.parse(saved) as SavedProgress) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Clear saved progress from localStorage
   */
  clearProgress(fileId: string): void {
    try {
      localStorage.removeItem(`download_progress_${fileId}`);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Trigger browser download of blob
   */
  private _triggerDownload(blobOrUint8s: Blob | BlobPart[], fileName: string): void {
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

  /**
   * Native anchor fallback (preferred for very large files)
   */
  private async _nativeDownload(fileId: string, fileName: string): Promise<void> {
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
      a.download = fileName;
      document.body.appendChild(a);
      a.click();

      // Cleanup
      setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(blobUrl);
      }, 1500);
    } catch (error) {
      console.error('[Normal Download] Native download failed:', error);
      throw error;
    }
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
}

// Export singleton instance
const normalDownloadService = new NormalDownloadService();
export { normalDownloadService, NormalDownloadService };
export default normalDownloadService;
