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
import type { SecureVideoPlayerProps, FileItem } from './types';
import type { SecureVideoMetadata } from '../../types/hooks.types';

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
function formatTime(seconds: number): string {
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
 */
const SecureVideoPlayer: React.FC<SecureVideoPlayerProps> = ({
  fileId,
  metadata,
  onClose,
  className = '',
}) => {
  // Build metadata with explicit narrowing — conditional spread widens chunk_size
  // to number | undefined under exactOptionalPropertyTypes, so we assign after construction.
  const videoMeta: SecureVideoMetadata | null = (() => {
    if (!metadata) return null;
    const result: SecureVideoMetadata = {
      encrypted_file_key: metadata.encrypted_file_key || '',
      file_key_iv: (metadata as FileItem & { file_key_iv?: string }).file_key_iv || '',
      file_size: metadata.size || 0,
    };
    const cs = (metadata as FileItem & { chunk_size?: number }).chunk_size;
    if (cs !== undefined) result.chunk_size = cs;
    return result;
  })();

  const {
    videoRef,
    videoElement,
    isReady,
    isPlaying,
    isBuffering,
    isLocked,
    currentTime,
    duration,
    progress,
    bufferProgress,
    error,
    seek,
    togglePlay,
    lock,
    clearError,
  } = useSecureVideoPlayer(fileId, videoMeta);

  // Local state
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
  const handleMouseMove = (): void => {
    resetControlsTimeout();
  };

  // Volume control
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
    if (videoElement) {
      videoElement.volume = newVolume;
      videoElement.muted = newVolume === 0;
    }
  }, [videoElement]);

  const toggleMute = useCallback((): void => {
    if (videoElement) {
      const newMuted = !isMuted;
      setIsMuted(newMuted);
      videoElement.muted = newMuted;
    }
  }, [isMuted, videoElement]);

  // Seek via progress bar
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    if (!duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const newTime = pos * duration;
    seek(newTime);
  }, [duration, seek]);

  // Skip forward/back
  const skipForward = useCallback((): void => {
    if (duration) {
      seek(Math.min(currentTime + 10, duration));
    }
  }, [currentTime, duration, seek]);

  const skipBack = useCallback((): void => {
    seek(Math.max(currentTime - 10, 0));
  }, [currentTime, seek]);

  // Fullscreen
  const toggleFullscreen = useCallback((): void => {
    if (!containerRef.current) return;

    const element = containerRef.current as HTMLElement & {
      webkitRequestFullscreen?: () => void;
    };
    const doc = document as Document & {
      webkitExitFullscreen?: () => void;
      webkitFullscreenElement?: Element | null;
    };

    if (!isFullscreen) {
      if (element.requestFullscreen) {
        element.requestFullscreen();
      } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      }
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
      };
      setIsFullscreen(!!(document.fullscreenElement || doc.webkitFullscreenElement));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Keyboard shortcuts — only active when player container has focus
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT') return;

      // Only handle shortcuts when the player container or its children have focus
      if (!container.contains(document.activeElement) && document.activeElement !== document.body) return;

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
          <Lock className="w-16 h-16 mb-4 text-warning" />
          <p className="text-lg">Session Locked</p>
          <p className="text-sm text-gray-400 mt-2">Unlock your ZK session to play encrypted videos</p>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
          <AlertCircle className="w-16 h-16 mb-4 text-danger" />
          <p className="text-lg">Playback Error</p>
          <p className="text-sm text-gray-400 mt-2">{error.message}</p>
          <button
            onClick={clearError}
            className="mt-4 px-4 py-2 bg-primary hover:bg-primary/90 rounded-lg transition-colors"
            type="button"
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
            type="button"
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
              className="absolute h-full bg-primary rounded-full"
              style={{ width: `${progress}%` }}
            />
            {/* Scrubber */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `${progress}%`, transform: 'translate(-50%, -50%)' }}
            />
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Play/Pause */}
              <button
                onClick={togglePlay}
                className="text-white hover:text-primary transition-colors"
                type="button"
              >
                {isPlaying ? <Pause size={24} /> : <Play size={24} />}
              </button>

              {/* Skip back */}
              <button
                onClick={skipBack}
                className="text-white hover:text-primary transition-colors"
                type="button"
              >
                <SkipBack size={20} />
              </button>

              {/* Skip forward */}
              <button
                onClick={skipForward}
                className="text-white hover:text-primary transition-colors"
                type="button"
              >
                <SkipForward size={20} />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleMute}
                  className="text-white hover:text-primary transition-colors"
                  type="button"
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
                {formatTime(currentTime)} / {formatTime(duration || 0)}
              </span>
            </div>

            <div className="flex items-center gap-4">
              {/* Lock button */}
              <button
                onClick={lock}
                className="text-white hover:text-warning transition-colors"
                title="Lock session"
                type="button"
              >
                <Lock size={20} />
              </button>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white hover:text-primary transition-colors"
                type="button"
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
};

export default SecureVideoPlayer;
