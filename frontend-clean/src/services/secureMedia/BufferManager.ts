/**
 * BufferManager - Sliding window buffer management for MSE playback
 *
 * Manages the SourceBuffer to:
 * - Keep a window of buffered content around current playback position
 * - Remove old data to prevent memory issues
 * - Handle QuotaExceededError by aggressive cleanup
 */

import { isIOSSafari, isSafari } from './AppendQueue';

interface BufferConfig {
  bufferAhead: number;
  bufferBehind: number;
  minBuffer: number;
  maxTotalBuffer: number;
}

interface BufferManagerOptions {
  bufferAhead?: number;
  bufferBehind?: number;
  minBuffer?: number;
  maxTotalBuffer?: number;
}

interface BufferRange {
  start: number;
  end: number;
}

interface BufferHealth {
  bufferedAhead: number;
  bufferedBehind: number;
  totalBuffered: number;
  needsMore: boolean;
  ranges: BufferRange[];
}

interface BufferRangeWithDuration extends BufferRange {
  duration: number;
}

interface BufferStats {
  bufferAhead: number;
  bufferBehind: number;
  ranges: BufferRangeWithDuration[];
  rangeCount: number;
}

/**
 * Get platform-specific buffer configuration
 */
function getBufferConfig(): BufferConfig {
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
  private sourceBuffer: SourceBuffer;
  private bufferAhead: number;
  public bufferBehind: number; // Made public for access from controllers
  private minBuffer: number;

  constructor(sourceBuffer: SourceBuffer, options: BufferManagerOptions = {}) {
    this.sourceBuffer = sourceBuffer;
    const config = getBufferConfig();

    this.bufferAhead = options.bufferAhead ?? config.bufferAhead;
    this.bufferBehind = options.bufferBehind ?? config.bufferBehind;
    this.minBuffer = options.minBuffer ?? config.minBuffer;
    // maxTotalBuffer may be used in future for quota management
    void (options.maxTotalBuffer ?? config.maxTotalBuffer);
  }

  /**
   * Get current buffer health metrics
   * @param currentTime - Current playback time in seconds
   * @returns Buffer health information
   */
  getBufferHealth(currentTime: number): BufferHealth {
    const buffered = this.sourceBuffer.buffered;
    let bufferedAhead = 0;
    let bufferedBehind = 0;
    let totalBuffered = 0;
    const ranges: BufferRange[] = [];

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
   * @param currentTime - Current playback position
   * @returns True if more data is needed
   */
  needsMoreData(currentTime: number): boolean {
    const health = this.getBufferHealth(currentTime);
    return health.needsMore;
  }

  /**
   * Get the end of the currently buffered range containing currentTime
   * @param currentTime - Current playback position
   * @returns End time of buffered range, or currentTime if not buffered
   */
  getBufferedEnd(currentTime: number): number {
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
   * @param currentTime - Current playback position
   */
  async cleanup(currentTime: number): Promise<void> {
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
   * @param currentTime - Current playback position
   * @returns True if space was freed
   */
  async handleQuotaExceeded(currentTime: number): Promise<boolean> {
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
   * @param start - Start time in seconds
   * @param end - End time in seconds
   */
  private async _removeRange(start: number, end: number): Promise<void> {
    if (start >= end) return;

    // Wait if updating
    if (this.sourceBuffer.updating) {
      await this._waitForUpdateEnd();
    }

    return new Promise((resolve, reject) => {
      try {
        this.sourceBuffer.remove(start, end);

        const onUpdateEnd = (): void => {
          this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          this.sourceBuffer.removeEventListener('error', onError);
          resolve();
        };

        const onError = (): void => {
          this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          this.sourceBuffer.removeEventListener('error', onError);
          reject(new Error('Failed to remove buffer range'));
        };

        this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
        this.sourceBuffer.addEventListener('error', onError);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Wait for updateend event
   */
  private _waitForUpdateEnd(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sourceBuffer.updating) {
        resolve();
        return;
      }

      const onUpdateEnd = (): void => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        resolve();
      };

      this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
    });
  }

  /**
   * Clear all buffered data
   */
  async clear(): Promise<void> {
    const buffered = this.sourceBuffer.buffered;

    for (let i = 0; i < buffered.length; i++) {
      await this._removeRange(buffered.start(i), buffered.end(i));
    }
  }

  /**
   * Get buffer statistics
   */
  getStats(): BufferStats {
    const buffered = this.sourceBuffer.buffered;
    const ranges: BufferRangeWithDuration[] = [];

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
