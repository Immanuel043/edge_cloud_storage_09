/**
 * SeekController - Handle seeking with encrypted chunks
 *
 * Translates time positions to chunk indices and handles
 * buffer preparation for seamless seeking.
 */

import { timeToByteOffset, byteOffsetToChunkIndex } from './MP4Parser';

export class SeekController {
  /**
   * @param {Object} moovData - Parsed moov data from MP4Parser
   * @param {ChunkManager} chunkManager
   * @param {BufferManager} bufferManager
   * @param {number} chunkSize - Encrypted chunk size in bytes
   */
  constructor(moovData, chunkManager, bufferManager, chunkSize = 64 * 1024 * 1024) {
    this.moovData = moovData;
    this.chunkManager = chunkManager;
    this.bufferManager = bufferManager;
    this.chunkSize = chunkSize;
    this.isSeeking = false;
    this.lastSeekTime = 0;
  }

  /**
   * Handle seek request
   * @param {number} targetTime - Target time in seconds
   * @param {SourceBuffer} sourceBuffer
   * @param {AppendQueue} appendQueue
   * @returns {Promise<{ actualTime: number, chunkIndex: number }>}
   */
  async seek(targetTime, sourceBuffer, appendQueue) {
    if (this.isSeeking) {
      console.log('[SeekController] Seek already in progress, aborting previous');
      this.chunkManager.abort();
    }

    this.isSeeking = true;
    this.lastSeekTime = targetTime;

    try {
      // Find nearest keyframe
      const keyframe = this.findNearestKeyframe(targetTime);

      console.log(`[SeekController] Seeking to ${targetTime}s, nearest keyframe at ${keyframe.time}s, chunk ${keyframe.chunkIndex}`);

      // Abort pending operations
      this.chunkManager.abort();
      appendQueue.abort();

      // Prepare buffer for seek (clear if needed)
      await this.prepareBuffer(sourceBuffer, keyframe.time);

      // Reset append queue
      appendQueue.reset();

      // Fetch the chunk containing the keyframe
      const decrypted = await this.chunkManager.getChunk(keyframe.chunkIndex);

      // Calculate offset within the chunk
      const offsetInChunk = keyframe.byteOffset % this.chunkSize;

      // If the keyframe is not at the start of chunk, we might need to include
      // data from the beginning of the chunk for proper decoding
      // For now, append the full chunk and let MSE handle it
      await appendQueue.append(decrypted);

      this.isSeeking = false;

      return {
        actualTime: keyframe.time,
        chunkIndex: keyframe.chunkIndex,
        byteOffset: keyframe.byteOffset,
      };
    } catch (error) {
      this.isSeeking = false;
      throw error;
    }
  }

  /**
   * Find nearest keyframe before or at target time
   * @param {number} targetTime - Target time in seconds
   * @returns {{ time: number, byteOffset: number, chunkIndex: number, sampleIndex: number }}
   */
  findNearestKeyframe(targetTime) {
    const seekTable = this.moovData?.seekTable || [];

    if (seekTable.length === 0) {
      // No seek table - estimate based on time
      const estimatedByte = Math.floor((targetTime / this.moovData.duration) * this.chunkManager.metadata.file_size);
      return {
        time: targetTime,
        byteOffset: Math.max(0, estimatedByte),
        chunkIndex: byteOffsetToChunkIndex(estimatedByte, this.chunkSize),
        sampleIndex: 0,
      };
    }

    // Use the MP4Parser's timeToByteOffset function
    const result = timeToByteOffset(targetTime, seekTable);

    return {
      time: result.time,
      byteOffset: result.byteOffset,
      chunkIndex: result.chunkIndex,
      sampleIndex: result.sampleIndex || 0,
    };
  }

  /**
   * Get chunks needed after a seek
   * @param {number} startTime
   * @param {number} bufferDuration - How much to buffer after seek
   * @returns {number[]} Array of chunk indices
   */
  getChunksForSeek(startTime, bufferDuration = 10) {
    const startKeyframe = this.findNearestKeyframe(startTime);
    const endTime = startTime + bufferDuration;

    // Find end byte position (estimate if no seek table)
    let endByte;
    if (this.moovData?.seekTable?.length > 0) {
      const endResult = timeToByteOffset(endTime, this.moovData.seekTable);
      endByte = endResult.byteOffset;
    } else {
      // Estimate based on file size and duration
      endByte = Math.floor((endTime / this.moovData.duration) * this.chunkManager.metadata.file_size);
    }

    return this.chunkManager.getChunkIndicesForRange(startKeyframe.byteOffset, endByte);
  }

  /**
   * Prepare buffer for seek (clear if needed to avoid discontinuities)
   * @param {SourceBuffer} sourceBuffer
   * @param {number} targetTime
   */
  async prepareBuffer(sourceBuffer, targetTime) {
    // Wait if SourceBuffer is updating
    if (sourceBuffer.updating) {
      await this._waitForUpdateEnd(sourceBuffer);
    }

    const buffered = sourceBuffer.buffered;

    // Check if target is within currently buffered range
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);

      if (targetTime >= start && targetTime <= end) {
        // Already buffered - no need to clear
        console.log(`[SeekController] Target ${targetTime}s is already buffered [${start}-${end}]`);
        return;
      }
    }

    // Target is not buffered - clear buffer to avoid discontinuities
    // MSE doesn't handle gaps well, especially in Safari
    console.log(`[SeekController] Clearing buffer for seek to ${targetTime}s`);

    for (let i = 0; i < buffered.length; i++) {
      await this._removeRange(sourceBuffer, buffered.start(i), buffered.end(i));
    }
  }

  /**
   * Remove a time range from SourceBuffer
   */
  async _removeRange(sourceBuffer, start, end) {
    if (start >= end) return;

    if (sourceBuffer.updating) {
      await this._waitForUpdateEnd(sourceBuffer);
    }

    return new Promise((resolve, reject) => {
      try {
        sourceBuffer.remove(start, end);

        const onUpdateEnd = () => {
          sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          sourceBuffer.removeEventListener('error', onError);
          resolve();
        };

        const onError = () => {
          sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          sourceBuffer.removeEventListener('error', onError);
          reject(new Error('Failed to remove buffer'));
        };

        sourceBuffer.addEventListener('updateend', onUpdateEnd);
        sourceBuffer.addEventListener('error', onError);
      } catch (error) {
        resolve(); // Ignore removal errors
      }
    });
  }

  /**
   * Wait for updateend
   */
  _waitForUpdateEnd(sourceBuffer) {
    return new Promise((resolve) => {
      if (!sourceBuffer.updating) {
        resolve();
        return;
      }

      const onUpdateEnd = () => {
        sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        resolve();
      };

      sourceBuffer.addEventListener('updateend', onUpdateEnd);
    });
  }

  /**
   * Check if a seek is currently in progress
   */
  isSeekInProgress() {
    return this.isSeeking;
  }

  /**
   * Cancel current seek
   */
  cancel() {
    this.isSeeking = false;
    this.chunkManager.abort();
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      isSeeking: this.isSeeking,
      lastSeekTime: this.lastSeekTime,
      seekTableSize: this.moovData?.seekTable?.length || 0,
      duration: this.moovData?.duration || 0,
    };
  }
}

export default SeekController;
