import { API_URL, CHUNK_SIZE } from '../config/constants';
import { sanitizeInput, validateFileType, validateFileSize } from '../utils/security';
import { rateLimiter } from '../utils/rateLimiter';

// Threshold (bytes) above which we prefer native browser download instead of buffering in JS.
// Set to 200 MB by default (adjust to taste).
//const MEMORY_BUFFER_THRESHOLD = 200 * 1024 * 1024;
const MEMORY_BUFFER_THRESHOLD = 50 * 1024 * 1024;


class ResumableDownloadManager {
  constructor() {
    this.downloads = new Map(); // fileId -> { chunks: [], totalBytes, totalSize, startTime }
    this.downloadProgress = new Map();
  }

  async downloadFile(token, fileId, fileName, options = {}) {
    const {
      onProgress = null,
      resumeFrom = 0,
      maxRetries = 3,
      bufferThreshold = MEMORY_BUFFER_THRESHOLD
    } = options;

    try {
      // HEAD to get metadata
      const headResp = await fetch(`${API_URL}/files/${fileId}/download`, {
        method: 'HEAD',
        // include cookies/session; if you also use token-based auth keep it but cookies are primary for production
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!headResp.ok) {
        throw new Error(`Failed to get file info: ${headResp.status}`);
      }

      const totalSize = parseInt(headResp.headers.get('content-length') || '0', 10);
      const acceptRanges = (headResp.headers.get('accept-ranges') || '').toLowerCase() === 'bytes';
      const contentType = headResp.headers.get('content-type') || 'application/octet-stream';

      // If very large file, prefer native download (browser handles resume natively)
      if (totalSize > bufferThreshold) {
        console.log(`File is large (${(totalSize / (1024*1024)).toFixed(1)} MB) — using native download to avoid buffering in JS.`);
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
        const info = this.downloads.get(fileId);
        info.totalSize = totalSize;
      }

      const downloadInfo = this.downloads.get(fileId);

      // If server supports ranges and we have a resume point > 0, use range requests.
      if (acceptRanges && startByte > 0 && startByte < totalSize) {
        await this.downloadRange(token, fileId, startByte, totalSize - 1, downloadInfo, onProgress, maxRetries);
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
  async downloadRange(token, fileId, start, end, downloadInfo, onProgress, maxRetries = 3) {
    const url = `${API_URL}/files/${fileId}/download`;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      attempt += 1;
      try {
        const headers = {
          Range: `bytes=${start}-${end}`,
        };
        if (token) headers.Authorization = `Bearer ${token}`;

        const resp = await fetch(url, {
          method: 'GET',
          headers,
          credentials: 'include',
        });

        // Accept 206 (partial) or 200 (server responded with full content)
        if (resp.status !== 206 && resp.status !== 200) {
          throw new Error(`Range request failed with status ${resp.status}`);
        }

        // ensure we have reader or fallback to blob
        await this.processResponse(resp, downloadInfo, onProgress);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`Range download attempt ${attempt} failed: ${e.message}`);
        // small backoff
        await new Promise(r => setTimeout(r, attempt * 300));
      }
    }

    throw lastError || new Error('Range download failed');
  }

  async downloadFull(token, fileId, downloadInfo, onProgress, maxRetries = 3) {
    const url = `${API_URL}/files/${fileId}/download`;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      attempt += 1;
      try {
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const resp = await fetch(url, { method: 'GET', headers, credentials: 'include' });
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        await this.processResponse(resp, downloadInfo, onProgress);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`Full download attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, attempt * 300));
      }
    }

    throw lastError || new Error('Full download failed');
  }

  // Processes a fetch Response: preferred streaming via body reader; fallback to blob()
  async processResponse(response, downloadInfo, onProgress) {
    // Ensure totalSize known (some HEAD responses may have set it)
    if (!downloadInfo.totalSize) {
      const tl = response.headers.get('content-length');
      downloadInfo.totalSize = tl ? parseInt(tl, 10) : downloadInfo.totalSize || 0;
    }

    // If response.body is not available (some environments), fallback to blob()
    if (!response.body || typeof response.body.getReader !== 'function') {
      const blob = await response.blob();
      downloadInfo.chunks.push(blob);
      downloadInfo.totalBytes += blob.size || (blob.byteLength || 0);
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
        if (onProgress && (Date.now() - lastProgressUpdate > 100)) {
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
      try { reader.releaseLock(); } catch (_) { /* ignore */ }
    }
  }

  // Save resumable info to localStorage
  saveProgress(fileId, downloadInfo) {
    try {
      localStorage.setItem(`download_progress_${fileId}`, JSON.stringify({
        fileId,
        totalBytes: downloadInfo.totalBytes,
        totalSize: downloadInfo.totalSize,
        timestamp: Date.now()
      }));
    } catch (e) {
      console.warn('Failed to save download progress', e);
    }
  }

  getProgress(fileId) {
    try {
      const saved = localStorage.getItem(`download_progress_${fileId}`);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  }

  clearProgress(fileId) {
    try { localStorage.removeItem(`download_progress_${fileId}`); } catch (_) {}
  }

  triggerDownload(blobOrUint8s, fileName) {
    // If the accumulated parts are Uint8Arrays, Blob() will handle arrays of them.
    const blob = (blobOrUint8s instanceof Blob) ? blobOrUint8s : new Blob(blobOrUint8s);
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = fileName || '';
    document.body.appendChild(a);
    a.click();
    // cleanup
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (_) {}
      try { window.URL.revokeObjectURL(url); } catch (_) {}
    }, 1500);
  }

  // Native anchor fallback (preferred for very large files)
  async nativeDownload(token, fileId, fileName) {
    const url = `${API_URL}/files/${fileId}/download`;
    
    try {
        // Fetch with authentication to get the file
        const response = await fetch(url, {
            method: 'GET',
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            credentials: 'include'
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

  formatBytes(bytes, decimals = 2) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
  }
}


class StorageService {
  constructor() {
    this.downloadManager = new ResumableDownloadManager();
  }

  async getFiles(token, folderId = null) {
    await rateLimiter.checkLimit();
    const url = `${API_URL}/files${folderId ? `?folder_id=${folderId}` : ''}`;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { headers, credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load files');
    return await response.json();
  }

  async getFolders(token, parentId = null) {
    await rateLimiter.checkLimit();
    const url = `${API_URL}/folders${parentId ? `?parent_id=${parentId}` : ''}`;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { headers, credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load folders');
    return await response.json();
  }

  // Resumable download with progress and fallback
  async downloadFile(token, fileId, fileName) {
    await rateLimiter.checkLimit();

    try {
      // Check saved progress and prompt to resume if within last 24h
      let resumeFrom = 0;
      const progress = this.downloadManager.getProgress(fileId);
      if (progress && (Date.now() - progress.timestamp) < 24 * 60 * 60 * 1000) {
        const pct = progress.totalSize ? ((progress.totalBytes / progress.totalSize) * 100).toFixed(1) : null;
        const shouldResume = window.confirm(`Resume previous download? ${pct ? `${pct}% complete` : ''}`);
        if (shouldResume) resumeFrom = progress.totalBytes;
        else this.downloadManager.clearProgress(fileId);
      }

      return await this.downloadManager.downloadFile(token, fileId, fileName, {
        resumeFrom,
        onProgress: (prog) => {
          // bubble progress to UI
          window.dispatchEvent(new CustomEvent('downloadProgress', { detail: { fileId, fileName, ...prog } }));
        }
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
  async simpleDownload(token, fileId, fileName) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(`${API_URL}/files/${fileId}/download`, {
      headers,
      credentials: 'include'
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
      try { document.body.removeChild(a); } catch (_) {}
      try { window.URL.revokeObjectURL(url); } catch (_) {}
    }, 10000);
    return { success: true, fileName };
  }

  async uploadFile(token, file, folderId, onProgress) {
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
      ...(folderId && { folder_id: folderId })
    });

    const initResponse = await fetch(`${API_URL}/upload/init?${params}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
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
      direct_upload
    });
    
    const controller = new AbortController();
    
    // Handle based on storage strategy
    if (direct_upload || storage_strategy === 'inline' || storage_strategy === 'single') {
      // For inline and single strategies, use direct upload
      console.log('Using direct upload for', storage_strategy, 'strategy');
      
      const formData = new FormData();
      formData.append('file', file);
      
      await rateLimiter.checkLimit();
      const directResponse = await fetch(`${API_URL}/upload/direct/${upload_id}`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}` 
        },
        body: formData,
        signal: controller.signal
      });
      
      if (!directResponse.ok) {
        const errorText = await directResponse.text();
        throw new Error(`Direct upload failed: ${errorText}`);
      }
      
      // Report progress for direct upload
      if (onProgress) {
        onProgress({
          uploadId: upload_id,
          progress: 50, // Show 50% after upload
          chunksUploaded: 0,
          totalChunks: 0
        });
      }
      
    } else if (storage_strategy === 'chunked' && total_chunks > 0) {
      // For chunked strategy, upload chunks
      console.log(`Using chunked upload with ${total_chunks} chunks`);
      
      const uploadedChunks = [];
      for (let i = 0; i < total_chunks; i++) {
        const start = i * chunk_size;
        const end = Math.min(start + chunk_size, file.size);
        const chunk = file.slice(start, end);
        
        const formData = new FormData();
        formData.append('chunk', chunk);
        
        await rateLimiter.checkLimit();
        const response = await fetch(`${API_URL}/upload/chunk/${upload_id}?chunk_index=${i}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData,
          signal: controller.signal
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
            totalChunks: total_chunks
          });
        }
      }
    }
    
    // Complete upload (for all strategies)
    console.log('Completing upload...');
    await rateLimiter.checkLimit();
    
    const completeResponse = await fetch(`${API_URL}/upload/complete/${upload_id}`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`
      }
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
        totalChunks: total_chunks || 0
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
      storageType: result.storage_type
    };
    
  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
}

  async deleteFile(token, fileId) {
    await rateLimiter.checkLimit();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(`${API_URL}/files/${fileId}`, {
      method: 'DELETE',
      headers,
      credentials: 'include'
    });
    if (!response.ok) throw new Error('Failed to delete file');
    return await response.json();
  }

  async createFolder(token, name, parentId) {
    await rateLimiter.checkLimit();
    const headers = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    const response = await fetch(`${API_URL}/folders`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ name: sanitizeInput(name), parent_id: parentId })
    });
    if (!response.ok) throw new Error('Failed to create folder');
    return await response.json();
  }

  async createShareLink(token, fileId, options = {}) {
    await rateLimiter.checkLimit();
    const headers = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    const response = await fetch(`${API_URL}/files/${fileId}/share`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        expires_hours: options.expiresHours || 24,
        password: options.password || null,
        max_downloads: options.maxDownloads || null
      })
    });
    if (!response.ok) throw new Error('Failed to create share link');
    return await response.json();
  }

  async getStorageStats(token) {
    await rateLimiter.checkLimit();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(`${API_URL}/storage/stats`, { headers, credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load storage stats');
    return await response.json();
  }

  async getActivityLogs(token) {
    await rateLimiter.checkLimit();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(`${API_URL}/activity`, { headers, credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load activity logs');
    return await response.json();
  }

  async getFilePreview(token, fileId) {
    await rateLimiter.checkLimit();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(`${API_URL}/files/${fileId}/preview`, { headers, credentials: 'include' });
    if (!response.ok) throw new Error('Failed to get preview');
    return await response.blob();
  }
}

export const storageService = new StorageService();