import { useState, useEffect, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, Download } from 'lucide-react';
import { API_URL } from '../../config/constants';
import { useAuth } from '../../contexts/AuthContext';
import { VIDEO_EXTENSIONS } from '../../utils/helpers';

export default function FilePreview({ file, onClose, darkMode }) {
  const { isAuthenticated, token } = useAuth();
  const mimeType = (file.mime_type || file.type || '').toLowerCase();
  const extension = file.name?.split('.').pop()?.toLowerCase() || '';
  const isVideoFile = mimeType.startsWith('video/') || VIDEO_EXTENSIONS.includes(extension);
  const isPdfFile = mimeType === 'application/pdf' || extension === 'pdf';
  const applyToken = (url) => {
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  };

  const downloadLink = applyToken(`${API_URL}/files/${file.id}/download`);
  const streamUrl = applyToken(`${API_URL}/files/${file.id}/download?inline=true${isVideoFile ? '&compatible=true' : ''}`);

  const [previewUrl, setPreviewUrl] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState(null);
  const [previewWarning, setPreviewWarning] = useState(null);
  const [streamReady, setStreamReady] = useState(!isVideoFile);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    if (isAuthenticated) {
      loadPreview();
    }
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, isAuthenticated]);

  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setPreviewWarning(null);
    setFatalError(null);
    setStreamReady(!isVideoFile);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [file?.id, isVideoFile]);

  useEffect(() => {
    if (!isVideoFile) {
      setStreamReady(true);
      return;
    }

    let cancelled = false;

    const clearTimer = () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const scheduleRetry = (delay = 2000) => {
      clearTimer();
      pollTimerRef.current = setTimeout(() => {
        if (!cancelled) {
          checkStream();
        }
      }, delay);
    };

    const checkStream = async () => {
      try {
        // Check transcode progress using new API endpoint
        const progressUrl = applyToken(`${API_URL}/files/${file.id}/transcode/progress`);
        const response = await fetch(progressUrl);

        if (cancelled) {
          return;
        }

        if (response.ok) {
          const data = await response.json();

          if (data.status === 'complete') {
            clearTimer();
            setStreamReady(true);
            setPreviewWarning(null);
            return;
          }

          if (data.status === 'transcoding') {
            setStreamReady(false);

            // Build detailed progress message
            const percent = Math.round(data.percent || 0);
            const fps = data.fps ? ` (${Math.round(data.fps)} fps)` : '';
            const eta = data.eta_seconds
              ? ` - ${Math.ceil(data.eta_seconds / 60)} min remaining`
              : '';

            setPreviewWarning(
              `Preparing browser-compatible copy: ${percent}%${fps}${eta}`
            );
            scheduleRetry(2000);  // Poll every 2 seconds
            return;
          }

          if (data.status === 'not_started') {
            // Don't return - fall through to HEAD request to check if file is already compatible
            setPreviewWarning('Checking if video needs processing...');
          }
        }

        // Fallback: check stream availability with HEAD request
        // This handles cases where the video doesn't need transcoding (already compatible MP4)
        const headResponse = await fetch(streamUrl, {
          method: 'HEAD'
        });

        if (headResponse.ok || headResponse.status === 206) {
          clearTimer();
          setStreamReady(true);
          setPreviewWarning(null);
          return;
        }

        if (headResponse.status === 202) {
          setStreamReady(false);
          setPreviewWarning(
            'Preparing a browser-compatible copy. This can take a minute for large videos...'
          );
          scheduleRetry(2000);
        } else {
          setPreviewWarning(`Video stream unavailable (HTTP ${headResponse.status}). Retrying...`);
          scheduleRetry(5000);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setPreviewWarning('Unable to reach video stream. Retrying...');
        scheduleRetry(5000);
      }
    };

    checkStream();

    return () => {
      cancelled = true;
      clearTimer();
    };

  }, [isVideoFile, streamUrl]);

  const loadPreview = async () => {
    setLoading(true);
    setFatalError(null);
    setPreviewWarning(null);

    const setPreviewFailure = (message, { fatal = false } = {}) => {
      if (fatal || !isVideoFile) {
        setFatalError(message);
        setPreviewWarning(null);
      } else {
        setPreviewWarning(message);
        setFatalError(null);
      }
    };

    try {
      const response = await fetch(`${API_URL}/files/${file.id}/preview?size=large`, {
        credentials: 'include'
      });

      if (response.ok) {
        const blob = await response.blob();
        setPreviewUrl(URL.createObjectURL(blob));
        setPreviewWarning(null);
      } else if (response.status === 202) {
        setPreviewFailure(
          'Preview is still generating. Video playback will start using the inline player.',
          { fatal: false }
        );
      } else if (response.status === 404) {
        setPreviewFailure('File not found. It may have been deleted or moved.', { fatal: true });
      } else if (response.status === 401) {
        setPreviewFailure('Authentication required. Please log in again.', { fatal: true });
      } else {
        setPreviewFailure(
          `Failed to load preview (Error ${response.status}). You can still stream the file below.`,
          { fatal: false }
        );
      }
    } catch (err) {
      console.error('Failed to load preview:', err);
      setPreviewFailure('Failed to load preview. Please try again.', { fatal: false });
    } finally {
      setLoading(false);
    }
  };

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.5));
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);

  const handleVideoError = (e) => {
    const videoElement = e?.target;
    const errorDetails = {
      error: videoElement?.error,
      networkState: videoElement?.networkState,
      readyState: videoElement?.readyState,
      src: videoElement?.src,
      fileName: file.name
    };
    console.error('Video playback error:', errorDetails);
    console.error('Stream URL:', streamUrl);

    let errorMessage = '';
    let errorHint = '';

    if (videoElement?.error) {
      switch (videoElement.error.code) {
        case 1: // MEDIA_ERR_ABORTED
          errorMessage = 'Playback interrupted';
          errorHint = 'The video stopped loading unexpectedly. Please refresh and try again.';
          break;
        case 2: // MEDIA_ERR_NETWORK
          errorMessage = 'Connection issue';
          errorHint = 'Could not load the video due to a network problem. Check your internet connection.';
          break;
        case 3: // MEDIA_ERR_DECODE
          errorMessage = 'Preparing your video';
          errorHint = 'This video needs additional processing. For large files, this may take a few minutes. Please try again shortly.';
          break;
        case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
          errorMessage = 'Cannot play this video';
          errorHint = 'This format is not supported for streaming. You can download the file to play it locally.';
          break;
        default:
          errorMessage = 'Playback unavailable';
          errorHint = 'Something went wrong. Please try again in a moment.';
      }
    } else {
      errorMessage = 'Playback unavailable';
      errorHint = 'The video could not be loaded. Please try again shortly.';
    }

    setPreviewWarning(null);
    setFatalError(`${errorMessage}. ${errorHint}`);
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleBackdropClick}
    >
      <div className={`w-full max-w-6xl rounded-2xl shadow-2xl ${darkMode ? 'bg-gray-900 text-white' : 'bg-white text-gray-900'}`}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <div>
            <h2 className="text-lg font-semibold">{file.name}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{file.mime_type || 'Unknown type'}</p>
          </div>
          <div className="flex items-center gap-2">
            {!isVideoFile && (
              <>
                <button
                  onClick={handleZoomOut}
                  className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                  title="Zoom out"
                >
                  <ZoomOut size={20} />
                </button>
                <span className={`px-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  onClick={handleZoomIn}
                  className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                  title="Zoom in"
                >
                  <ZoomIn size={20} />
                </button>
                <button
                  onClick={handleRotate}
                  className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                  title="Rotate"
                >
                  <RotateCw size={20} />
                </button>
              </>
            )}
            {isVideoFile && (
              <a
                href={downloadLink}
                download={file.name}
                className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                title="Download video"
              >
                <Download size={20} />
              </a>
            )}
            <button
              onClick={onClose}
              className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              title="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto flex items-center justify-center p-4 min-h-[60vh]">
          {loading && !isPdfFile ? (
            <div className={darkMode ? 'text-white' : 'text-gray-900'}>Loading preview...</div>
          ) : fatalError ? (
            <div className={`text-center ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              <p className="mb-4">{fatalError}</p>
              {isVideoFile && (
                <a
                href={downloadLink}
                  download={file.name}
                  className={`inline-flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
                    darkMode
                      ? 'bg-blue-600 hover:bg-blue-700 text-white'
                      : 'bg-blue-500 hover:bg-blue-600 text-white'
                  }`}
                >
                  <Download size={20} />
                  Download Video
                </a>
              )}
              {!isVideoFile && (
                <p className="text-sm mt-2">Preview may not be available for this file type</p>
              )}
            </div>
          ) : isPdfFile ? (
            <div className="w-full h-full min-h-[70vh]">
              <iframe
                src={applyToken(`${API_URL}/files/${file.id}/download?inline=true`)}
                className="w-full h-full rounded-lg"
                style={{ minHeight: '70vh' }}
                title={file.name}
              />
            </div>
          ) : isVideoFile ? (
            streamReady ? (
              <div className="flex w-full max-w-4xl flex-col items-center">
                <div className="relative w-full">
                <video
                  key={`${file.id}-stream`}
                  controls
                  playsInline
                  preload="metadata"
                  poster={previewUrl || undefined}
                  className="w-full max-h-[80vh] rounded-lg bg-black"
                  src={streamUrl}
                  onError={handleVideoError}
                />
                </div>
                {previewWarning && (
                  <p className={`mt-4 text-sm ${darkMode ? 'text-amber-300' : 'text-amber-600'}`}>
                    {previewWarning}
                  </p>
                )}
              </div>
            ) : (
              <div className={`flex flex-col items-center text-center gap-4 ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                <div className="h-12 w-12 rounded-full border-4 border-blue-500 border-t-transparent animate-spin" />
                <p>{previewWarning || 'Preparing a browser-compatible stream...'}</p>
                <p className="text-sm opacity-70">
                  Leave this window open—we’ll start playback automatically once it’s ready.
                </p>
              </div>
            )
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={file.name}
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transition: 'transform 0.3s ease'
              }}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <div className={darkMode ? 'text-white' : 'text-gray-900'}>Preview not available</div>
          )}
        </div>
      </div>
    </div>
  );
}
