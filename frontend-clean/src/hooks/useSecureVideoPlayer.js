/**
 * useSecureVideoPlayer - React hook for ZK encrypted video playback
 *
 * Provides a simple interface for playing encrypted videos with:
 * - Automatic session lock integration
 * - State management for playback
 * - Error handling
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SecureMediaController, MediaErrorCodes } from '../services/secureMedia/SecureMediaController';
import { useAuth } from '../contexts/AuthContext';

/**
 * Hook state interface
 * @typedef {Object} SecureVideoState
 * @property {boolean} isReady - True when playback is ready
 * @property {boolean} isPlaying - True when video is playing
 * @property {boolean} isBuffering - True when buffering
 * @property {boolean} isLocked - True when session is locked
 * @property {number} currentTime - Current playback time in seconds
 * @property {number} duration - Total duration in seconds
 * @property {number} buffered - Buffered time ahead in seconds
 * @property {Object|null} error - Error object if any
 */

/**
 * useSecureVideoPlayer hook
 * @param {string} fileId - ZK file ID
 * @param {Object} metadata - File metadata with encrypted_file_key, file_key_iv, file_size
 * @returns {Object} Hook return value
 */
export function useSecureVideoPlayer(fileId, metadata) {
  const videoRef = useRef(null);
  const controllerRef = useRef(null);
  const metadataRef = useRef(metadata);

  const { zkSessionUnlocked } = useAuth();

  // Track when video element is mounted
  const [videoMounted, setVideoMounted] = useState(false);

  const [state, setState] = useState({
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
  const metadataKey = useMemo(() => {
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
      setState(s => ({ ...s, isLocked: true, isReady: false }));
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

    console.log('[useSecureVideoPlayer] Starting controller initialization...');

    // Create and initialize controller
    const controller = new SecureMediaController();
    controllerRef.current = controller;

    // Setup callbacks
    controller.onReady(() => {
      setState(s => ({
        ...s,
        isReady: true,
        isLocked: false,
        duration: controller.getStats().duration,
      }));
    });

    controller.onProgress((progress) => {
      setState(s => ({
        ...s,
        currentTime: progress.currentTime,
        duration: progress.duration,
        buffered: progress.buffered,
        bufferedRanges: progress.bufferedRanges,
      }));
    });

    controller.onBuffering((isBuffering) => {
      setState(s => ({ ...s, isBuffering }));
    });

    controller.onError((error) => {
      console.error('[useSecureVideoPlayer] Error:', error);
      setState(s => ({ ...s, error }));
    });

    // Use the ref for metadata to ensure we have the latest values
    const currentMetadata = metadataRef.current;

    // Initialize
    controller.init(fileId, videoRef.current, currentMetadata).catch((error) => {
      // Only set error if controller wasn't destroyed (prevents error flash on cleanup)
      if (!controller.isDestroyed) {
        setState(s => ({
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
      controller.destroy();
      controllerRef.current = null;
    };
  }, [fileId, metadataKey, zkSessionUnlocked, videoMounted]);

  // Handle session lock/unlock
  useEffect(() => {
    if (!zkSessionUnlocked && controllerRef.current) {
      controllerRef.current.lock();
      setState(s => ({ ...s, isLocked: true, isReady: false }));
    }
  }, [zkSessionUnlocked]);

  // Track playing state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setState(s => ({ ...s, isPlaying: true }));
    const handlePause = () => setState(s => ({ ...s, isPlaying: false }));
    const handleEnded = () => setState(s => ({ ...s, isPlaying: false }));

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
  const play = useCallback(async () => {
    if (controllerRef.current) {
      await controllerRef.current.play();
    }
  }, []);

  const pause = useCallback(() => {
    controllerRef.current?.pause();
  }, []);

  const seek = useCallback((time) => {
    controllerRef.current?.seek(time);
  }, []);

  const togglePlay = useCallback(async () => {
    if (state.isPlaying) {
      pause();
    } else {
      await play();
    }
  }, [state.isPlaying, play, pause]);

  // Lock session manually
  const lock = useCallback(() => {
    controllerRef.current?.lock();
    setState(s => ({ ...s, isLocked: true }));
  }, []);

  // Get stats
  const getStats = useCallback(() => {
    return controllerRef.current?.getStats() || null;
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setState(s => ({ ...s, error: null }));
  }, []);

  // Computed values
  const progress = useMemo(() => {
    if (state.duration === 0) return 0;
    return (state.currentTime / state.duration) * 100;
  }, [state.currentTime, state.duration]);

  const bufferProgress = useMemo(() => {
    if (state.duration === 0) return 0;
    return ((state.currentTime + state.buffered) / state.duration) * 100;
  }, [state.currentTime, state.buffered, state.duration]);

  // Callback ref that triggers re-render when video element mounts
  const videoRefCallback = useCallback((node) => {
    videoRef.current = node;
    setVideoMounted(!!node);
  }, []);

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
