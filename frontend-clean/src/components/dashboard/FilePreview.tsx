import React, { useState, useEffect, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, Download, Table, Shield, Lock, Loader, Music } from 'lucide-react';
import { API_URL } from '../../config/constants';
import { useAuth } from '../../contexts/AuthContext';
import { VIDEO_EXTENSIONS, EXCEL_EXTENSIONS, XML_EXTENSIONS, TEXT_EXTENSIONS, AUDIO_EXTENSIONS } from '../../utils/helpers';
import SecureVideoPlayer from './SecureVideoPlayer';
import { storageService } from '../../services/storageService';
import { isZKSessionUnlocked } from '../../services/zkEncryptionService';
import type { FilePreviewProps, ZKDecryptProgress, TranscodeProgressResponse } from './types';
import { getErrorMessage } from './types';

const FilePreview: React.FC<FilePreviewProps> = ({ file, onClose, darkMode }) => {
  const { isAuthenticated, token } = useAuth();
  const mimeType = (file.mime_type || file.type || '').toLowerCase();
  const extension = (file.name?.split('.').pop()?.toLowerCase() || '') as string;
  const isVideoFile = mimeType.startsWith('video/') || VIDEO_EXTENSIONS.includes(extension as any);
  const isAudioFile = mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.includes(extension as any);
  const isPdfFile = mimeType === 'application/pdf' || extension === 'pdf';
  const isExcelFile = mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv' || EXCEL_EXTENSIONS.includes(extension as any);
  const isXmlFile = mimeType.includes('xml') || XML_EXTENSIONS.includes(extension as any);
  const isTextFile = mimeType.startsWith('text/') || TEXT_EXTENSIONS.includes(extension as any);

  // Check if file is ZK-encrypted (client-side encryption)
  const isZKEncrypted = file.is_encrypted || !!file.encrypted_file_key;

  const applyToken = (url: string): string => {
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  };

  const downloadLink = applyToken(`${API_URL}/api/v1/files/${file.id}/download`);
  const streamUrl = applyToken(`${API_URL}/api/v1/files/${file.id}/download?inline=true${isVideoFile ? '&compatible=true' : ''}`);

  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [zoom, setZoom] = useState<number>(1);
  const [rotation, setRotation] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [previewWarning, setPreviewWarning] = useState<string | null>(null);
  const [streamReady, setStreamReady] = useState<boolean>(!isVideoFile);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ZK preview state
  const [zkDecryptProgress, setZkDecryptProgress] = useState<ZKDecryptProgress | null>(null);
  const [zkSessionLocked, setZkSessionLocked] = useState<boolean>(false);

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
    // Skip stream check for non-videos and ZK-encrypted videos (uses SecureMediaController)
    if (!isVideoFile || isZKEncrypted) {
      setStreamReady(true);
      return;
    }

    let cancelled = false;

    const clearTimer = (): void => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const scheduleRetry = (delay = 2000): void => {
      clearTimer();
      pollTimerRef.current = setTimeout(() => {
        if (!cancelled) {
          checkStream();
        }
      }, delay);
    };

    const checkStream = async (): Promise<void> => {
      try {
        // Check transcode progress using new API endpoint
        const progressUrl = applyToken(`${API_URL}/api/v1/files/${file.id}/transcode/progress`);
        const response = await fetch(progressUrl, {
          credentials: 'include'
        });

        if (cancelled) {
          return;
        }

        if (response.ok) {
          const data = await response.json() as TranscodeProgressResponse;

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
            // Video needs transcoding but hasn't started yet
            // Check with HEAD request first - if 202, trigger transcoding with GET
            setPreviewWarning('Checking if video needs processing...');
            
            const headResponse = await fetch(streamUrl, {
              method: 'HEAD',
              credentials: 'include'
            });

            if (cancelled) {
              return;
            }

            if (headResponse.ok || headResponse.status === 206) {
              // Video is already compatible, no transcoding needed
              clearTimer();
              setStreamReady(true);
              setPreviewWarning(null);
              return;
            }

            if (headResponse.status === 202) {
              // Video needs transcoding - trigger it with a GET request
              setPreviewWarning('Starting video conversion for browser playback...');
              
              // Make a GET request to trigger the transcoding (abort quickly, we just need to start it)
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 2000);
              
              try {
                await fetch(streamUrl, {
                  credentials: 'include',
                  signal: controller.signal
                });
              } catch {
                // Expected to abort or get 202 - that's fine
              } finally {
                clearTimeout(timeoutId);
              }
              
              // Now poll for progress
              setStreamReady(false);
              setPreviewWarning('Preparing a browser-compatible copy. This can take a minute for large videos...');
              scheduleRetry(2000);
              return;
            }

            // Other status - retry
            setPreviewWarning(`Video stream unavailable (HTTP ${headResponse.status}). Retrying...`);
            scheduleRetry(5000);
            return;
          }
        }

        // Fallback: check stream availability with HEAD request
        // This handles cases where transcode/progress endpoint fails or returns unexpected data
        const headResponse = await fetch(streamUrl, {
          method: 'HEAD',
          credentials: 'include'
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
      } catch (error: unknown) {
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

  }, [isVideoFile, isZKEncrypted, streamUrl, file.id]);

  const loadPreview = async (): Promise<void> => {
    setLoading(true);
    setFatalError(null);
    setPreviewWarning(null);

    const setPreviewFailure = (message: string, { fatal = false }: { fatal?: boolean } = {}): void => {
      if (fatal || !isVideoFile) {
        setFatalError(message);
        setPreviewWarning(null);
      } else {
        setPreviewWarning(message);
        setFatalError(null);
      }
    };

    // Handle ZK-encrypted files with client-side decryption
    if (isZKEncrypted) {
      if (isVideoFile) {
        // ZK video - SecureVideoPlayer will handle it
        setLoading(false);
        return;
      }

      // Check if ZK session is unlocked
      if (!isZKSessionUnlocked()) {
        setZkSessionLocked(true);
        setPreviewFailure(
          'Session is locked. Please unlock your ZK session to preview encrypted files.',
          { fatal: true }
        );
        setLoading(false);
        return;
      }

      // Check if file type is previewable (images, audio, PDFs, text)
      const isImage = mimeType.startsWith('image/');
      const canPreviewZK = isImage || isAudioFile || isPdfFile || isTextFile || isXmlFile;

      if (!canPreviewZK) {
        // Non-previewable ZK files (Excel, etc.) - show download prompt
        setPreviewFailure(
          'Preview not available for this encrypted file type. Download the file to view it locally.',
          { fatal: true }
        );
        setLoading(false);
        return;
      }

      // Decrypt and preview ZK file
      try {
        setZkDecryptProgress({ stage: 'starting', progress: 0 });

        const fileMetadata: {
          encrypted_file_key: string;
          file_key_iv: string;
          file_size: number;
          chunk_size?: number;
          mime_type: string;
        } = {
          encrypted_file_key: file.encrypted_file_key || '',
          file_key_iv: file.file_key_iv || '',
          file_size: file.size || file.file_size || 0,
          mime_type: file.mime_type || file.type || '',
        };
        if (file.chunk_size !== undefined) {
          fileMetadata.chunk_size = file.chunk_size;
        }
        const result = await storageService.previewZKFile(
          file.id,
          fileMetadata,
          (progress: Record<string, unknown>) => setZkDecryptProgress(progress as unknown as ZKDecryptProgress)
        );

        setPreviewUrl(result.blobUrl);
        setZkDecryptProgress(null);
        setLoading(false);
        return;
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        console.error('[Preview] ZK preview failed:', error);
        setZkDecryptProgress(null);
        setPreviewFailure(
          errorMessage.includes('locked')
            ? 'Session is locked. Please unlock your ZK session to preview encrypted files.'
            : 'Failed to decrypt file for preview. Please try again or download the file.',
          { fatal: true }
        );
        setLoading(false);
        return;
      }
    }

    try {
      const response = await fetch(`${API_URL}/api/v1/files/${file.id}/preview?size=large`, {
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
      } else if (response.status === 400) {
        // ZK-encrypted files cannot be previewed server-side
        setPreviewFailure(
          'Preview not available for encrypted files. Download the file to view it locally.',
          { fatal: true }
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
    } catch (err: unknown) {
      console.error('Failed to load preview:', err);
      setPreviewFailure('Failed to load preview. Please try again.', { fatal: false });
    } finally {
      setLoading(false);
    }
  };

  const handleZoomIn = (): void => setZoom(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = (): void => setZoom(prev => Math.max(prev - 0.25, 0.5));
  const handleRotate = (): void => setRotation(prev => (prev + 90) % 360);

  const handleVideoError = (e: React.SyntheticEvent<HTMLVideoElement, Event>): void => {
    const videoElement = e?.target as HTMLVideoElement;
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
          errorMessage = 'Video still processing';
          errorHint = 'The video conversion is still in progress. Please wait a moment and try again, or download the original file to play locally.';
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

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>): void => {
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
                  type="button"
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
                  type="button"
                >
                  <ZoomIn size={20} />
                </button>
                <button
                  onClick={handleRotate}
                  className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                  title="Rotate"
                  type="button"
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
              type="button"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto flex items-center justify-center p-4 min-h-[60vh]">
          {/* ZK Decryption Progress */}
          {zkDecryptProgress && (
            <div className={`flex flex-col items-center text-center gap-4 ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              <div className={`p-4 rounded-full ${darkMode ? 'bg-green-900/30' : 'bg-green-50'}`}>
                <Loader size={32} className="animate-spin text-green-500" />
              </div>
              <div className={`px-4 py-2 rounded-lg flex items-center gap-2 ${darkMode ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                <Shield size={16} />
                <span className="text-sm font-medium">Decrypting encrypted file...</span>
              </div>
              <p className="text-sm">
                {zkDecryptProgress.stage === 'downloading' && `Downloading chunk ${zkDecryptProgress.chunk}/${zkDecryptProgress.totalChunks}...`}
                {zkDecryptProgress.stage === 'decrypting' && `Decrypting chunk ${zkDecryptProgress.chunk}/${zkDecryptProgress.totalChunks}...`}
                {zkDecryptProgress.stage === 'complete' && 'Preparing preview...'}
              </p>
              <div className="w-48 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 transition-all duration-300"
                  style={{ width: `${zkDecryptProgress.progress || 0}%` }}
                />
              </div>
            </div>
          )}
          {/* ZK Session Locked */}
          {!zkDecryptProgress && zkSessionLocked && fatalError ? (
            <div className={`flex flex-col items-center text-center gap-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              <div className={`p-4 rounded-full ${darkMode ? 'bg-amber-900/30' : 'bg-amber-50'}`}>
                <Lock size={32} className="text-amber-500" />
              </div>
              <p className="mb-2">{fatalError}</p>
              <p className="text-sm">Unlock your session from the sidebar to view this file.</p>
            </div>
          ) : !zkDecryptProgress && loading && !isPdfFile ? (
            <div className={darkMode ? 'text-white' : 'text-gray-900'}>Loading preview...</div>
          ) : !zkDecryptProgress && fatalError ? (
            <div className={`flex flex-col items-center text-center gap-6 p-8 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              <div className={`p-4 rounded-full ${darkMode ? 'bg-amber-900/30' : 'bg-amber-50'}`}>
                <Loader size={32} className="text-amber-500" />
              </div>
              <div>
                <h3 className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {fatalError.includes('still processing') ? 'Video Still Processing' : 'Playback Issue'}
                </h3>
                <p className="text-sm max-w-md">{fatalError}</p>
              </div>
              {isVideoFile && (
                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <button
                    onClick={() => {
                      setFatalError(null);
                      setStreamReady(false);
                      setPreviewWarning('Checking video status...');
                    }}
                    className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors ${
                      darkMode
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-blue-500 hover:bg-blue-600 text-white'
                    }`}
                  >
                    <RotateCw size={18} />
                    Try Again
                  </button>
                  <a
                    href={downloadLink}
                    download={file.name}
                    className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors ${
                      darkMode
                        ? 'bg-gray-700 hover:bg-gray-600 text-white'
                        : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                    }`}
                  >
                    <Download size={18} />
                    Download Original
                  </a>
                </div>
              )}
              {!isVideoFile && (
                <p className="text-sm mt-2">Preview may not be available for this file type</p>
              )}
            </div>
          ) : isPdfFile ? (
            <div className="w-full h-full min-h-[70vh]">
              {isZKEncrypted && (
                <div className={`mb-4 px-4 py-2 rounded-lg flex items-center gap-2 mx-auto w-fit ${darkMode ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                  <Shield size={16} />
                  <span className="text-sm font-medium">Zero-Knowledge Encrypted</span>
                </div>
              )}
              <iframe
                src={isZKEncrypted && previewUrl ? previewUrl : applyToken(`${API_URL}/api/v1/files/${file.id}/download?inline=true`)}
                className="w-full h-full rounded-lg"
                style={{ minHeight: '70vh' }}
                title={file.name}
              />
            </div>
          ) : isExcelFile ? (
            <div className={`flex flex-col items-center justify-center text-center gap-6 p-8 ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              <div className={`p-6 rounded-2xl ${darkMode ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
                <Table size={64} className="text-emerald-600" />
              </div>
              <div>
                <h3 className={`text-xl font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Excel/Spreadsheet File
                </h3>
                <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Browser preview is not available for spreadsheet files.<br />
                  Download the file to view it in Excel or Google Sheets.
                </p>
              </div>
              <a
                href={downloadLink}
                download={file.name}
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
                  darkMode
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : 'bg-emerald-500 hover:bg-emerald-600 text-white'
                }`}
              >
                <Download size={20} />
                Download Spreadsheet
              </a>
            </div>
          ) : isXmlFile || isTextFile ? (
            <div className="w-full h-full min-h-[70vh]">
              {isZKEncrypted && (
                <div className={`mb-4 px-4 py-2 rounded-lg flex items-center gap-2 mx-auto w-fit ${darkMode ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                  <Shield size={16} />
                  <span className="text-sm font-medium">Zero-Knowledge Encrypted</span>
                </div>
              )}
              <iframe
                src={isZKEncrypted && previewUrl ? previewUrl : applyToken(`${API_URL}/api/v1/files/${file.id}/download?inline=true`)}
                className={`w-full h-full rounded-lg border ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
                style={{ minHeight: '70vh' }}
                title={file.name}
              />
            </div>
          ) : isVideoFile && isZKEncrypted ? (
            // ZK-encrypted video - use SecureVideoPlayer with client-side decryption
            <div className="flex w-full max-w-4xl flex-col items-center">
              {/* ZK Encryption Badge */}
              <div className={`mb-4 px-4 py-2 rounded-lg flex items-center gap-2 ${darkMode ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                <Shield size={16} />
                <span className="text-sm font-medium">Zero-Knowledge Encrypted</span>
              </div>

              <SecureVideoPlayer
                fileId={file.id}
                metadata={file}
                darkMode={darkMode}
                onClose={onClose}
                className="w-full"
              />
            </div>
          ) : isVideoFile ? (
            // Regular video - use server-side streaming
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
              <div className={`flex flex-col items-center text-center gap-6 p-8 ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                <div className={`p-6 rounded-2xl ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
                  <div className="h-16 w-16 rounded-full border-4 border-blue-500 border-t-transparent animate-spin" />
                </div>
                <div>
                  <h3 className={`text-xl font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Converting Video for Browser Playback
                  </h3>
                  <p className={`text-sm mb-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    {previewWarning || 'Preparing a browser-compatible stream...'}
                  </p>
                  <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    This may take a few minutes for large or high-resolution videos.
                    <br />
                    Playback will start automatically once ready.
                  </p>
                </div>
                <div className={`w-full max-w-xs border-t pt-4 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                  <p className={`text-xs mb-3 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    Can't wait? Download the original file to play locally:
                  </p>
                  <a
                    href={downloadLink}
                    download={file.name}
                    className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors ${
                      darkMode
                        ? 'bg-gray-700 hover:bg-gray-600 text-white'
                        : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                    }`}
                  >
                    <Download size={18} />
                    Download Original
                  </a>
                </div>
              </div>
            )
          ) : isAudioFile ? (
            // Audio file - use HTML5 audio player
            <div className={`flex flex-col items-center justify-center text-center gap-6 p-8 ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              {isZKEncrypted && (
                <div className={`px-4 py-2 rounded-lg flex items-center gap-2 ${darkMode ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                  <Shield size={16} />
                  <span className="text-sm font-medium">Zero-Knowledge Encrypted</span>
                </div>
              )}
              <div className={`p-6 rounded-2xl ${darkMode ? 'bg-pink-500/10' : 'bg-pink-50'}`}>
                <Music size={64} className="text-pink-500" />
              </div>
              <div>
                <h3 className={`text-xl font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {file.name}
                </h3>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {file.mime_type || 'Audio file'}
                </p>
              </div>
              <audio
                controls
                autoPlay={false}
                className="w-full max-w-md"
                src={isZKEncrypted && previewUrl ? previewUrl : streamUrl}
              >
                Your browser does not support the audio element.
              </audio>
            </div>
          ) : previewUrl ? (
            <div className="flex flex-col items-center">
              {isZKEncrypted && (
                <div className={`mb-4 px-4 py-2 rounded-lg flex items-center gap-2 ${darkMode ? 'bg-green-900/30 text-green-300' : 'bg-green-50 text-green-700'}`}>
                  <Shield size={16} />
                  <span className="text-sm font-medium">Zero-Knowledge Encrypted</span>
                </div>
              )}
              <img
                src={previewUrl}
                alt={file.name}
                style={{
                  transform: `scale(${zoom}) rotate(${rotation}deg)`,
                  transition: 'transform 0.3s ease'
                }}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) : (
            <div className={darkMode ? 'text-white' : 'text-gray-900'}>Preview not available</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FilePreview;
