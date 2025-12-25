/**
 * SecureMediaController - Streaming playback of ZK-encrypted videos
 *
 * Main controller that orchestrates:
 * - MP4 header parsing for codec info and seek table
 * - MSE setup with Safari-safe handling
 * - Chunk fetching and decryption
 * - Buffer management with sliding window
 * - Seek handling
 * - Security (lock/clear on session timeout)
 */

import { parse as parseMP4 } from './MP4Parser';
import { AppendQueue, isSafari, isIOSSafari } from './AppendQueue';
import { BufferManager } from './BufferManager';
import { ChunkManager } from './ChunkManager';
import { SeekController } from './SeekController';
import { ZK_CHUNK_SIZE } from '../../config/constants';

/**
 * Error codes for media playback
 */
export const MediaErrorCodes = {
  // Network errors
  FETCH_FAILED: 'FETCH_FAILED',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',

  // Decryption errors
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  CORRUPTED_CHUNK: 'CORRUPTED_CHUNK',

  // MSE errors
  MSE_NOT_SUPPORTED: 'MSE_NOT_SUPPORTED',
  CODEC_NOT_SUPPORTED: 'CODEC_NOT_SUPPORTED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  APPEND_FAILED: 'APPEND_FAILED',

  // Playback errors
  MEDIA_DECODE_ERROR: 'MEDIA_DECODE_ERROR',
  SEEK_FAILED: 'SEEK_FAILED',

  // Security errors
  SESSION_LOCKED: 'SESSION_LOCKED',
  KEY_EXPIRED: 'KEY_EXPIRED',
};

export class SecureMediaController {
  // Configuration
  static HEADER_SIZE = 5 * 1024 * 1024; // 5MB for moov extraction
  static BUFFER_AHEAD = 30;              // Buffer 30 seconds ahead
  static BUFFER_BEHIND = 30;             // Keep 30 seconds behind

  constructor() {
    // State
    this.fileId = null;
    this.metadata = null;
    this.videoElement = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.moovData = null;
    this.isLocked = false;
    this.isDestroyed = false;
    this.isReady = false;

    // Components
    this.chunkManager = null;
    this.bufferManager = null;
    this.appendQueue = null;
    this.seekController = null;

    // Configuration
    this.chunkSize = ZK_CHUNK_SIZE || 64 * 1024 * 1024;

    // Tracking
    this.currentChunkIndex = 0;
    this.isFetching = false;
    this.lastBufferCheck = 0;

    // Callbacks
    this._onProgress = null;
    this._onError = null;
    this._onReady = null;
    this._onBuffering = null;

    // Bound event handlers
    this._boundTimeUpdate = this._onTimeUpdate.bind(this);
    this._boundSeeking = this._onSeeking.bind(this);
    this._boundWaiting = this._onWaiting.bind(this);
    this._boundError = this._onMediaError.bind(this);
  }

  /**
   * Initialize the controller for a specific file
   * @param {string} fileId - ZK file ID
   * @param {HTMLVideoElement} videoElement
   * @param {Object} metadata - File metadata with encrypted_file_key, file_key_iv, file_size
   * @param {Object} options - Callbacks and configuration
   */
  async init(fileId, videoElement, metadata, options = {}) {
    if (this.isDestroyed) {
      throw new Error('Controller has been destroyed');
    }

    // Check MSE support
    if (!window.MediaSource || !MediaSource.isTypeSupported('video/mp4')) {
      this._emitError(MediaErrorCodes.MSE_NOT_SUPPORTED, 'MediaSource Extensions not supported');
      return false;
    }

    this.fileId = fileId;
    this.videoElement = videoElement;
    this.metadata = metadata;
    this._onProgress = options.onProgress;
    this._onError = options.onError;
    this._onReady = options.onReady;
    this._onBuffering = options.onBuffering;

    console.log(`[SecureMediaController] Initializing for file ${fileId}`);

    try {
      // 1. Initialize ChunkManager
      this.chunkManager = new ChunkManager(fileId, metadata, {
        cacheSize: 10,
        useWorkerPool: true,
      });
      await this.chunkManager.init();

      // 2. Extract and parse header
      await this._extractHeader();

      // 3. Setup MSE
      await this._setupMSE();

      // 4. Attach event listeners
      this._attachEventListeners();

      // 5. Start initial buffering
      await this._bufferInitial();

      this.isReady = true;
      this._onReady?.();

      return true;
    } catch (error) {
      console.error('[SecureMediaController] Initialization failed:', error);
      this._emitError(MediaErrorCodes.FETCH_FAILED, error.message);
      return false;
    }
  }

  /**
   * Extract and parse MP4 header (first 5MB)
   */
  async _extractHeader() {
    console.log('[SecureMediaController] Extracting header...');

    // Calculate number of chunks needed for header
    const headerChunks = Math.ceil(SecureMediaController.HEADER_SIZE / this.chunkSize);

    // Fetch and decrypt header chunks
    const headerData = await this.chunkManager.getChunks(0, headerChunks);

    // Parse MP4 header
    this.moovData = parseMP4(headerData.buffer, this.chunkSize);

    if (!this.moovData.codecs) {
      throw new Error('Failed to parse video codecs from header');
    }

    console.log('[SecureMediaController] Parsed header:', {
      codecs: this.moovData.codecs,
      duration: this.moovData.duration,
      seekTableSize: this.moovData.seekTable.length,
    });
  }

  /**
   * Setup MediaSource Extensions
   */
  async _setupMSE() {
    return new Promise((resolve, reject) => {
      console.log('[SecureMediaController] Setting up MSE...');

      this.mediaSource = new MediaSource();

      // Handle sourceopen
      const onSourceOpen = () => {
        this.mediaSource.removeEventListener('sourceopen', onSourceOpen);

        try {
          // Create SourceBuffer with detected codecs
          const mimeType = `video/mp4; codecs="${this.moovData.codecs}"`;

          if (!MediaSource.isTypeSupported(mimeType)) {
            reject(new Error(`Codec not supported: ${mimeType}`));
            return;
          }

          this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

          // Safari-specific: set mode to 'sequence' for better handling
          if (isSafari()) {
            try {
              this.sourceBuffer.mode = 'segments';
            } catch (e) {
              // Ignore if not supported
            }
          }

          // Initialize components
          this.appendQueue = new AppendQueue(this.sourceBuffer);
          this.bufferManager = new BufferManager(this.sourceBuffer, {
            bufferAhead: isIOSSafari() ? 15 : 30,
            bufferBehind: isIOSSafari() ? 10 : 30,
          });
          this.seekController = new SeekController(
            this.moovData,
            this.chunkManager,
            this.bufferManager,
            this.chunkSize
          );

          console.log('[SecureMediaController] MSE setup complete');
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      this.mediaSource.addEventListener('sourceopen', onSourceOpen);

      // Set video source
      this.videoElement.src = URL.createObjectURL(this.mediaSource);
    });
  }

  /**
   * Buffer initial data to start playback
   */
  async _bufferInitial() {
    console.log('[SecureMediaController] Initial buffering...');

    this._onBuffering?.(true);

    // Append header data first (already fetched)
    const headerData = await this.chunkManager.getChunks(0, 1);
    await this.appendQueue.append(headerData);

    this.currentChunkIndex = 1;

    // Buffer a few more chunks
    const initialChunks = isIOSSafari() ? 2 : 3;

    for (let i = 1; i < initialChunks && i < this.chunkManager.totalChunks; i++) {
      const chunk = await this.chunkManager.getChunk(i);
      await this.appendQueue.append(chunk);
      this.currentChunkIndex = i + 1;
    }

    this._onBuffering?.(false);
    console.log('[SecureMediaController] Initial buffering complete');
  }

  /**
   * Attach video element event listeners
   */
  _attachEventListeners() {
    this.videoElement.addEventListener('timeupdate', this._boundTimeUpdate);
    this.videoElement.addEventListener('seeking', this._boundSeeking);
    this.videoElement.addEventListener('waiting', this._boundWaiting);
    this.videoElement.addEventListener('error', this._boundError);
  }

  /**
   * Detach video element event listeners
   */
  _detachEventListeners() {
    if (this.videoElement) {
      this.videoElement.removeEventListener('timeupdate', this._boundTimeUpdate);
      this.videoElement.removeEventListener('seeking', this._boundSeeking);
      this.videoElement.removeEventListener('waiting', this._boundWaiting);
      this.videoElement.removeEventListener('error', this._boundError);
    }
  }

  /**
   * Handle timeupdate event - check buffer and fetch more if needed
   */
  async _onTimeUpdate() {
    if (this.isLocked || this.isDestroyed || this.isFetching) return;

    const currentTime = this.videoElement.currentTime;

    // Throttle buffer checks
    const now = Date.now();
    if (now - this.lastBufferCheck < 500) return;
    this.lastBufferCheck = now;

    // Check buffer health
    const health = this.bufferManager.getBufferHealth(currentTime);

    // Emit progress
    this._onProgress?.({
      currentTime,
      duration: this.moovData.duration,
      buffered: health.bufferedAhead,
      bufferedRanges: health.ranges,
    });

    // Fetch more if needed
    if (health.needsMore && !this.seekController.isSeekInProgress()) {
      await this._fetchMore(currentTime);
    }

    // Cleanup old buffers
    if (health.bufferedBehind > this.bufferManager.bufferBehind + 10) {
      try {
        await this.bufferManager.cleanup(currentTime);
      } catch (error) {
        console.warn('[SecureMediaController] Buffer cleanup failed:', error);
      }
    }
  }

  /**
   * Fetch more chunks to fill buffer
   */
  async _fetchMore(currentTime) {
    if (this.isFetching) return;

    this.isFetching = true;

    try {
      // Calculate which chunk to fetch next
      const bufferedEnd = this.bufferManager.getBufferedEnd(currentTime);
      const nextByteOffset = bufferedEnd * (this.metadata.file_size / this.moovData.duration);
      const nextChunkIndex = Math.floor(nextByteOffset / this.chunkSize);

      // Don't re-fetch chunks we already have
      const startChunk = Math.max(nextChunkIndex, this.currentChunkIndex);

      if (startChunk >= this.chunkManager.totalChunks) {
        // We've fetched everything
        if (this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch (e) {
            // Ignore
          }
        }
        return;
      }

      // Fetch next chunk
      console.log(`[SecureMediaController] Fetching chunk ${startChunk}`);

      const chunk = await this.chunkManager.getChunk(startChunk);
      await this.appendQueue.append(chunk);

      this.currentChunkIndex = startChunk + 1;

      // Prefetch next chunks in background
      const prefetchIndices = [startChunk + 1, startChunk + 2].filter(
        i => i < this.chunkManager.totalChunks
      );
      this.chunkManager.prefetch(prefetchIndices);

    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        // Handle quota exceeded
        await this.bufferManager.handleQuotaExceeded(this.videoElement.currentTime);
      } else {
        console.error('[SecureMediaController] Fetch error:', error);
        this._emitError(MediaErrorCodes.FETCH_FAILED, error.message);
      }
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Handle seeking event
   */
  async _onSeeking() {
    if (this.isLocked || this.isDestroyed) return;

    const targetTime = this.videoElement.currentTime;
    console.log(`[SecureMediaController] Seeking to ${targetTime}s`);

    this._onBuffering?.(true);

    try {
      const result = await this.seekController.seek(
        targetTime,
        this.sourceBuffer,
        this.appendQueue
      );

      this.currentChunkIndex = result.chunkIndex + 1;

      console.log(`[SecureMediaController] Seek complete, actual time: ${result.actualTime}s`);
    } catch (error) {
      console.error('[SecureMediaController] Seek failed:', error);
      this._emitError(MediaErrorCodes.SEEK_FAILED, error.message);
    } finally {
      this._onBuffering?.(false);
    }
  }

  /**
   * Handle waiting event (buffering)
   */
  _onWaiting() {
    this._onBuffering?.(true);

    // Try to fetch more data
    if (!this.isFetching) {
      this._fetchMore(this.videoElement.currentTime);
    }
  }

  /**
   * Handle media error
   */
  _onMediaError(event) {
    const error = this.videoElement.error;
    console.error('[SecureMediaController] Media error:', error);

    this._emitError(
      MediaErrorCodes.MEDIA_DECODE_ERROR,
      error?.message || 'Unknown media error'
    );
  }

  /**
   * Emit error to callback
   */
  _emitError(code, message) {
    this._onError?.({ code, message });
  }

  /**
   * Play the video
   */
  async play() {
    if (this.isLocked) {
      this._emitError(MediaErrorCodes.SESSION_LOCKED, 'Session is locked');
      return;
    }

    try {
      await this.videoElement.play();
    } catch (error) {
      console.error('[SecureMediaController] Play failed:', error);
    }
  }

  /**
   * Pause the video
   */
  pause() {
    this.videoElement?.pause();
  }

  /**
   * Seek to a specific time
   * @param {number} timeSeconds
   */
  seek(timeSeconds) {
    if (this.videoElement) {
      this.videoElement.currentTime = timeSeconds;
    }
  }

  /**
   * Lock the session - clear all decrypted data
   * Called on session timeout or manual lock
   */
  lock() {
    if (this.isLocked) return;

    console.log('[SecureMediaController] Locking session...');
    this.isLocked = true;

    // Pause video
    this.videoElement?.pause();

    // Abort all fetches
    this.chunkManager?.abort();
    this.appendQueue?.abort();
    this.seekController?.cancel();

    // End media source
    if (this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch (e) {
        // Ignore
      }
    }

    // Clear video source
    if (this.videoElement) {
      this.videoElement.src = '';
      this.videoElement.load();
    }

    // Clear all decrypted data
    this.chunkManager?.clear();
    this.appendQueue?.clear();

    // Zero out moov data
    if (this.moovData) {
      this.moovData = null;
    }

    // Revoke object URLs
    if (this.mediaSource) {
      try {
        URL.revokeObjectURL(this.videoElement?.src);
      } catch (e) {
        // Ignore
      }
    }

    console.log('[SecureMediaController] Session locked, all data cleared');
  }

  /**
   * Destroy the controller and cleanup all resources
   */
  async destroy() {
    if (this.isDestroyed) return;

    console.log('[SecureMediaController] Destroying controller...');
    this.isDestroyed = true;

    // First lock to clear sensitive data
    this.lock();

    // Remove event listeners
    this._detachEventListeners();

    // Destroy components
    this.chunkManager?.destroy();

    // Clear references
    this.videoElement = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.chunkManager = null;
    this.bufferManager = null;
    this.appendQueue = null;
    this.seekController = null;

    console.log('[SecureMediaController] Controller destroyed');
  }

  /**
   * Register progress callback
   */
  onProgress(callback) {
    this._onProgress = callback;
  }

  /**
   * Register error callback
   */
  onError(callback) {
    this._onError = callback;
  }

  /**
   * Register ready callback
   */
  onReady(callback) {
    this._onReady = callback;
  }

  /**
   * Register buffering callback
   */
  onBuffering(callback) {
    this._onBuffering = callback;
  }

  /**
   * Get current state and statistics
   */
  getStats() {
    return {
      fileId: this.fileId,
      isReady: this.isReady,
      isLocked: this.isLocked,
      isDestroyed: this.isDestroyed,
      duration: this.moovData?.duration || 0,
      codecs: this.moovData?.codecs || '',
      currentTime: this.videoElement?.currentTime || 0,
      currentChunk: this.currentChunkIndex,
      totalChunks: this.chunkManager?.totalChunks || 0,
      buffer: this.bufferManager?.getStats() || null,
      chunks: this.chunkManager?.getStats() || null,
    };
  }
}

export default SecureMediaController;
