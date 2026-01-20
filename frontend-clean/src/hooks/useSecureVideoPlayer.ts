/**
 * useSecureVideoPlayer - React hook for ZK encrypted video playback
 *
 * Provides a simple interface for playing encrypted videos with:
 * - Automatic session lock integration
 * - State management for playback
 * - Error handling
 */

import { useState, useEffect, useRef, useCallback, useMemo, type RefCallback } from 'react';
import { SecureMediaController, MediaErrorCodes } from '../services/secureMedia/SecureMediaController';
import { useAuth } from '../contexts/AuthContext';
import type { SecureVideoState, SecureVideoMetadata, MediaStats } from '../types/hooks.types';

// Type guard for SecureVideoMetadata
function isSecureVideoMetadata(data: unknown): data is SecureVideoMetadata {
  return (
    typeof data === 'object' &&
    data !== null &&
    'encrypted_file_key' in data &&
    typeof (data as Record<string, unknown>).encrypted_file_key === 'string' &&
    'file_key_iv' in data &&
    typeof (data as Record<string, unknown>).file_key_iv === 'string' &&
    'file_size' in data &&
    typeof (data as Record<string, unknown>).file_size === 'number'
  );
}

// Progress callback type from SecureMediaController (matches ProgressInfo)
interface MediaProgress {
  currentTime: number;
  duration: number;
  buffered: number;
  bufferedRanges?: [number, number][];
}

export interface UseSecureVideoPlayerReturn extends SecureVideoState {
  videoRef: RefCallback<HTMLVideoElement | null>;
  videoElement: HTMLVideoElement | null;
  progress: number;
  bufferProgress: number;
  play: () => Promise<void>;
  pause: () => void;
  seek: (time: number) => void;
  togglePlay: () => Promise<void>;
  lock: () => void;
  getStats: () => MediaStats | null;
  clearError: () => void;
  canPlay: boolean;
}

/**
 * useSecureVideoPlayer hook
 * @param fileId - ZK file ID
 * @param metadata - File metadata with encrypted_file_key, file_key_iv, file_size
 * @returns Hook return value
 */
export function useSecureVideoPlayer(
  fileId: string | null | undefined,
  metadata: SecureVideoMetadata | null | undefined
): UseSecureVideoPlayerReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controllerRef = useRef<SecureMediaController | null>(null);
  const metadataRef = useRef<SecureVideoMetadata | null | undefined>(metadata);

  const { zkSessionUnlocked } = useAuth();

  // Track when video element is mounted
  const [videoMounted, setVideoMounted] = useState<boolean>(false);

  const [state, setState] = useState<SecureVideoState>({
    isReady: false,
    isPlaying: false,
    isBuffering: false,
    isLocked: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    bufferedRanges: [],
    error: null,
  });

  // Update metadata ref when it changes (but don't trigger re-initialization)
  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  // Create stable metadata key to detect actual changes (not just reference changes)
  // Only re-initialize if the key fields actually change
  const metadataKey = useMemo<string | null>(() => {
    if (!metadata) return null;
    return `${metadata.encrypted_file_key || ''}-${metadata.file_key_iv || ''}-${metadata.file_size || 0}`;
  }, [metadata?.encrypted_file_key, metadata?.file_key_iv, metadata?.file_size]);

  // Initialize controller when video element and metadata are available
  useEffect(() => {
    console.log('[useSecureVideoPlayer] Effect triggered', {
      zkSessionUnlocked,
      fileId,
      hasMetadata: !!metadataRef.current,
      metadataKey,
      videoMounted,
      hasVideoRef: !!videoRef.current,
    });

    if (!zkSessionUnlocked) {
      // Session is locked - don't initialize
      console.log('[useSecureVideoPlayer] Session is locked - skipping initialization');
      setState((s) => ({ ...s, isLocked: true, isReady: false }));
      return;
    }

    if (!fileId || !metadataRef.current || !metadataKey || !videoMounted || !videoRef.current) {
      console.log('[useSecureVideoPlayer] Missing required props', {
        fileId: !!fileId,
        metadata: !!metadataRef.current,
        metadataKey: !!metadataKey,
        videoMounted,
        videoRef: !!videoRef.current,
      });
      return;
    }

    // Validate metadata before use (ZK safety)
    if (!isSecureVideoMetadata(metadataRef.current)) {
      console.error('[useSecureVideoPlayer] Invalid metadata format');
      setState((s) => ({
        ...s,
        error: {
          code: MediaErrorCodes.FETCH_FAILED,
          message: 'Invalid metadata: missing required encryption fields',
        },
      }));
      return;
    }

    console.log('[useSecureVideoPlayer] Starting controller initialization...');

    // Create and initialize controller
    const controller = new SecureMediaController();
    controllerRef.current = controller;

    // Setup callbacks
    controller.onReady(() => {
      const stats = controller.getStats();
      setState((s) => ({
        ...s,
        isReady: true,
        isLocked: false,
        duration: stats?.duration || 0,
      }));
    });

    controller.onProgress((progress: MediaProgress) => {
      setState((s) => ({
        ...s,
        currentTime: progress.currentTime,
        duration: progress.duration,
        buffered: progress.buffered,
        bufferedRanges: progress.bufferedRanges || s.bufferedRanges,
      }));
    });

    controller.onBuffering((isBuffering: boolean) => {
      setState((s) => ({ ...s, isBuffering }));
    });

    controller.onError((error: { code: string; message: string }) => {
      console.error('[useSecureVideoPlayer] Error:', error);
      setState((s) => ({ ...s, error }));
    });

    // Use the ref for metadata to ensure we have the latest values
    const currentMetadata = metadataRef.current;

    // Initialize
    let isControllerDestroyed = false;
    controller.init(fileId, videoRef.current, currentMetadata).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      // Only set error if controller wasn't destroyed (prevents error flash on cleanup)
      // Check if controller ref still points to the same controller
      if (!isControllerDestroyed && controllerRef.current === controller) {
        setState((s) => ({
          ...s,
          error: { code: MediaErrorCodes.FETCH_FAILED, message: error.message },
        }));
      }
    });

    // Cleanup - bulletproof memory management
    return () => {
      const video = videoRef.current;

      // First, stop playback and clear video source to release file handles
      if (video) {
        const currentSrc = video.src;
        video.pause();
        video.src = '';
        video.load(); // Forces browser to release memory

        // Revoke blob URL if it exists
        if (currentSrc && currentSrc.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(currentSrc);
          } catch (e) {
            // Ignore revocation errors
          }
        }
      }

      // Then destroy the controller (which also cleans up workers, buffers, etc.)
      isControllerDestroyed = true;
      controller.destroy();
      controllerRef.current = null;
    };
  }, [fileId, metadataKey, zkSessionUnlocked, videoMounted]);

  // Handle session lock/unlock
  useEffect(() => {
    if (!zkSessionUnlocked && controllerRef.current) {
      controllerRef.current.lock();
      setState((s) => ({ ...s, isLocked: true, isReady: false }));
    }
  }, [zkSessionUnlocked]);

  // Track playing state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = (): void => setState((s) => ({ ...s, isPlaying: true }));
    const handlePause = (): void => setState((s) => ({ ...s, isPlaying: false }));
    const handleEnded = (): void => setState((s) => ({ ...s, isPlaying: false }));

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
    };
  }, []);

  // Playback controls
  const play = useCallback(async (): Promise<void> => {
    if (controllerRef.current) {
      await controllerRef.current.play();
    }
  }, []);

  const pause = useCallback((): void => {
    controllerRef.current?.pause();
  }, []);

  const seek = useCallback(
    (time: number): void => {
      controllerRef.current?.seek(time);
    },
    []
  );

  const togglePlay = useCallback(async (): Promise<void> => {
    if (state.isPlaying) {
      pause();
    } else {
      await play();
    }
  }, [state.isPlaying, play, pause]);

  // Lock session manually
  const lock = useCallback((): void => {
    controllerRef.current?.lock();
    setState((s) => ({ ...s, isLocked: true }));
  }, []);

  // Get stats
  const getStats = useCallback((): MediaStats | null => {
    const stats = controllerRef.current?.getStats();
    return stats || null;
  }, []);

  // Clear error
  const clearError = useCallback((): void => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  // Computed values
  const progress = useMemo<number>(() => {
    if (state.duration === 0) return 0;
    return (state.currentTime / state.duration) * 100;
  }, [state.currentTime, state.duration]);

  const bufferProgress = useMemo<number>(() => {
    if (state.duration === 0) return 0;
    return ((state.currentTime + state.buffered) / state.duration) * 100;
  }, [state.currentTime, state.buffered, state.duration]);

  // Callback ref that triggers re-render when video element mounts
  const videoRefCallback = useCallback<RefCallback<HTMLVideoElement | null>>(
    (node: HTMLVideoElement | null) => {
      videoRef.current = node;
      setVideoMounted(!!node);
    },
    []
  );

  return {
    // Callback ref for video element - use as ref={videoRef}
    videoRef: videoRefCallback,
    // Access to video element for direct manipulation
    videoElement: videoRef.current,

    // State
    ...state,
    progress,
    bufferProgress,

    // Controls
    play,
    pause,
    seek,
    togglePlay,
    lock,

    // Utilities
    getStats,
    clearError,

    // Convenience
    canPlay: state.isReady && !state.isLocked && !state.error,
  };
}

export default useSecureVideoPlayer;
