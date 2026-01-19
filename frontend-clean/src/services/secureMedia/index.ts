/**
 * SecureMedia - ZK Encrypted Video Streaming Module
 *
 * Public exports for the secure media playback system.
 */

// Main controller
export { SecureMediaController, MediaErrorCodes } from './SecureMediaController';
export type { MediaErrorCode } from './SecureMediaController';

// Components
export { AppendQueue, isSafari, isIOSSafari, getRecommendedSliceSize } from './AppendQueue';
export { BufferManager } from './BufferManager';
export { ChunkManager } from './ChunkManager';
export { SeekController } from './SeekController';

// MP4 Parser utilities
export { parse as parseMP4, timeToByteOffset, byteOffsetToChunkIndex } from './MP4Parser';
export type { MP4ParseResult, SeekResult } from './MP4Parser';

// Default export
export { default } from './SecureMediaController';
