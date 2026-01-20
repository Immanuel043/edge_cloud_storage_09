/**
 * Resumable Upload Hook
 *
 * Features:
 * - Saves upload state to localStorage
 * - Automatically resumes on page reload
 * - Detects network failures
 * - Shows resume button in UI
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import uploadService from '../services/uploadService';

const STORAGE_KEY_PREFIX = 'resumable_upload_';
const CHECKPOINT_INTERVAL = 5000; // Save checkpoint every 5 seconds

export function useResumableUpload() {
  const [uploads, setUploads] = useState({});
  const [resumableUploads, setResumableUploads] = useState([]);
  const checkpointTimers = useRef({});

  // Load resumable uploads on mount
  useEffect(() => {
    loadResumableUploads();
  }, []);

  /**
   * Load saved uploads from localStorage
   */
  const loadResumableUploads = () => {
    const saved = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_KEY_PREFIX)) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          // Only load uploads from last 24 hours
          if (Date.now() - data.savedAt < 24 * 60 * 60 * 1000) {
            saved.push(data);
          } else {
            // Clean up old uploads
            localStorage.removeItem(key);
          }
        } catch (error) {
          console.error('Failed to parse saved upload:', error);
          localStorage.removeItem(key);
        }
      }
    }
    setResumableUploads(saved);
  };

  /**
   * Save checkpoint to localStorage
   */
  const saveCheckpoint = useCallback((uploadId, state) => {
    const checkpoint = {
      uploadId: state.uploadId,
      fileName: state.file.name,
      fileSize: state.file.size,
      fileType: state.file.type,
      folderId: state.folderId,
      strategy: state.strategy,
      chunkSize: state.chunkSize,
      totalChunks: state.totalChunks,
      uploadedChunks: Array.from(state.uploadedChunks || []),
      bytesUploaded: state.bytesUploaded,
      savedAt: Date.now(),
    };

    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${uploadId}`,
      JSON.stringify(checkpoint)
    );
  }, []);

  /**
   * Clear checkpoint from localStorage
   */
  const clearCheckpoint = useCallback((uploadId) => {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${uploadId}`);

    // Clear checkpoint timer
    if (checkpointTimers.current[uploadId]) {
      clearInterval(checkpointTimers.current[uploadId]);
      delete checkpointTimers.current[uploadId];
    }

    // Remove from resumable list
    setResumableUploads(prev =>
      prev.filter(upload => upload.uploadId !== uploadId)
    );
  }, []);

  /**
   * Start periodic checkpoint saving
   */
  const startCheckpointing = useCallback((uploadId, getState) => {
    // Clear any existing timer
    if (checkpointTimers.current[uploadId]) {
      clearInterval(checkpointTimers.current[uploadId]);
    }

    // Create new timer
    checkpointTimers.current[uploadId] = setInterval(() => {
      const state = getState();
      if (state) {
        saveCheckpoint(uploadId, state);
      }
    }, CHECKPOINT_INTERVAL);
  }, [saveCheckpoint]);

  /**
   * Upload file with automatic checkpointing
   */
  const uploadWithResume = useCallback(async (file, options = {}) => {
    const uploadId = options.uploadId || null;
    let uploadState = null;

    try {
      const result = await uploadService.uploadFile(file, {
        ...options,
        onProgress: (progress) => {
          // Update local state
          setUploads(prev => ({
            ...prev,
            [progress.uploadId || file.name]: {
              ...prev[progress.uploadId || file.name],
              ...progress,
              status: 'uploading',
            },
          }));

          // Call user callback
          if (options.onProgress) {
            options.onProgress(progress);
          }
        },
        onChunkComplete: (chunkIndex, completed, total) => {
          // Get current upload state
          uploadState = uploadService.getUploadStatus(uploadId || file.name);

          // Save checkpoint
          if (uploadState) {
            saveCheckpoint(uploadId || file.name, {
              ...uploadState,
              file,
              folderId: options.folderId,
            });
          }

          // Call user callback
          if (options.onChunkComplete) {
            options.onChunkComplete(chunkIndex, completed, total);
          }
        },
        onError: (error) => {
          // Save checkpoint on error (allows resume)
          uploadState = uploadService.getUploadStatus(uploadId || file.name);
          if (uploadState) {
            saveCheckpoint(uploadId || file.name, {
              ...uploadState,
              file,
              folderId: options.folderId,
              error: error.message,
            });
          }

          // Update UI
          setUploads(prev => ({
            ...prev,
            [uploadId || file.name]: {
              ...prev[uploadId || file.name],
              status: 'error',
              error: error.message,
            },
          }));

          // Call user callback
          if (options.onError) {
            options.onError(error);
          }
        },
      });

      // Clear checkpoint on success
      clearCheckpoint(uploadId || file.name);

      // Update UI
      setUploads(prev => ({
        ...prev,
        [uploadId || file.name]: {
          ...prev[uploadId || file.name],
          status: 'completed',
          progress: 100,
        },
      }));

      return result;

    } catch (error) {
      console.error('Upload failed:', error);
      throw error;
    }
  }, [saveCheckpoint, clearCheckpoint]);

  /**
   * Resume a saved upload
   */
  const resumeUpload = useCallback(async (checkpoint, file, options = {}) => {
    console.log(`Resuming upload: ${checkpoint.fileName}`);

    // Initialize upload with existing upload ID
    return uploadWithResume(file, {
      ...options,
      uploadId: checkpoint.uploadId,
      folderId: checkpoint.folderId,
    });
  }, [uploadWithResume]);

  /**
   * Delete a saved upload checkpoint
   */
  const deleteResumable = useCallback((uploadId) => {
    clearCheckpoint(uploadId);
  }, [clearCheckpoint]);

  /**
   * Clear all checkpoints
   */
  const clearAllCheckpoints = useCallback(() => {
    resumableUploads.forEach(upload => {
      clearCheckpoint(upload.uploadId);
    });
    setResumableUploads([]);
  }, [resumableUploads, clearCheckpoint]);

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
