/**
 * AppendQueue - Safari-safe sequential SourceBuffer append handling
 *
 * Safari requires:
 * 1. Single SourceBuffer for muxed audio+video
 * 2. Wait for updateend before next append
 * 3. Smaller segment sizes (1MB max on iOS, 2MB on macOS)
 */

/**
 * Detect Safari browser
 */
export function isSafari() {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
}

/**
 * Detect iOS Safari
 */
export function isIOSSafari() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

/**
 * Get recommended slice size based on browser
 */
export function getRecommendedSliceSize() {
  if (isIOSSafari()) {
    return 512 * 1024; // 512KB for iOS
  } else if (isSafari()) {
    return 1024 * 1024; // 1MB for macOS Safari
  }
  return 2 * 1024 * 1024; // 2MB for Chrome/Firefox
}

export class AppendQueue {
  /**
   * @param {SourceBuffer} sourceBuffer
   * @param {Object} options
   * @param {number} options.sliceSize - Maximum append size per operation
   */
  constructor(sourceBuffer, options = {}) {
    this.sourceBuffer = sourceBuffer;
    this.sliceSize = options.sliceSize || getRecommendedSliceSize();
    this.queue = [];
    this.isProcessing = false;
    this.aborted = false;
    this.pendingPromises = [];
  }

  /**
   * Add data to append queue
   * @param {ArrayBuffer | Uint8Array} data
   * @returns {Promise<void>} Resolves when all data is appended
   */
  append(data) {
    return new Promise((resolve, reject) => {
      if (this.aborted) {
        reject(new Error('AppendQueue has been aborted'));
        return;
      }

      const buffer = data instanceof Uint8Array ? data.buffer : data;
      const segments = this._slice(buffer);

      // Add all segments to queue
      for (let i = 0; i < segments.length; i++) {
        const isLast = i === segments.length - 1;
        this.queue.push({
          data: segments[i],
          resolve: isLast ? resolve : null,
          reject: isLast ? reject : null,
        });
      }

      // Track pending promises for abort
      this.pendingPromises.push({ resolve, reject });

      // Start processing if not already
      this._processQueue();
    });
  }

  /**
   * Slice large buffer into smaller segments
   * @param {ArrayBuffer} buffer
   * @returns {ArrayBuffer[]}
   */
  _slice(buffer) {
    const segments = [];
    const totalSize = buffer.byteLength;

    if (totalSize <= this.sliceSize) {
      segments.push(buffer);
    } else {
      let offset = 0;
      while (offset < totalSize) {
        const end = Math.min(offset + this.sliceSize, totalSize);
        segments.push(buffer.slice(offset, end));
        offset = end;
      }
    }

    return segments;
  }

  /**
   * Process queue sequentially
   */
  async _processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0 && !this.aborted) {
      const item = this.queue.shift();

      try {
        // Wait if SourceBuffer is updating
        if (this.sourceBuffer.updating) {
          await this._waitForUpdateEnd();
        }

        // Check if we're aborted
        if (this.aborted) {
          if (item.reject) {
            item.reject(new Error('AppendQueue aborted'));
          }
          break;
        }

        // Append the data
        this.sourceBuffer.appendBuffer(item.data);

        // Wait for updateend
        await this._waitForUpdateEnd();

        // Resolve if this was the last segment of a batch
        if (item.resolve) {
          item.resolve();
        }
      } catch (error) {
        console.error('[AppendQueue] Append failed:', error);

        // Handle QuotaExceededError
        if (error.name === 'QuotaExceededError') {
          // Re-queue the item and let BufferManager handle cleanup
          this.queue.unshift(item);
          if (item.reject) {
            item.reject(error);
          }
          break;
        }

        if (item.reject) {
          item.reject(error);
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Wait for updateend event on SourceBuffer
   * @returns {Promise<void>}
   */
  _waitForUpdateEnd() {
    return new Promise((resolve, reject) => {
      if (!this.sourceBuffer.updating) {
        resolve();
        return;
      }

      const onUpdateEnd = () => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        this.sourceBuffer.removeEventListener('error', onError);
        resolve();
      };

      const onError = (event) => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        this.sourceBuffer.removeEventListener('error', onError);
        reject(new Error('SourceBuffer error during append'));
      };

      this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
      this.sourceBuffer.addEventListener('error', onError);
    });
  }

  /**
   * Abort all pending appends
   */
  abort() {
    this.aborted = true;
    this.queue = [];

    // Reject all pending promises
    for (const { reject } of this.pendingPromises) {
      if (reject) {
        reject(new Error('AppendQueue aborted'));
      }
    }
    this.pendingPromises = [];

    // Abort SourceBuffer if updating
    if (this.sourceBuffer.updating) {
      try {
        this.sourceBuffer.abort();
      } catch (e) {
        // Ignore errors during abort
      }
    }
  }

  /**
   * Clear the queue without aborting
   */
  clear() {
    this.queue = [];
  }

  /**
   * Reset the queue for reuse
   */
  reset() {
    this.queue = [];
    this.isProcessing = false;
    this.aborted = false;
    this.pendingPromises = [];
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      aborted: this.aborted,
      sliceSize: this.sliceSize,
    };
  }
}

export default AppendQueue;
