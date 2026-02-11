/**
 * Resumable Upload Hook
 *
 * Features:
 * - Saves upload state to localStorage
 * - Automatically resumes on page reload
 * - Detects network failures
 * - Shows resume button in UI
 * - Supports both ZK (encrypted) and Normal upload modes
 *
 * Limitation: Resume only works within the same browser session because
 * the File object (required for re-uploading chunks) cannot be serialized
 * to localStorage. The checkpoint stores metadata only; the user must
 * re-select the same file to resume. Stale checkpoints older than 24 hours
 * are automatically cleared on hook initialization.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { zkUploadService } from '../services/zkUploadService';
import { normalUploadService } from '../services/normalUploadService';
import type {
  UploadProgress,
  UploadCheckpoint,
  ResumableUploadOptions,
  UploadCompleteResponse,
} from '../types/hooks.types';

// Extended options to support ZK mode selection
interface ExtendedResumableUploadOptions extends ResumableUploadOptions {
  zkEnabled?: boolean;
}

const STORAGE_KEY_PREFIX = 'resumable_upload_';
const STALE_CHECKPOINT_MS = 24 * 60 * 60 * 1000; // 24 hours

// Extended state type that includes file and folderId for checkpointing
interface UploadStateForCheckpoint {
  uploadId: string;
  file: File;
  folderId?: string | null;
  strategy: 'inline' | 'single' | 'chunked';
  chunkSize: number;
  totalChunks: number;
  uploadedChunks?: Set<number>;
  bytesUploaded: number;
  error?: string;
}

// Type guard for UploadCheckpoint
function isUploadCheckpoint(data: unknown): data is UploadCheckpoint {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Validate strategy with proper type narrowing (no unsafe cast)
  const strategy = obj.strategy;
  const isValidStrategy =
    typeof strategy === 'string' && (strategy === 'inline' || strategy === 'single' || strategy === 'chunked');

  return (
    typeof obj.uploadId === 'string' &&
    typeof obj.fileName === 'string' &&
    typeof obj.fileSize === 'number' &&
    typeof obj.fileType === 'string' &&
    isValidStrategy &&
    typeof obj.chunkSize === 'number' &&
    typeof obj.totalChunks === 'number' &&
    Array.isArray(obj.uploadedChunks) &&
    typeof obj.bytesUploaded === 'number' &&
    typeof obj.savedAt === 'number'
  );
}

export interface UseResumableUploadReturn {
  uploads: Record<string, UploadProgress>;
  resumableUploads: UploadCheckpoint[];
  uploadWithResume: (file: File, options?: ExtendedResumableUploadOptions) => Promise<UploadCompleteResponse>;
  resumeUpload: (checkpoint: UploadCheckpoint, file: File, options?: ExtendedResumableUploadOptions) => Promise<UploadCompleteResponse>;
  deleteResumable: (uploadId: string) => void;
  clearAllCheckpoints: () => void;
  loadResumableUploads: () => void;
}

export function useResumableUpload(): UseResumableUploadReturn {
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({});
  const [resumableUploads, setResumableUploads] = useState<UploadCheckpoint[]>([]);
  const checkpointTimers = useRef<Record<string, NodeJS.Timeout>>({});

  /**
   * Load saved uploads from localStorage.
   * Clears stale checkpoints (older than 24 hours) before loading.
   */
  const loadResumableUploads = useCallback((): void => {
    const saved: UploadCheckpoint[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_KEY_PREFIX)) {
        try {
          const item = localStorage.getItem(key);
          if (!item) continue;

          const data: unknown = JSON.parse(item);
          if (isUploadCheckpoint(data)) {
            if (Date.now() - data.savedAt < STALE_CHECKPOINT_MS) {
              saved.push(data);
            } else {
              // Clear stale checkpoint (older than 24 hours)
              localStorage.removeItem(key);
            }
          } else {
            // Invalid format, clean up
            console.warn('Invalid checkpoint format, removing:', key);
            localStorage.removeItem(key);
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error('Failed to parse saved upload:', error);
          localStorage.removeItem(key);
        }
      }
    }
    setResumableUploads(saved);
  }, []);

  // Load resumable uploads on mount (clears stale checkpoints)
  useEffect(() => {
    loadResumableUploads();
  }, [loadResumableUploads]);

  /**
   * Save checkpoint to localStorage
   */
  const saveCheckpoint = useCallback((uploadId: string, state: UploadStateForCheckpoint): void => {
    const checkpoint: UploadCheckpoint = {
      uploadId: state.uploadId,
      fileName: state.file.name,
      fileSize: state.file.size,
      fileType: state.file.type,
      folderId: state.folderId ?? null,
      strategy: state.strategy,
      chunkSize: state.chunkSize,
      totalChunks: state.totalChunks,
      uploadedChunks: Array.from(state.uploadedChunks || []),
      bytesUploaded: state.bytesUploaded,
      savedAt: Date.now(),
      ...(state.error !== undefined && { error: state.error }),
    };

    localStorage.setItem(`${STORAGE_KEY_PREFIX}${uploadId}`, JSON.stringify(checkpoint));
  }, []);

  /**
   * Clear checkpoint from localStorage
   */
  const clearCheckpoint = useCallback(
    (uploadId: string): void => {
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${uploadId}`);

      // Clear checkpoint timer
      const timer = checkpointTimers.current[uploadId];
      if (timer) {
        clearInterval(timer);
        delete checkpointTimers.current[uploadId];
      }

      // Remove from resumable list
      setResumableUploads((prev) => prev.filter((upload) => upload.uploadId !== uploadId));
    },
    []
  );


  /**
   * Upload file with automatic checkpointing
   * Supports both ZK (encrypted) and Normal upload modes via zkEnabled option
   */
  const uploadWithResume = useCallback(
    async (file: File, options: ExtendedResumableUploadOptions = {}): Promise<UploadCompleteResponse> => {
      const uploadId: string | null = options.uploadId || null;
      let uploadState: UploadStateForCheckpoint | null = null;

      // Select upload service based on mode
      const uploadService = options.zkEnabled ? zkUploadService : normalUploadService;
      const modeLabel = options.zkEnabled ? '[ZK]' : '[Normal]';

      console.log(`${modeLabel} Starting resumable upload:`, file.name);

      try {
        const result = await uploadService.uploadFile(file, {
          ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
          folderId: options.folderId ?? null,
          onProgress: (progressData) => {
            // Get upload context to extract additional info
            const currentUploadId: string = uploadId || file.name;
            const context = uploadService.getUploadStatus(currentUploadId);
            
            // Update local state
            const uploadProgress: UploadProgress = {
              uploadId: currentUploadId,
              progress: progressData.progress,
              bytesUploaded: progressData.bytesUploaded,
              totalBytes: progressData.totalBytes,
              status: 'uploading',
              ...(context && {
                chunksUploaded: context.uploadedChunks.size,
                totalChunks: context.totalChunks,
              }),
            };

            setUploads((prev) => ({
              ...prev,
              [currentUploadId]: uploadProgress,
            }));

            // Call user callback
            if (options.onProgress) {
              options.onProgress(uploadProgress);
            }
          },
          onChunkComplete: (chunkIndex: number, completed: number, total: number) => {
            // Get current upload state
            const currentUploadId: string = uploadId || file.name;
            const context = uploadService.getUploadStatus(currentUploadId);
            if (context) {
              uploadState = {
                uploadId: context.uploadId,
                file,
                folderId: options.folderId ?? null,
                strategy: context.strategy,
                chunkSize: context.chunkSize,
                totalChunks: context.totalChunks,
                uploadedChunks: context.uploadedChunks,
                bytesUploaded: context.bytesUploaded,
              };

              // Save checkpoint
              saveCheckpoint(currentUploadId, uploadState);
            }

            // Call user callback
            if (options.onChunkComplete) {
              options.onChunkComplete(chunkIndex, completed, total);
            }
          },
          onError: (error: Error) => {
            // Save checkpoint on error (allows resume)
            const currentUploadId: string = uploadId || file.name;
            const context = uploadService.getUploadStatus(currentUploadId);
            if (context) {
              uploadState = {
                uploadId: context.uploadId,
                file,
                folderId: options.folderId ?? null,
                strategy: context.strategy,
                chunkSize: context.chunkSize,
                totalChunks: context.totalChunks,
                uploadedChunks: context.uploadedChunks,
                bytesUploaded: context.bytesUploaded,
                error: error.message,
              };

              saveCheckpoint(currentUploadId, uploadState);
            }

            // Update UI
            setUploads((prev) => {
              const currentProgress = prev[currentUploadId];
              return {
                ...prev,
                [currentUploadId]: {
                  ...(currentProgress || {}),
                  uploadId: currentUploadId,
                  progress: currentProgress?.progress ?? 0,
                  bytesUploaded: currentProgress?.bytesUploaded ?? 0,
                  totalBytes: currentProgress?.totalBytes ?? file.size,
                  status: 'error',
                  error: error.message,
                },
              };
            });

            // Call user callback
            if (options.onError) {
              options.onError(error);
            }
          },
        });

        // Clear checkpoint on success
        const finalUploadId: string = uploadId || file.name;
        clearCheckpoint(finalUploadId);

        // Update UI
        setUploads((prev) => {
          const currentProgress = prev[finalUploadId];
          return {
            ...prev,
            [finalUploadId]: {
              ...(currentProgress || {}),
              uploadId: finalUploadId,
              status: 'completed',
              progress: 100,
              bytesUploaded: file.size,
              totalBytes: file.size,
            },
          };
        });

        return result;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`${modeLabel} Upload failed:`, error);
        throw error;
      }
    },
    [saveCheckpoint, clearCheckpoint]
  );

  /**
   * Resume a saved upload
   * Supports both ZK (encrypted) and Normal modes via zkEnabled option
   */
  const resumeUpload = useCallback(
    async (
      checkpoint: UploadCheckpoint,
      file: File,
      options: ExtendedResumableUploadOptions = {}
    ): Promise<UploadCompleteResponse> => {
      const modeLabel = options.zkEnabled ? '[ZK]' : '[Normal]';
      console.log(`${modeLabel} Resuming upload: ${checkpoint.fileName}`);

      // Initialize upload with existing upload ID
      return uploadWithResume(file, {
        ...options,
        uploadId: checkpoint.uploadId,
        folderId: checkpoint.folderId ?? null,
      });
    },
    [uploadWithResume]
  );

  /**
   * Delete a saved upload checkpoint
   */
  const deleteResumable = useCallback(
    (uploadId: string): void => {
      clearCheckpoint(uploadId);
    },
    [clearCheckpoint]
  );

  /**
   * Clear all checkpoints
   */
  const clearAllCheckpoints = useCallback((): void => {
    setResumableUploads((current) => {
      current.forEach((upload) => {
        clearCheckpoint(upload.uploadId);
      });
      return [];
    });
  }, [clearCheckpoint]);

  return {
    uploads,
    resumableUploads,
    uploadWithResume,
    resumeUpload,
    deleteResumable,
    clearAllCheckpoints,
    loadResumableUploads,
  };
}

export default useResumableUpload;
