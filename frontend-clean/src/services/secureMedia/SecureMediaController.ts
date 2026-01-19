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
import type { MP4ParseResult } from './MP4Parser';
import { AppendQueue, isSafari, isIOSSafari } from './AppendQueue';
import { BufferManager } from './BufferManager';
import { ChunkManager } from './ChunkManager';
import { SeekController } from './SeekController';
import { ZK_CONFIG } from '../../config/constants';

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
} as const;

export type MediaErrorCode = typeof MediaErrorCodes[keyof typeof MediaErrorCodes];

interface FileMetadata {
  encrypted_file_key: string;
  file_key_iv: string;
  file_size: number;
  chunk_size?: number;
}

interface MediaError {
  code: MediaErrorCode;
  message: string;
}

interface ProgressInfo {
  currentTime: number;
  duration: number;
  buffered: number;
  bufferedRanges?: Array<[number, number]>;
  downloadProgress?: number;
  isDownloading?: boolean;
}

interface ControllerOptions {
  onProgress?: (progress: ProgressInfo) => void;
  onError?: (error: MediaError) => void;
  onReady?: () => void;
  onBuffering?: (isBuffering: boolean) => void;
}

interface CodecChecks {
  hasMediaSource: boolean;
  mp4Basic: boolean;
  mp4H264: boolean;
  mp4H264High: boolean;
  mp4H264WithAudio: boolean;
  webmVP9: boolean;
}

interface ControllerStats {
  fileId: string | null;
  isReady: boolean;
  isLocked: boolean;
  isDestroyed: boolean;
  useBlobFallback: boolean;
  isFragmented: boolean | null;
  duration: number;
  codecs: string;
  currentTime: number;
  currentChunk: number;
  totalChunks: number;
  buffer: unknown;
  chunks: unknown;
}

export class SecureMediaController {
  // Configuration
  static HEADER_SIZE = 5 * 1024 * 1024; // 5MB for moov extraction
  static BUFFER_AHEAD = 30;              // Buffer 30 seconds ahead
  static BUFFER_BEHIND = 30;             // Keep 30 seconds behind

  // State
  private fileId: string | null;
  private metadata: FileMetadata | null;
  private videoElement: HTMLVideoElement | null;
  private mediaSource: MediaSource | null;
  private sourceBuffer: SourceBuffer | null;
  private moovData: MP4ParseResult | null;
  private isLocked: boolean;
  private isDestroyed: boolean;
  private isReady: boolean;
  private useBlobFallback: boolean;
  private blobUrl: string | null;
  private _preloadedData: Uint8Array | null;

  // Components
  private chunkManager: ChunkManager | null;
  private bufferManager: BufferManager | null;
  private appendQueue: AppendQueue | null;
  private seekController: SeekController | null;

  // Configuration
  private chunkSize: number;

  // Tracking
  private currentChunkIndex: number;
  private isFetching: boolean;
  private lastBufferCheck: number;

  // Callbacks
  private _onProgress: ((progress: ProgressInfo) => void) | null;
  private _onError: ((error: MediaError) => void) | null;
  private _onReady: (() => void) | null;
  private _onBuffering: ((isBuffering: boolean) => void) | null;

  // Bound event handlers
  private _boundTimeUpdate: () => void;
  private _boundSeeking: () => void;
  private _boundWaiting: () => void;
  private _boundError: () => void;

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
    this.useBlobFallback = false; // For non-fragmented MP4s
    this.blobUrl = null;
    this._preloadedData = null;

    // Components
    this.chunkManager = null;
    this.bufferManager = null;
    this.appendQueue = null;
    this.seekController = null;

    // Configuration
    this.chunkSize = ZK_CONFIG.ZK_CHUNK_SIZE || 64 * 1024 * 1024;

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
   */
  async init(
    fileId: string,
    videoElement: HTMLVideoElement,
    metadata: FileMetadata,
    options: ControllerOptions = {}
  ): Promise<boolean> {
    if (this.isDestroyed) {
      throw new Error('Controller has been destroyed');
    }

    // Check MSE support with detailed logging - use proper codec strings
    const codecChecks: CodecChecks = {
      hasMediaSource: !!window.MediaSource,
      // Check various codec combinations for better compatibility
      mp4Basic: window.MediaSource ? MediaSource.isTypeSupported('video/mp4') : false,
      mp4H264: window.MediaSource ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"') : false,
      mp4H264High: window.MediaSource ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001E"') : false,
      mp4H264WithAudio: window.MediaSource ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') : false,
      webmVP9: window.MediaSource ? MediaSource.isTypeSupported('video/webm; codecs="vp9"') : false,
    };

    console.log('[SecureMediaController] Checking MSE support...', codecChecks);

    if (!window.MediaSource) {
      this._emitError(
        MediaErrorCodes.MSE_NOT_SUPPORTED,
        'MediaSource Extensions not available. Please use Chrome, Firefox, or Edge for encrypted video playback.'
      );
      return false;
    }

    // Check if any MP4 codec is supported
    const mp4Supported = codecChecks.mp4Basic || codecChecks.mp4H264 || codecChecks.mp4H264High || codecChecks.mp4H264WithAudio;

    if (!mp4Supported) {
      // Check if in responsive/device emulation mode
      const isEmulatedDevice = window.navigator.userAgent.includes('Mobile') &&
                               window.navigator.platform.includes('Mac');

      const errorMsg = isEmulatedDevice
        ? 'MP4 codec not supported. If using Chrome DevTools device emulation, please disable it for video playback.'
        : 'MP4 video format not supported by your browser. Please try Chrome or Firefox in normal mode.';

      this._emitError(MediaErrorCodes.CODEC_NOT_SUPPORTED, errorMsg);
      return false;
    }

    this.fileId = fileId;
    this.videoElement = videoElement;
    this.metadata = metadata;
    // Only set callbacks from options if provided (don't overwrite if already set via methods)
    if (options.onProgress) this._onProgress = options.onProgress;
    if (options.onError) this._onError = options.onError;
    if (options.onReady) this._onReady = options.onReady;
    if (options.onBuffering) this._onBuffering = options.onBuffering;

    console.log(`[SecureMediaController] Initializing for file ${fileId}`, {
      hasMetadata: !!metadata,
      encrypted_file_key: metadata?.encrypted_file_key ? 'present' : 'missing',
      file_key_iv: metadata?.file_key_iv ? 'present' : 'missing',
      file_size: metadata?.file_size,
      chunk_size: metadata?.chunk_size,
    });

    try {
      // 1. Initialize ChunkManager
      console.log('[SecureMediaController] Step 1: Creating ChunkManager...');
      this.chunkManager = new ChunkManager(fileId, metadata, {
        cacheSize: 10,
        useWorkerPool: true,
      });
      await this.chunkManager.init();

      // Check if destroyed during async operation (React cleanup race condition)
      if (this.isDestroyed) {
        console.log('[SecureMediaController] Aborted: controller destroyed during ChunkManager init');
        return false;
      }
      console.log('[SecureMediaController] Step 1 complete: ChunkManager initialized');

      // 2. Extract and parse header
      console.log('[SecureMediaController] Step 2: Extracting header...');
      await this._extractHeader();

      // Check again after header extraction
      if (this.isDestroyed) {
        console.log('[SecureMediaController] Aborted: controller destroyed during header extraction');
        return false;
      }
      console.log('[SecureMediaController] Step 2 complete: Header extracted');

      // 3. Setup playback (MSE for fragmented MP4, blob for non-fragmented)
      if (this.useBlobFallback) {
        // Non-fragmented MP4: use blob-based playback
        console.log('[SecureMediaController] Step 3: Setting up blob playback (non-fragmented MP4)...');
        await this._setupBlobPlayback();

        if (this.isDestroyed) {
          console.log('[SecureMediaController] Aborted: controller destroyed during blob setup');
          return false;
        }
        console.log('[SecureMediaController] Step 3 complete: Blob playback ready');

        // 4. Attach basic event listeners for blob playback
        console.log('[SecureMediaController] Step 4: Attaching event listeners...');
        this._attachEventListeners();
        console.log('[SecureMediaController] Step 4 complete: Event listeners attached');

        // No need for MSE buffer management with blob playback
      } else {
        // Fragmented MP4: use MSE
        console.log('[SecureMediaController] Step 3: Setting up MSE...');
        await this._setupMSE();

        if (this.isDestroyed) {
          console.log('[SecureMediaController] Aborted: controller destroyed during MSE setup');
          return false;
        }
        console.log('[SecureMediaController] Step 3 complete: MSE setup');

        // 4. Attach event listeners
        console.log('[SecureMediaController] Step 4: Attaching event listeners...');
        this._attachEventListeners();
        console.log('[SecureMediaController] Step 4 complete: Event listeners attached');

        // 5. Start initial buffering
        console.log('[SecureMediaController] Step 5: Initial buffering...');
        await this._bufferInitial();

        if (this.isDestroyed) {
          console.log('[SecureMediaController] Aborted: controller destroyed during initial buffering');
          return false;
        }
        console.log('[SecureMediaController] Step 5 complete: Initial buffering done');
      }

      this.isReady = true;
      this._onReady?.();
      console.log('[SecureMediaController] Initialization complete - ready to play');

      return true;
    } catch (error) {
      // Don't emit error if controller was destroyed (expected during cleanup)
      if (this.isDestroyed) {
        console.log('[SecureMediaController] Init error after destroy (expected):', error instanceof Error ? error.message : String(error));
        return false;
      }
      console.error('[SecureMediaController] Initialization failed:', error);
      this._emitError(MediaErrorCodes.FETCH_FAILED, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Extract and parse MP4 header (first 5MB, or full file if moov is at end)
   */
  private async _extractHeader(): Promise<void> {
    console.log('[SecureMediaController] Extracting header...');

    if (!this.chunkManager) {
      throw new Error('ChunkManager not initialized');
    }

    // Calculate number of chunks needed for header
    const headerChunks = Math.ceil(SecureMediaController.HEADER_SIZE / this.chunkSize);
    console.log('[SecureMediaController] Fetching header chunks:', { headerChunks, chunkSize: this.chunkSize });

    // Fetch and decrypt header chunks
    let headerData = await this.chunkManager.getChunks(0, headerChunks);

    // Debug: Check if data looks like valid MP4
    const first8Bytes: number[] = [];
    for (let i = 0; i < Math.min(8, headerData.byteLength); i++) {
      const byte = headerData[i];
      if (byte !== undefined) {
        first8Bytes.push(byte);
      }
    }
    const first4CharsHex = first8Bytes.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const atomType = String.fromCharCode(...first8Bytes.slice(4, 8));

    console.log('[SecureMediaController] Header data analysis:', {
      totalBytes: headerData.byteLength,
      first8Bytes: first8Bytes,
      first4BytesHex: first4CharsHex,
      atomType: atomType,
      looksLikeMp4: ['ftyp', 'moov', 'mdat', 'free', 'skip'].includes(atomType),
    });

    // If it doesn't look like MP4, the decryption might have failed
    if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'pdin', 'wide'].includes(atomType)) {
      console.error('[SecureMediaController] Data does not look like valid MP4!');
      console.error('First 32 bytes:', Array.from(headerData.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      throw new Error('Decrypted data is not valid MP4. The file may be corrupted or decryption failed.');
    }

    // Parse MP4 header
    this.moovData = parseMP4(headerData.buffer as ArrayBuffer, this.chunkSize);

    // Handle moov atom at end of file (non-fast-start MP4)
    if (!this.moovData.codecs && this.chunkManager.totalChunks > headerChunks) {
      console.warn('[SecureMediaController] moov atom not found in header, checking end of file...');

      // Check if destroyed before making more requests (React cleanup race condition)
      if (this.isDestroyed || !this.chunkManager) {
        throw new Error('Controller destroyed during header extraction');
      }

      // Validate ChunkManager state and file key before long operation
      if (!this.chunkManager.fileKey || this.chunkManager.fileKey.length !== 32) {
        console.warn('[SecureMediaController] File key invalid before downloading all chunks, attempting to re-validate...');
        try {
          // Try to ensure file key is valid (will re-decrypt if needed)
          this.chunkManager._ensureFileKey();
        } catch (error) {
          throw new Error(
            `File key lost before downloading all chunks: ${error instanceof Error ? error.message : String(error)}. ` +
            'Please ensure your ZK session is unlocked and try again.'
          );
        }
      }

      // Download entire file to find moov (this is a fallback for non-optimized MP4s)
      const totalChunks = this.chunkManager.totalChunks;
      console.log(`[SecureMediaController] Downloading all ${totalChunks} chunks to find moov...`);

      headerData = await this.chunkManager.getChunks(0, totalChunks);

      // Check again after potentially long download (React cleanup race condition)
      if (this.isDestroyed) {
        console.log('[SecureMediaController] Aborted: controller destroyed during full file download for moov');
        throw new Error('Controller destroyed during moov search');
      }

      this.moovData = parseMP4(headerData.buffer as ArrayBuffer, this.chunkSize);

      if (!this.moovData.codecs) {
        throw new Error('Failed to parse video codecs. The moov atom could not be found.');
      }

      // Store full data for blob playback since we already downloaded it
      this._preloadedData = headerData;
      console.log('[SecureMediaController] Found moov at end of file, full data preloaded');
    }

    if (!this.moovData.codecs) {
      throw new Error('Failed to parse video codecs from header');
    }

    console.log('[SecureMediaController] Parsed header:', {
      codecs: this.moovData.codecs,
      duration: this.moovData.duration,
      seekTableSize: this.moovData.seekTable.length,
      isFragmented: this.moovData.isFragmented,
    });

    // Check if we need blob fallback for non-fragmented MP4
    if (!this.moovData.isFragmented) {
      console.log('[SecureMediaController] Non-fragmented MP4 detected, will use blob-based playback');
      this.useBlobFallback = true;
    }
  }

  /**
   * Setup MediaSource Extensions
   */
  private async _setupMSE(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[SecureMediaController] Setting up MSE...');

      if (!this.moovData || !this.videoElement) {
        reject(new Error('Missing moovData or videoElement'));
        return;
      }

      this.mediaSource = new MediaSource();

      // Handle sourceopen
      const onSourceOpen = (): void => {
        if (!this.mediaSource || !this.moovData || !this.chunkManager || !this.bufferManager) {
          reject(new Error('Required components not initialized'));
          return;
        }

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
      if (this.videoElement) {
        this.videoElement.src = URL.createObjectURL(this.mediaSource);
      }
    });
  }

  /**
   * Setup blob-based playback for non-fragmented MP4s
   * Downloads all chunks, decrypts, and creates blob URL
   */
  private async _setupBlobPlayback(): Promise<void> {
    console.log('[SecureMediaController] Setting up blob-based playback...');

    if (!this.chunkManager || !this.moovData || !this.videoElement) {
      throw new Error('Required components not initialized');
    }

    this._onBuffering?.(true);

    let blob: Blob;
    const mimeType = 'video/mp4';

    // Check if we already have preloaded data (from moov-at-end fallback)
    if (this._preloadedData) {
      console.log('[SecureMediaController] Using preloaded data for blob playback');
      blob = new Blob([this._preloadedData.buffer as ArrayBuffer], { type: mimeType });

      // Clear preloaded data to free memory
      this._preloadedData = null;
    } else {
      // Download all chunks
      const totalChunks = this.chunkManager.totalChunks;
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      console.log(`[SecureMediaController] Downloading ${totalChunks} chunks for blob playback...`);

      // Download and decrypt all chunks
      for (let i = 0; i < totalChunks; i++) {
        try {
          const chunk = await this.chunkManager.getChunk(i);
          chunks.push(chunk);
          totalBytes += chunk.length;

          // Report progress
          const progress = ((i + 1) / totalChunks) * 100;
          console.log(`[SecureMediaController] Downloaded chunk ${i + 1}/${totalChunks} (${progress.toFixed(1)}%)`);

          this._onProgress?.({
            currentTime: 0,
            duration: this.moovData.duration,
            buffered: progress,
            downloadProgress: progress,
            isDownloading: true,
          });
        } catch (error) {
          console.error(`[SecureMediaController] Failed to download chunk ${i}:`, error);
          throw new Error(`Failed to download chunk ${i}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      console.log(`[SecureMediaController] All chunks downloaded. Total: ${totalBytes} bytes`);

      // Memory optimization: Pass chunks array directly to Blob constructor
      // This avoids allocating an extra combined Uint8Array (saves ~50% memory)
      blob = new Blob(chunks.map(c => c.buffer as ArrayBuffer), { type: mimeType });

      // Clear chunks array to free memory sooner
      chunks.length = 0;
    }

    // Create blob URL
    this.blobUrl = URL.createObjectURL(blob);

    // Set video source
    this.videoElement.src = this.blobUrl;

    // Wait for video to be ready
    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = (): void => {
        if (!this.videoElement) return;
        this.videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
        this.videoElement.removeEventListener('error', onError);
        resolve();
      };

      const onError = (): void => {
        if (!this.videoElement) return;
        this.videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
        this.videoElement.removeEventListener('error', onError);
        reject(new Error('Failed to load video: ' + (this.videoElement.error?.message || 'Unknown error')));
      };

      if (this.videoElement) {
        this.videoElement.addEventListener('loadedmetadata', onLoadedMetadata);
        this.videoElement.addEventListener('error', onError);
      }
    });

    this._onBuffering?.(false);

    console.log('[SecureMediaController] Blob playback setup complete:', {
      blobUrl: this.blobUrl,
      duration: this.videoElement.duration,
      videoWidth: this.videoElement.videoWidth,
      videoHeight: this.videoElement.videoHeight,
    });
  }

  /**
   * Buffer initial data to start playback
   */
  private async _bufferInitial(): Promise<void> {
    console.log('[SecureMediaController] Initial buffering...');

    if (!this.chunkManager || !this.appendQueue) {
      throw new Error('Required components not initialized');
    }

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
  private _attachEventListeners(): void {
    if (!this.videoElement) return;

    this.videoElement.addEventListener('timeupdate', this._boundTimeUpdate);
    this.videoElement.addEventListener('seeking', this._boundSeeking);
    this.videoElement.addEventListener('waiting', this._boundWaiting);
    this.videoElement.addEventListener('error', this._boundError);
  }

  /**
   * Detach video element event listeners
   */
  private _detachEventListeners(): void {
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
  private async _onTimeUpdate(): Promise<void> {
    if (this.isLocked || this.isDestroyed || this.isFetching || !this.videoElement) return;

    const currentTime = this.videoElement.currentTime;

    // For blob-based playback, just emit progress (no buffer management needed)
    if (this.useBlobFallback) {
      this._onProgress?.({
        currentTime,
        duration: this.videoElement.duration || this.moovData?.duration || 0,
        buffered: 100, // Entire file is already loaded
        bufferedRanges: [[0, this.videoElement.duration || 0]],
      });
      return;
    }

    if (!this.bufferManager) return;

    // Throttle buffer checks
    const now = Date.now();
    if (now - this.lastBufferCheck < 500) return;
    this.lastBufferCheck = now;

    // Check buffer health
    const health = this.bufferManager.getBufferHealth(currentTime);

    // Emit progress
    this._onProgress?.({
      currentTime,
      duration: this.moovData?.duration || 0,
      buffered: health.bufferedAhead,
      bufferedRanges: health.ranges.map(r => [r.start, r.end] as [number, number]),
    });

    // Fetch more if needed
    if (health.needsMore && this.seekController && !this.seekController.isSeekInProgress()) {
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
  private async _fetchMore(currentTime: number): Promise<void> {
    if (this.isFetching || !this.bufferManager || !this.chunkManager || !this.appendQueue || !this.metadata || !this.moovData) return;

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
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
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
      if (this.chunkManager) {
        const totalChunks = this.chunkManager.totalChunks;
        const prefetchIndices = [startChunk + 1, startChunk + 2].filter(
          i => i < totalChunks
        );
        this.chunkManager.prefetch(prefetchIndices);
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        // Handle quota exceeded
        if (this.bufferManager && this.videoElement) {
          await this.bufferManager.handleQuotaExceeded(this.videoElement.currentTime);
        }
      } else {
        console.error('[SecureMediaController] Fetch error:', error);
        this._emitError(MediaErrorCodes.FETCH_FAILED, error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Handle seeking event
   */
  private async _onSeeking(): Promise<void> {
    if (this.isLocked || this.isDestroyed || !this.videoElement) return;

    const targetTime = this.videoElement.currentTime;
    console.log(`[SecureMediaController] Seeking to ${targetTime}s`);

    // For blob-based playback, seeking is handled natively by the browser
    if (this.useBlobFallback) {
      return;
    }

    if (!this.seekController || !this.sourceBuffer || !this.appendQueue) return;

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
      this._emitError(MediaErrorCodes.SEEK_FAILED, error instanceof Error ? error.message : String(error));
    } finally {
      this._onBuffering?.(false);
    }
  }

  /**
   * Handle waiting event (buffering)
   */
  private _onWaiting(): void {
    // For blob-based playback, entire file is loaded so waiting shouldn't happen
    if (this.useBlobFallback) {
      return;
    }

    this._onBuffering?.(true);

    // Try to fetch more data
    if (!this.isFetching && this.videoElement) {
      void this._fetchMore(this.videoElement.currentTime);
    }
  }

  /**
   * Handle media error
   */
  private _onMediaError(): void {
    if (!this.videoElement) return;

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
  private _emitError(code: MediaErrorCode, message: string): void {
    this._onError?.({ code, message });
  }

  /**
   * Play the video
   */
  async play(): Promise<void> {
    if (this.isLocked) {
      this._emitError(MediaErrorCodes.SESSION_LOCKED, 'Session is locked');
      return;
    }

    if (!this.videoElement) return;

    try {
      await this.videoElement.play();
    } catch (error) {
      console.error('[SecureMediaController] Play failed:', error);
    }
  }

  /**
   * Pause the video
   */
  pause(): void {
    this.videoElement?.pause();
  }

  /**
   * Seek to a specific time
   */
  seek(timeSeconds: number): void {
    if (this.videoElement) {
      this.videoElement.currentTime = timeSeconds;
    }
  }

  /**
   * Lock the session - clear all decrypted data
   * Called on session timeout or manual lock
   */
  lock(): void {
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

    // Clear all decrypted data - MUST set isDestroyed BEFORE clearing
    // to prevent race conditions where code checks isDestroyed, passes,
    // then finds fileKey is null
    if (this.chunkManager) {
      this.chunkManager.isDestroyed = true;
      this.chunkManager.clear();
    }
    this.appendQueue?.clear();

    // Zero out moov data and preloaded data
    if (this.moovData) {
      this.moovData = null;
    }
    if (this._preloadedData) {
      this._preloadedData = null;
    }

    // Revoke object URLs
    if (this.blobUrl) {
      try {
        URL.revokeObjectURL(this.blobUrl);
        this.blobUrl = null;
      } catch (e) {
        // Ignore
      }
    }

    if (this.mediaSource && this.videoElement?.src) {
      try {
        URL.revokeObjectURL(this.videoElement.src);
      } catch (e) {
        // Ignore
      }
    }

    console.log('[SecureMediaController] Session locked, all data cleared');
  }

  /**
   * Destroy the controller and cleanup all resources
   */
  async destroy(): Promise<void> {
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
  onProgress(callback: (progress: ProgressInfo) => void): void {
    this._onProgress = callback;
  }

  /**
   * Register error callback
   */
  onError(callback: (error: MediaError) => void): void {
    this._onError = callback;
  }

  /**
   * Register ready callback
   */
  onReady(callback: () => void): void {
    this._onReady = callback;
  }

  /**
   * Register buffering callback
   */
  onBuffering(callback: (isBuffering: boolean) => void): void {
    this._onBuffering = callback;
  }

  /**
   * Get current state and statistics
   */
  getStats(): ControllerStats {
    return {
      fileId: this.fileId,
      isReady: this.isReady,
      isLocked: this.isLocked,
      isDestroyed: this.isDestroyed,
      useBlobFallback: this.useBlobFallback,
      isFragmented: this.moovData?.isFragmented ?? null,
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
