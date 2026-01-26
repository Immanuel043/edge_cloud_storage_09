/**
 * Hook-related Type Definitions
 */

import type { FileObject } from './file.types';

// File response types (extend existing FileObject)
export interface FileResponse extends FileObject {
  favorited_at?: string;
  last_accessed?: string;
}

// Upload progress types
export interface UploadProgress {
  uploadId?: string;
  progress: number;
  bytesUploaded: number;
  totalBytes: number;
  chunksUploaded?: number;
  totalChunks?: number;
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'paused';
  error?: string;
}

// Resumable upload checkpoint
export interface UploadCheckpoint {
  uploadId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  folderId?: string | null;
  strategy: 'inline' | 'single' | 'chunked';
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  bytesUploaded: number;
  savedAt: number;
  error?: string;
}

// Resumable upload options (extends zkUploadService/normalUploadService UploadOptions)
export interface ResumableUploadOptions {
  uploadId?: string | null;
  folderId?: string | null;
  concurrency?: number;
  onProgress?: (progress: UploadProgress) => void;
  onChunkComplete?: (chunkIndex: number, completed: number, total: number) => void;
  onError?: (error: Error) => void;
}

// Upload complete response (from zkUploadService/normalUploadService)
export interface UploadCompleteResponse {
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type?: string;
  created_at?: string;
}

// Keyboard shortcuts
export type KeyboardShortcutHandler = (event: KeyboardEvent) => void;
export type KeyboardShortcuts = Record<string, KeyboardShortcutHandler>;

// Secure video player metadata
export interface SecureVideoMetadata {
  encrypted_file_key: string;
  file_key_iv: string;
  file_size: number;
  chunk_size?: number; // Optional, defaults to 1MB if not provided
}

// Secure video player state
export interface SecureVideoState {
  isReady: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  isLocked: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  bufferedRanges: [number, number][] | TimeRanges | Array<{ start: number; end: number }>;
  error: { code: string; message: string } | null;
}

// Media stats from SecureMediaController
export interface MediaStats {
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

// Toggle favorite response
export interface ToggleFavoriteResponse {
  favorited: boolean;
  message: string;
}
