import React, { useState, useEffect, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, Download, Table, Shield, Lock, Loader, Music } from 'lucide-react';
import { API_URL, ZK_SERVICE_URL } from '../../config/constants';
import { useAuth } from '../../contexts/AuthContext';
import { VIDEO_EXTENSIONS, EXCEL_EXTENSIONS, XML_EXTENSIONS, TEXT_EXTENSIONS, AUDIO_EXTENSIONS } from '../../utils/helpers';
import SecureVideoPlayer from './SecureVideoPlayer';
import { zkStorageService } from '../../services/zkStorageService';
import { isZKSessionUnlocked } from '../../services/zkEncryptionService';
import type { FilePreviewProps, ZKDecryptProgress, TranscodeProgressResponse } from './types';
import { getErrorMessage } from './types';
import { Modal, ModalHeader, ModalBody, IconButton, Button, buttonVariants, iconButtonVariants, Badge, Spinner, Progress } from '@/components/ui';

const FilePreview: React.FC<FilePreviewProps> = ({ file, onClose, darkMode }) => {
  const { isAuthenticated } = useAuth();
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

  const fetchAsBlob = async (url: string): Promise<string> => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  };

  // Use ZK service for ZK-encrypted files, normal service for others
  const serviceUrl = isZKEncrypted ? ZK_SERVICE_URL : API_URL;
  const apiPath = isZKEncrypted ? '/api/v1/zk/files' : '/api/v1/files';
  
  const downloadLink = isZKEncrypted
    ? `${serviceUrl}${apiPath}/${file.id}/download`
    : `${API_URL}/api/v1/files/${file.id}/download`;
  const streamUrl = isZKEncrypted
    ? `${serviceUrl}${apiPath}/${file.id}/download?inline=true${isVideoFile ? '&compatible=true' : ''}`
    : `${API_URL}/api/v1/files/${file.id}/download?inline=true${isVideoFile ? '&compatible=true' : ''}`;

  const [previewUrl, _setPreviewUrl] = useState<string>('');
  const previewUrlRef = useRef<string>('');
  const setPreviewUrl = (url: string): void => {
    // Revoke old blob URL if replacing
    if (previewUrlRef.current && previewUrlRef.current !== url) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = url;
    _setPreviewUrl(url);
  };
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
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = '';
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
    let retryCount = 0;
    const MAX_STREAM_RETRIES = 150;

    const clearTimer = (): void => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const scheduleRetry = (delay = 2000): void => {
      retryCount++;
      if (retryCount >= MAX_STREAM_RETRIES) {
        setPreviewWarning('Video stream preparation timed out. Try downloading the file instead.');
        return;
      }
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
        const progressUrl = `${API_URL}/api/v1/files/${file.id}/transcode/progress`;
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
    setPreviewUrl('');

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
        const result = await zkStorageService.previewZKFile(
          file.id,
          fileMetadata,
          (progress: Record<string, unknown>) => setZkDecryptProgress(progress as unknown as ZKDecryptProgress)
        );

        setPreviewUrl(result.blobUrl ?? '');
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

    // For non-ZK audio files, fetch the stream as a blob to avoid exposing URLs
    if (isAudioFile) {
      try {
        const blobUrl = await fetchAsBlob(streamUrl);
        setPreviewUrl(blobUrl);
        setLoading(false);
        return;
      } catch (err: unknown) {
        console.error('Failed to load audio as blob:', err);
        setPreviewFailure('Failed to load audio preview. Please try downloading the file.', { fatal: true });
        setLoading(false);
        return;
      }
    }

    // Normal PDFs should load the original document inline, not the thumbnail API.
    if (isPdfFile) {
      setLoading(false);
      return;
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
      } else if (response.status === 409) {
        setPreviewFailure(
          'Preview unavailable for this file. You can still stream or download it below.',
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

  /** Shared ZK badge — rendered in multiple content branches. */
  const zkBadge = isZKEncrypted ? (
    <Badge variant="success" size="md" className="mx-auto mb-4">
      <Shield className="h-3.5 w-3.5" />
      Zero-Knowledge Encrypted
    </Badge>
  ) : null;

  return (
    <Modal
      open={true}
      onClose={onClose}
      hideCloseButton
      className="!max-w-6xl"
    >
      {/* Custom header with toolbar */}
      <ModalHeader>
        <div className="min-w-0 flex-1">
          <h2 className="text-h3 text-fg truncate">{file.name}</h2>
          <p className="mt-0.5 text-body-sm text-fg-muted">{file.mime_type || 'Unknown type'}</p>
        </div>
        <div className="flex items-center gap-1">
          {!isVideoFile && (
            <>
              <IconButton variant="ghost" size="sm" onClick={handleZoomOut} aria-label="Zoom out" title="Zoom out">
                <ZoomOut />
              </IconButton>
              <span className="min-w-[3rem] text-center text-body-sm text-fg-muted">
                {Math.round(zoom * 100)}%
              </span>
              <IconButton variant="ghost" size="sm" onClick={handleZoomIn} aria-label="Zoom in" title="Zoom in">
                <ZoomIn />
              </IconButton>
              <IconButton variant="ghost" size="sm" onClick={handleRotate} aria-label="Rotate" title="Rotate">
                <RotateCw />
              </IconButton>
            </>
          )}
          {isVideoFile && (
            <a
              href={downloadLink}
              download={file.name}
              title="Download video"
              aria-label="Download video"
              className={iconButtonVariants({ variant: 'ghost', size: 'sm' })}
            >
              <Download className="h-4 w-4" />
            </a>
          )}
          <IconButton variant="ghost" size="sm" onClick={onClose} aria-label="Close preview" title="Close">
            <X />
          </IconButton>
        </div>
      </ModalHeader>

      {/* Content */}
      <ModalBody className="flex items-center justify-center min-h-[60vh]">
        {/* ZK Decryption Progress */}
        {zkDecryptProgress && (
          <div className="flex flex-col items-center text-center gap-4 text-fg-muted">
            <div className="rounded-full bg-success/10 p-4">
              <Spinner size="lg" className="text-success" />
            </div>
            <Badge variant="success" size="md">
              <Shield className="h-3.5 w-3.5" />
              Decrypting encrypted file…
            </Badge>
            <p className="text-body-sm">
              {zkDecryptProgress.stage === 'downloading' && `Downloading chunk ${zkDecryptProgress.chunk}/${zkDecryptProgress.totalChunks}…`}
              {zkDecryptProgress.stage === 'decrypting' && `Decrypting chunk ${zkDecryptProgress.chunk}/${zkDecryptProgress.totalChunks}…`}
              {zkDecryptProgress.stage === 'complete' && 'Preparing preview…'}
            </p>
            <Progress
              className="w-48"
              size="sm"
              tone="primary"
              value={zkDecryptProgress.progress || 0}
              label="Decryption progress"
            />
          </div>
        )}
        {/* ZK Session Locked */}
        {!zkDecryptProgress && zkSessionLocked && fatalError ? (
          <div className="flex flex-col items-center text-center gap-4 text-fg-muted">
            <div className="rounded-full bg-warning/10 p-4">
              <Lock className="h-8 w-8 text-warning" />
            </div>
            <p className="mb-2">{fatalError}</p>
            <p className="text-body-sm">Unlock your session from the sidebar to view this file.</p>
          </div>
        ) : !zkDecryptProgress && loading && !isPdfFile ? (
          <div className="flex items-center gap-3 text-fg">
            <Spinner size="md" />
            <span>Loading preview…</span>
          </div>
        ) : !zkDecryptProgress && fatalError ? (
          <div className="flex flex-col items-center text-center gap-6 p-8 text-fg-muted">
            <div className="rounded-full bg-warning/10 p-4">
              <Loader className="h-8 w-8 text-warning" />
            </div>
            <div>
              <h3 className="text-h3 text-fg mb-2">
                {fatalError.includes('still processing') ? 'Video Still Processing' : 'Playback Issue'}
              </h3>
              <p className="text-body-sm max-w-md">{fatalError}</p>
            </div>
            {isVideoFile && (
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <Button
                  variant="primary"
                  onClick={() => {
                    setFatalError(null);
                    setStreamReady(false);
                    setPreviewWarning('Checking video status...');
                  }}
                >
                  <RotateCw className="h-4 w-4" />
                  Try Again
                </Button>
                <a
                  href={downloadLink}
                  download={file.name}
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  <Download className="h-4 w-4" />
                  Download Original
                </a>
              </div>
            )}
            {!isVideoFile && (
              <p className="text-body-sm mt-2">Preview may not be available for this file type</p>
            )}
          </div>
        ) : isPdfFile ? (
          <div className="w-full h-full min-h-[70vh]">
            {zkBadge}
            {/* Only render iframe when we have a valid URL — avoids empty src warning */}
            {(previewUrl || !isZKEncrypted) && (
              <iframe
                src={isZKEncrypted ? previewUrl : `${API_URL}/api/v1/files/${file.id}/download?inline=true`}
                className="w-full h-full rounded-lg"
                style={{ minHeight: '70vh' }}
                title={file.name}
              />
            )}
            {isZKEncrypted && !previewUrl && (
              <div className="flex items-center justify-center h-full min-h-[70vh]">
                <Spinner size="lg" />
              </div>
            )}
          </div>
        ) : isExcelFile ? (
          <div className="flex flex-col items-center justify-center text-center gap-6 p-8 text-fg-muted">
            <div className="rounded-2xl bg-success/10 p-6">
              <Table className="h-16 w-16 text-success" />
            </div>
            <div>
              <h3 className="text-h3 text-fg mb-2">Excel/Spreadsheet File</h3>
              <p className="text-body-sm mb-4">
                Browser preview is not available for spreadsheet files.<br />
                Download the file to view it in Excel or Google Sheets.
              </p>
            </div>
            <a
              href={downloadLink}
              download={file.name}
              className={buttonVariants({ variant: 'primary' })}
            >
              <Download className="h-4 w-4" />
              Download Spreadsheet
            </a>
          </div>
        ) : isXmlFile || isTextFile ? (
          <div className="w-full h-full min-h-[70vh]">
            {zkBadge}
            {/* Only render iframe when we have a valid URL — avoids empty src warning */}
            {(previewUrl || !isZKEncrypted) && (
              <iframe
                src={previewUrl || `${API_URL}/api/v1/files/${file.id}/download?inline=true`}
                className="w-full h-full rounded-lg border border-border bg-surface"
                style={{ minHeight: '70vh' }}
                title={file.name}
              />
            )}
            {isZKEncrypted && !previewUrl && (
              <div className="flex items-center justify-center h-full min-h-[70vh]">
                <Spinner size="lg" />
              </div>
            )}
          </div>
        ) : isVideoFile && isZKEncrypted ? (
          // ZK-encrypted video — SecureVideoPlayer handles client-side decryption
          <div className="flex w-full max-w-4xl flex-col items-center">
            {zkBadge}
            <SecureVideoPlayer
              fileId={file.id}
              metadata={file}
              darkMode={darkMode}
              onClose={onClose}
              className="w-full"
            />
          </div>
        ) : isVideoFile ? (
          // Regular video — server-side streaming
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
                <p className="mt-4 text-body-sm text-warning">{previewWarning}</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center text-center gap-6 p-8 text-fg-muted">
              <div className="rounded-2xl bg-primary/10 p-6">
                <Spinner size="lg" className="text-primary" />
              </div>
              <div>
                <h3 className="text-h3 text-fg mb-2">Converting Video for Browser Playback</h3>
                <p className="text-body-sm mb-2">
                  {previewWarning || 'Preparing a browser-compatible stream…'}
                </p>
                <p className="text-caption text-fg-subtle">
                  This may take a few minutes for large or high-resolution videos.
                  <br />
                  Playback will start automatically once ready.
                </p>
              </div>
              <div className="w-full max-w-xs border-t border-border pt-4">
                <p className="text-caption text-fg-subtle mb-3">
                  Can&rsquo;t wait? Download the original file to play locally:
                </p>
                <a
                  href={downloadLink}
                  download={file.name}
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  <Download className="h-4 w-4" />
                  Download Original
                </a>
              </div>
            </div>
          )
        ) : isAudioFile ? (
          // Audio file — HTML5 audio player
          <div className="flex flex-col items-center justify-center text-center gap-6 p-8 text-fg-muted">
            {zkBadge}
            <div className="rounded-2xl bg-pink-500/10 p-6">
              <Music className="h-16 w-16 text-pink-500" />
            </div>
            <div>
              <h3 className="text-h3 text-fg mb-2">{file.name}</h3>
              <p className="text-body-sm">{file.mime_type || 'Audio file'}</p>
            </div>
            <audio
              controls
              autoPlay={false}
              className="w-full max-w-md"
              src={previewUrl || streamUrl}
            >
              Your browser does not support the audio element.
            </audio>
          </div>
        ) : previewUrl ? (
          <div className="flex flex-col items-center">
            {zkBadge}
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
          <div className="text-fg">Preview not available</div>
        )}
      </ModalBody>
    </Modal>
  );
};

export default FilePreview;
