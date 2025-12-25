/**
 * BufferManager - Sliding window buffer management for MSE playback
 *
 * Manages the SourceBuffer to:
 * - Keep a window of buffered content around current playback position
 * - Remove old data to prevent memory issues
 * - Handle QuotaExceededError by aggressive cleanup
 */

import { isIOSSafari, isSafari } from './AppendQueue';

/**
 * Get platform-specific buffer configuration
 */
function getBufferConfig() {
  if (isIOSSafari()) {
    return {
      bufferAhead: 15,    // Buffer 15 seconds ahead on iOS
      bufferBehind: 10,   // Keep 10 seconds behind on iOS
      minBuffer: 5,       // Minimum buffer before fetching more
      maxTotalBuffer: 30, // Max total buffer size
    };
  } else if (isSafari()) {
    return {
      bufferAhead: 30,
      bufferBehind: 20,
      minBuffer: 10,
      maxTotalBuffer: 60,
    };
  }
  // Chrome, Firefox, etc.
  return {
    bufferAhead: 30,
    bufferBehind: 30,
    minBuffer: 10,
    maxTotalBuffer: 120,
  };
}

export class BufferManager {
  /**
   * @param {SourceBuffer} sourceBuffer
   * @param {Object} options
   */
  constructor(sourceBuffer, options = {}) {
    this.sourceBuffer = sourceBuffer;
    const config = getBufferConfig();

    this.bufferAhead = options.bufferAhead ?? config.bufferAhead;
    this.bufferBehind = options.bufferBehind ?? config.bufferBehind;
    this.minBuffer = options.minBuffer ?? config.minBuffer;
    this.maxTotalBuffer = options.maxTotalBuffer ?? config.maxTotalBuffer;
  }

  /**
   * Get current buffer health metrics
   * @param {number} currentTime - Current playback time in seconds
   * @returns {{ bufferedAhead: number, bufferedBehind: number, totalBuffered: number, needsMore: boolean, ranges: Array }}
   */
  getBufferHealth(currentTime) {
    const buffered = this.sourceBuffer.buffered;
    let bufferedAhead = 0;
    let bufferedBehind = 0;
    let totalBuffered = 0;
    const ranges = [];

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      const rangeLength = end - start;
      totalBuffered += rangeLength;

      ranges.push({ start, end });

      // Check if current time is within this range
      if (currentTime >= start && currentTime <= end) {
        bufferedAhead = end - currentTime;
        bufferedBehind = currentTime - start;
      } else if (end <= currentTime) {
        // This range is entirely behind
        bufferedBehind = Math.max(bufferedBehind, currentTime - start);
      } else if (start > currentTime) {
        // This range is ahead (gap before it)
        // Don't count as bufferedAhead since there's a gap
      }
    }

    const needsMore = bufferedAhead < this.minBuffer;

    return {
      bufferedAhead,
      bufferedBehind,
      totalBuffered,
      needsMore,
      ranges,
    };
  }

  /**
   * Check if we need to fetch more data
   * @param {number} currentTime
   * @returns {boolean}
   */
  needsMoreData(currentTime) {
    const health = this.getBufferHealth(currentTime);
    return health.needsMore;
  }

  /**
   * Get the end of the currently buffered range containing currentTime
   * @param {number} currentTime
   * @returns {number} End time of buffered range, or currentTime if not buffered
   */
  getBufferedEnd(currentTime) {
    const buffered = this.sourceBuffer.buffered;

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);

      if (currentTime >= start - 0.5 && currentTime <= end) {
        return end;
      }
    }

    return currentTime;
  }

  /**
   * Remove data outside the sliding window
   * @param {number} currentTime
   * @returns {Promise<void>}
   */
  async cleanup(currentTime) {
    const buffered = this.sourceBuffer.buffered;
    const removeStart = currentTime - this.bufferBehind;

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);

      // Remove data that's too far behind
      if (end < removeStart) {
        await this._removeRange(start, end);
      } else if (start < removeStart) {
        // Partial removal - keep data near current time
        await this._removeRange(start, removeStart);
      }
    }
  }

  /**
   * Handle QuotaExceededError by aggressive cleanup
   * @param {number} currentTime
   * @returns {Promise<boolean>} True if space was freed
   */
  async handleQuotaExceeded(currentTime) {
    console.warn('[BufferManager] QuotaExceededError - performing aggressive cleanup');

    const buffered = this.sourceBuffer.buffered;
    let freedSpace = false;

    // Reduce buffer behind to just 5 seconds
    const aggressiveRemoveStart = currentTime - 5;

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);

      if (end < aggressiveRemoveStart) {
        await this._removeRange(start, end);
        freedSpace = true;
      } else if (start < aggressiveRemoveStart && currentTime > start) {
        await this._removeRange(start, aggressiveRemoveStart);
        freedSpace = true;
      }
    }

    // If still not enough, reduce bufferAhead and bufferBehind
    if (!freedSpace) {
      this.bufferAhead = Math.max(10, this.bufferAhead / 2);
      this.bufferBehind = Math.max(5, this.bufferBehind / 2);
      console.log(`[BufferManager] Reduced buffer targets: ahead=${this.bufferAhead}s, behind=${this.bufferBehind}s`);
    }

    return freedSpace;
  }

  /**
   * Remove a time range from the SourceBuffer
   * @param {number} start
   * @param {number} end
   * @returns {Promise<void>}
   */
  async _removeRange(start, end) {
    if (start >= end) return;

    // Wait if updating
    if (this.sourceBuffer.updating) {
      await this._waitForUpdateEnd();
    }

    return new Promise((resolve, reject) => {
      try {
        this.sourceBuffer.remove(start, end);

        const onUpdateEnd = () => {
          this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          this.sourceBuffer.removeEventListener('error', onError);
          resolve();
        };

        const onError = (event) => {
          this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          this.sourceBuffer.removeEventListener('error', onError);
          reject(new Error('Failed to remove buffer range'));
        };

        this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
        this.sourceBuffer.addEventListener('error', onError);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Wait for updateend event
   */
  _waitForUpdateEnd() {
    return new Promise((resolve) => {
      if (!this.sourceBuffer.updating) {
        resolve();
        return;
      }

      const onUpdateEnd = () => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        resolve();
      };

      this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
    });
  }

  /**
   * Clear all buffered data
   * @returns {Promise<void>}
   */
  async clear() {
    const buffered = this.sourceBuffer.buffered;

    for (let i = 0; i < buffered.length; i++) {
      await this._removeRange(buffered.start(i), buffered.end(i));
    }
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    const buffered = this.sourceBuffer.buffered;
    const ranges = [];

    for (let i = 0; i < buffered.length; i++) {
      ranges.push({
        start: buffered.start(i),
        end: buffered.end(i),
        duration: buffered.end(i) - buffered.start(i),
      });
    }

    return {
      bufferAhead: this.bufferAhead,
      bufferBehind: this.bufferBehind,
      ranges,
      rangeCount: buffered.length,
    };
  }
}

export default BufferManager;
