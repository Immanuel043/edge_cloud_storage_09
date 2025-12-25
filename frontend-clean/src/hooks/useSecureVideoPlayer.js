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

  const { zkSessionUnlocked } = useAuth();

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

  // Initialize controller when video element and metadata are available
  useEffect(() => {
    if (!zkSessionUnlocked) {
      // Session is locked - don't initialize
      setState(s => ({ ...s, isLocked: true, isReady: false }));
      return;
    }

    if (!fileId || !metadata || !videoRef.current) {
      return;
    }

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

    // Initialize
    controller.init(fileId, videoRef.current, metadata).catch((error) => {
      setState(s => ({
        ...s,
        error: { code: MediaErrorCodes.FETCH_FAILED, message: error.message },
      }));
    });

    // Cleanup
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [fileId, metadata, zkSessionUnlocked]);

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

  return {
    // Ref for video element
    videoRef,

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
