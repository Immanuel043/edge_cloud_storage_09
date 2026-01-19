/**
 * SeekController - Handle seeking with encrypted chunks
 *
 * Translates time positions to chunk indices and handles
 * buffer preparation for seamless seeking.
 */

import { timeToByteOffset, byteOffsetToChunkIndex } from './MP4Parser';
import type { MP4ParseResult } from './MP4Parser';
import type { ChunkManager } from './ChunkManager';
import type { BufferManager } from './BufferManager';
import type { AppendQueue } from './AppendQueue';

interface FileMetadata {
  file_size: number;
}

interface SeekControllerResult {
  actualTime: number;
  chunkIndex: number;
  byteOffset: number;
}

interface KeyframeResult {
  time: number;
  byteOffset: number;
  chunkIndex: number;
  sampleIndex: number;
}

interface SeekControllerStats {
  isSeeking: boolean;
  lastSeekTime: number;
  seekTableSize: number;
  duration: number;
}

export class SeekController {
  private moovData: MP4ParseResult;
  private chunkManager: ChunkManager;
  private chunkSize: number;
  private isSeeking: boolean;
  private lastSeekTime: number;

  constructor(
    moovData: MP4ParseResult,
    chunkManager: ChunkManager,
    bufferManager: BufferManager,
    chunkSize = 64 * 1024 * 1024
  ) {
    this.moovData = moovData;
    this.chunkManager = chunkManager;
    // bufferManager may be used in future for advanced buffer management
    void bufferManager;
    this.chunkSize = chunkSize;
    this.isSeeking = false;
    this.lastSeekTime = 0;
  }

  /**
   * Handle seek request
   */
  async seek(targetTime: number, sourceBuffer: SourceBuffer, appendQueue: AppendQueue): Promise<SeekControllerResult> {
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
   */
  findNearestKeyframe(targetTime: number): KeyframeResult {
    const seekTable = this.moovData?.seekTable || [];

    if (seekTable.length === 0) {
      // No seek table - estimate based on time
      const metadata = this.chunkManager.metadata as FileMetadata;
      const estimatedByte = Math.floor((targetTime / this.moovData.duration) * metadata.file_size);
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
   */
  getChunksForSeek(startTime: number, bufferDuration = 10): number[] {
    const startKeyframe = this.findNearestKeyframe(startTime);
    const endTime = startTime + bufferDuration;

    // Find end byte position (estimate if no seek table)
    let endByte: number;
    if (this.moovData?.seekTable?.length > 0) {
      const endResult = timeToByteOffset(endTime, this.moovData.seekTable);
      endByte = endResult.byteOffset;
    } else {
      // Estimate based on file size and duration
      const metadata = this.chunkManager.metadata as FileMetadata;
      endByte = Math.floor((endTime / this.moovData.duration) * metadata.file_size);
    }

    return this.chunkManager.getChunkIndicesForRange(startKeyframe.byteOffset, endByte);
  }

  /**
   * Prepare buffer for seek (clear if needed to avoid discontinuities)
   */
  async prepareBuffer(sourceBuffer: SourceBuffer, targetTime: number): Promise<void> {
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
  private async _removeRange(sourceBuffer: SourceBuffer, start: number, end: number): Promise<void> {
    if (start >= end) return;

    if (sourceBuffer.updating) {
      await this._waitForUpdateEnd(sourceBuffer);
    }

    return new Promise((resolve, reject) => {
      try {
        sourceBuffer.remove(start, end);

        const onUpdateEnd = (): void => {
          sourceBuffer.removeEventListener('updateend', onUpdateEnd);
          sourceBuffer.removeEventListener('error', onError);
          resolve();
        };

        const onError = (): void => {
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
  private _waitForUpdateEnd(sourceBuffer: SourceBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (!sourceBuffer.updating) {
        resolve();
        return;
      }

      const onUpdateEnd = (): void => {
        sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        resolve();
      };

      sourceBuffer.addEventListener('updateend', onUpdateEnd);
    });
  }

  /**
   * Check if a seek is currently in progress
   */
  isSeekInProgress(): boolean {
    return this.isSeeking;
  }

  /**
   * Cancel current seek
   */
  cancel(): void {
    this.isSeeking = false;
    this.chunkManager.abort();
  }

  /**
   * Get statistics
   */
  getStats(): SeekControllerStats {
    return {
      isSeeking: this.isSeeking,
      lastSeekTime: this.lastSeekTime,
      seekTableSize: this.moovData?.seekTable?.length || 0,
      duration: this.moovData?.duration || 0,
    };
  }
}

export default SeekController;
