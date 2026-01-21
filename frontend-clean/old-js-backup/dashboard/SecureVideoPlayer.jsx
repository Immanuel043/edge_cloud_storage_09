/**
 * SecureVideoPlayer - React component for ZK encrypted video playback
 *
 * Features:
 * - Custom controls with progress bar and buffer visualization
 * - Loading and error states
 * - Session lock integration
 * - Responsive design with dark mode support
 */

import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Lock,
  Loader,
  AlertCircle,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { useSecureVideoPlayer } from '../../hooks/useSecureVideoPlayer';

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * SecureVideoPlayer component
 * @param {Object} props
 * @param {string} props.fileId - ZK file ID
 * @param {Object} props.metadata - File metadata
 * @param {boolean} props.darkMode - Dark mode flag
 * @param {function} props.onClose - Close callback
 */
export default function SecureVideoPlayer({
  fileId,
  metadata,
  darkMode = false,
  onClose,
  className = '',
}) {
  const {
    videoRef,
    videoElement,
    isReady,
    isPlaying,
    isBuffering,
    isLocked,
    currentTime,
    duration,
    buffered,
    progress,
    bufferProgress,
    error,
    play,
    pause,
    seek,
    togglePlay,
    lock,
    clearError,
    canPlay,
  } = useSecureVideoPlayer(fileId, metadata);

  // Local state
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef(null);
  const controlsTimeoutRef = useRef(null);

  // Auto-hide controls
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControls(true);

    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying]);

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [isPlaying, resetControlsTimeout]);

  // Handle mouse move to show controls
  const handleMouseMove = () => {
    resetControlsTimeout();
  };

  // Volume control
  const handleVolumeChange = useCallback((e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
    if (videoElement) {
      videoElement.volume = newVolume;
      videoElement.muted = newVolume === 0;
    }
  }, [videoElement]);

  const toggleMute = useCallback(() => {
    if (videoElement) {
      const newMuted = !isMuted;
      setIsMuted(newMuted);
      videoElement.muted = newMuted;
    }
  }, [isMuted, videoElement]);

  // Seek via progress bar
  const handleProgressClick = useCallback((e) => {
    if (!duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const newTime = pos * duration;
    seek(newTime);
  }, [duration, seek]);

  // Skip forward/back
  const skipForward = useCallback(() => {
    seek(Math.min(currentTime + 10, duration));
  }, [currentTime, duration, seek]);

  const skipBack = useCallback(() => {
    seek(Math.max(currentTime - 10, 0));
  }, [currentTime, seek]);

  // Fullscreen
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;

    if (!isFullscreen) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen();
      } else if (containerRef.current.webkitRequestFullscreen) {
        containerRef.current.webkitRequestFullscreen();
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skipBack();
          break;
        case 'ArrowRight':
          e.preventDefault();
          skipForward();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'Escape':
          if (onClose) onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, skipBack, skipForward, toggleMute, toggleFullscreen, onClose]);

  // Always render container with video element so ref gets attached
  // Show overlays for loading/locked/error states
  return (
    <div
      ref={containerRef}
      className={`relative bg-black rounded-lg overflow-hidden ${className}`}
      style={{ aspectRatio: '16/9' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video Element - always rendered so ref gets attached */}
      <video
        ref={videoRef}
        className={`w-full h-full object-contain ${(!isReady || isLocked || error) ? 'invisible' : ''}`}
        playsInline
        onClick={togglePlay}
      />

      {/* Loading Overlay */}
      {!isReady && !error && !isLocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
          <Loader className="w-12 h-12 animate-spin mb-4" />
          <p className="text-lg">Loading encrypted video...</p>
          <p className="text-sm text-gray-400 mt-2">Decrypting header and initializing player</p>
        </div>
      )}

      {/* Locked Overlay */}
      {isLocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
          <Lock className="w-16 h-16 mb-4 text-yellow-500" />
          <p className="text-lg">Session Locked</p>
          <p className="text-sm text-gray-400 mt-2">Unlock your ZK session to play encrypted videos</p>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
          <AlertCircle className="w-16 h-16 mb-4 text-red-500" />
          <p className="text-lg">Playback Error</p>
          <p className="text-sm text-gray-400 mt-2">{error.message}</p>
          <button
            onClick={clearError}
            className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Buffering Overlay */}
      {isBuffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <Loader className="w-12 h-12 text-white animate-spin" />
        </div>
      )}

      {/* Controls Overlay - only show when ready */}
      {isReady && !isLocked && !error && (
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30" />

        {/* Center play button */}
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={togglePlay}
            className="p-4 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
          >
            {isPlaying ? (
              <Pause className="w-12 h-12 text-white" />
            ) : (
              <Play className="w-12 h-12 text-white" />
            )}
          </button>
        </div>

        {/* Bottom controls */}
        <div className="absolute bottom-0 left-0 right-0 p-4">
          {/* Progress bar */}
          <div
            className="relative h-1 bg-white/30 rounded-full cursor-pointer mb-4 group"
            onClick={handleProgressClick}
          >
            {/* Buffer progress */}
            <div
              className="absolute h-full bg-white/50 rounded-full"
              style={{ width: `${Math.min(bufferProgress, 100)}%` }}
            />
            {/* Playback progress */}
            <div
              className="absolute h-full bg-blue-500 rounded-full"
              style={{ width: `${progress}%` }}
            />
            {/* Scrubber */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `${progress}%`, transform: 'translate(-50%, -50%)' }}
            />
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Play/Pause */}
              <button
                onClick={togglePlay}
                className="text-white hover:text-blue-400 transition-colors"
              >
                {isPlaying ? <Pause size={24} /> : <Play size={24} />}
              </button>

              {/* Skip back */}
              <button
                onClick={skipBack}
                className="text-white hover:text-blue-400 transition-colors"
              >
                <SkipBack size={20} />
              </button>

              {/* Skip forward */}
              <button
                onClick={skipForward}
                className="text-white hover:text-blue-400 transition-colors"
              >
                <SkipForward size={20} />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleMute}
                  className="text-white hover:text-blue-400 transition-colors"
                >
                  {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer"
                />
              </div>

              {/* Time display */}
              <span className="text-white text-sm">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <div className="flex items-center gap-4">
              {/* Lock button */}
              <button
                onClick={lock}
                className="text-white hover:text-yellow-400 transition-colors"
                title="Lock session"
              >
                <Lock size={20} />
              </button>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white hover:text-blue-400 transition-colors"
              >
                <Maximize size={20} />
              </button>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
