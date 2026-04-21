import React, { useState, useEffect, useRef } from 'react';
import {
  FileText,
  Film,
  FileImage,
  Music,
  Archive,
  File,
  Table,
  FileCode,
  Code,
  Loader2,
} from 'lucide-react';
import { API_URL, ZK_SERVICE_URL } from '../../config/constants';
import websocketService from '../../services/websocketService';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  EXCEL_EXTENSIONS,
  XML_EXTENSIONS,
  TEXT_EXTENSIONS,
  AUDIO_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  CODE_EXTENSIONS,
} from '../../utils/helpers';
import { decryptThumbnail, createThumbnailUrl } from '../../utils/zkThumbnails';
import { prepareFileForDecryption, isZKSessionUnlocked } from '../../services/zkEncryptionService';
import { bytesToBase64 } from '../../utils/zkCryptoV2';
import type { FileThumbnailProps, ThumbnailSize } from './types';

/**
 * Get file type icon based on file extension
 */
const getFileTypeIcon = (fileName: string | undefined, size: number = 48): React.ReactElement => {
  if (!fileName) {
    return <File size={size} className="text-fg-subtle" />;
  }
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const iconProps = { size };

  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileImage {...iconProps} className="text-success" />;
  }
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Film {...iconProps} className="text-accent" />;
  }
  if ((EXCEL_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Table {...iconProps} className="text-success" />;
  }
  if ((XML_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileCode {...iconProps} className="text-warning" />;
  }
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileText {...iconProps} className="text-fg-muted" />;
  }
  if ((DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileText {...iconProps} className="text-primary" />;
  }
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Music {...iconProps} className="text-accent" />;
  }
  if ((ARCHIVE_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Archive {...iconProps} className="text-warning" />;
  }
  if ((CODE_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Code {...iconProps} className="text-warning" />;
  }
  return <File {...iconProps} className="text-fg-subtle" />;
};

/**
 * FileThumbnail Component
 *
 * Displays file thumbnails with lazy loading and ZK decryption support.
 */
const FileThumbnailInner: React.FC<FileThumbnailProps> = ({
  file,
  size = 'medium',
  className = '',
}) => {
  const [thumbnailUrl, _setThumbnailUrl] = useState<string | null>(null);
  const thumbnailUrlRef = useRef<string | null>(null);
  const setThumbnailUrl = (url: string | null): void => {
    // Revoke old blob URL when replacing
    if (thumbnailUrlRef.current && thumbnailUrlRef.current !== url) {
      URL.revokeObjectURL(thumbnailUrlRef.current);
    }
    thumbnailUrlRef.current = url;
    _setThumbnailUrl(url);
  };
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const abortCountRef = useRef<number>(0);
  const wsReadyRef = useRef<boolean>(false);
  const processingStartRef = useRef<number>(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetryTimer = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  // Derive file name from various possible sources
  const fileName = file.name || file.file_name || 'Unknown File';
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const mimeType = (file.mime_type || '').toLowerCase();
  const isVideoFile =
    mimeType.startsWith('video/') || (VIDEO_EXTENSIONS as readonly string[]).includes(extension);
  const isImageFileType =
    mimeType.startsWith('image/') || (IMAGE_EXTENSIONS as readonly string[]).includes(extension);
  const isPdfFile = mimeType === 'application/pdf' || extension === 'pdf';

  // Only images, videos, and PDFs can have generated thumbnails
  const canHaveThumbnail = isImageFileType || isVideoFile || isPdfFile;
  const canPreview = file?.allow_preview !== false && canHaveThumbnail;

  // Lazy loading with Intersection Observer
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observerRef.current?.disconnect();
          }
        });
      },
      { threshold: 0.1, rootMargin: '50px' }
    );

    if (imgRef.current) {
      observerRef.current.observe(imgRef.current);
    }

    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  // Subscribe to WebSocket push notifications for preview readiness
  useEffect(() => {
    if (!canPreview) return;

    const fileId = file.id || file.file_id;
    if (!fileId) return;

    console.log(`[FileThumbnail] WS subscription active for file ${fileId}`);
    const unsubscribe = websocketService.on('preview_ready', (data: unknown) => {
      const msg = data as { file_id?: string; status?: string };
      console.log(`[FileThumbnail] WS preview_ready received:`, msg, `expecting fileId=${fileId}`);
      if (msg.file_id !== fileId) return;

      console.log(`[FileThumbnail] Match! Bumping retryCount for file ${fileId}, status=${msg.status}`);
      if (msg.status === 'ready') {
        clearRetryTimer();
        wsReadyRef.current = true;
        abortCountRef.current = 0;
        setRetryCount((prev) => prev + 1);
      } else if (msg.status === 'failed') {
        clearRetryTimer();
        setIsProcessing(false);
        setLoading(false);
      }
    });

    return unsubscribe;
  }, [file.id, file.file_id, canPreview]);

  // Load thumbnail when visible
  useEffect(() => {
    if (!isVisible || !canPreview) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const controller = new AbortController();

    const MAX_ABORT_RETRIES = 5;
    const baseTimeout = isVideoFile ? 15000 : 8000;
    const timeoutMs = wsReadyRef.current ? baseTimeout * 2 : baseTimeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const loadThumbnail = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(false);

        timeoutId = setTimeout(() => {
          if (mounted) {
            controller.abort();
            setLoading(false);
            setError(false);
            abortCountRef.current += 1;

            const shouldRetry =
              wsReadyRef.current || abortCountRef.current <= MAX_ABORT_RETRIES;

            if (shouldRetry) {
              const delay = wsReadyRef.current
                ? 2000
                : Math.min(5000 * abortCountRef.current, 30000);
              clearRetryTimer();
              retryTimerRef.current = setTimeout(() => {
                if (mounted) setRetryCount((prev) => prev + 1);
              }, delay);
            } else {
              setIsProcessing(false);
            }
          }
        }, timeoutMs);

        const cacheBuster = `&_t=${file.updated_at || Date.now()}&_r=${retryCount}`;
        const fileId = file.id || file.file_id;

        // Determine if this is a ZK file
        const isZKFile = file.encrypted_file_key && file.file_key_iv;
        const baseUrl = isZKFile ? ZK_SERVICE_URL : API_URL;
        const apiPath = isZKFile ? '/api/v1/zk/files' : '/api/v1/files';

        const fetchUrl = `${baseUrl}${apiPath}/${fileId}/preview?size=${size}${cacheBuster}`;

        const response = await fetch(fetchUrl, {
          credentials: 'include',
          signal: controller.signal,
          cache: 'no-store',
        });

        // Clear timeout on successful response
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // If file not found, silently fall back to icon
        if (response.status === 404) {
          if (mounted) {
            setLoading(false);
            setError(false);
          }
          return;
        }

        // Handle 409 - terminal preview failure (non-retryable)
        if (response.status === 409) {
          if (mounted) {
            clearRetryTimer();
            setIsProcessing(false);
            setLoading(false);
            setError(false);
          }
          return;
        }

        // Handle 202 Accepted - preview is being generated
        if (response.status === 202) {
          if (mounted) {
            const wsConnected = websocketService.isConnected;
            const maxRetries = 60;

            try {
              const data = (await response.json()) as {
                retry_after?: number;
                estimated_wait_seconds?: number;
                status?: string;
              };

              // Backend may send 202 with status=failed body
              if (data.status === 'failed') {
                clearRetryTimer();
                setIsProcessing(false);
                setLoading(false);
                return;
              }

              // Use backend-provided estimate for adaptive polling (backward-compatible)
              const estimatedWait = data.estimated_wait_seconds || data.retry_after || 5;
              const isFirstPoll = !processingStartRef.current;

              let retryAfter: number;
              if (wsConnected) {
                // WS push is primary; poll at estimated wait as safety net
                retryAfter = Math.max(estimatedWait * 1000, 10000);
              } else {
                // No WS: start at 50% of estimate (min 5s), then backoff
                retryAfter = isFirstPoll
                  ? Math.max(estimatedWait * 500, 5000)
                  : Math.min((retryCount + 1) * 5000, estimatedWait * 1000);
              }

              abortCountRef.current = 0;
              if (!processingStartRef.current) {
                processingStartRef.current = Date.now();
              }

              const MAX_PROCESSING_MS = 5 * 60 * 1000;
              if (processingStartRef.current &&
                  Date.now() - processingStartRef.current > MAX_PROCESSING_MS) {
                setIsProcessing(false);
                setLoading(false);
                return;
              }

              setIsProcessing(true);

              if (retryCount < maxRetries) {
                clearRetryTimer();
                retryTimerRef.current = setTimeout(() => {
                  if (mounted) {
                    setRetryCount((prev) => prev + 1);
                  }
                }, retryAfter);
              } else {
                setIsProcessing(false);
              }

              setLoading(false);
              setError(false);
            } catch {
              // JSON parse failed — use safe defaults
              abortCountRef.current = 0;
              if (!processingStartRef.current) {
                processingStartRef.current = Date.now();
              }

              const MAX_PROCESSING_MS = 5 * 60 * 1000;
              if (processingStartRef.current &&
                  Date.now() - processingStartRef.current > MAX_PROCESSING_MS) {
                setIsProcessing(false);
                setLoading(false);
                return;
              }

              const fallbackInterval = websocketService.isConnected ? 10000 : 5000;
              setIsProcessing(true);
              if (retryCount < maxRetries) {
                clearRetryTimer();
                retryTimerRef.current = setTimeout(() => {
                  if (mounted) {
                    setRetryCount((prev) => prev + 1);
                  }
                }, fallbackInterval);
              } else {
                setIsProcessing(false);
              }
              setLoading(false);
              setError(false);
            }
          }
          return;
        }

        if (!response.ok) {
          throw new Error('Failed to load thumbnail');
        }

        // Check if this is a ZK encrypted thumbnail
        const isZKEncrypted = response.headers.get('X-ZK-Encrypted') === '1';

        if (isZKEncrypted) {
          // Handle ZK encrypted thumbnail - decrypt client-side
          try {
            if (!isZKSessionUnlocked()) {
              if (mounted) {
                setLoading(false);
                setError(false);
              }
              return;
            }

            const thumbnailIV = response.headers.get('X-ZK-Thumbnail-IV');
            if (!thumbnailIV) {
              throw new Error('Missing thumbnail IV');
            }

            // Get encrypted thumbnail data
            const encryptedData = await response.arrayBuffer();
            const encryptedBase64 = bytesToBase64(new Uint8Array(encryptedData));

            // Decrypt the file key first
            if (!file.encrypted_file_key || !file.file_key_iv) {
              if (mounted) {
                setLoading(false);
                setError(false);
              }
              return;
            }

            const fileKey = prepareFileForDecryption(file.encrypted_file_key, file.file_key_iv);
            if (!fileKey) {
              throw new Error('Failed to decrypt file key');
            }

            // Decrypt the thumbnail
            const decryptedThumbnail = decryptThumbnail(encryptedBase64, thumbnailIV, fileKey);

            if (mounted) {
              const url = createThumbnailUrl(decryptedThumbnail);
              setThumbnailUrl(url);
              setLoading(false);
              setIsProcessing(false);
              abortCountRef.current = 0;
              wsReadyRef.current = false;
              processingStartRef.current = 0;
            }
          } catch (zkError: unknown) {
            console.warn(
              'ZK thumbnail decryption failed:',
              zkError instanceof Error ? zkError.message : 'Unknown error'
            );
            if (mounted) {
              setLoading(false);
              setError(false);
            }
          }
        } else {
          // Regular (non-ZK) thumbnail
          const blob = await response.blob();
          if (mounted) {
            const url = URL.createObjectURL(blob);
            setThumbnailUrl(url);
            setLoading(false);
            setIsProcessing(false);
            abortCountRef.current = 0;
            wsReadyRef.current = false;
            processingStartRef.current = 0;
          }
        }
      } catch (err: unknown) {
        // Clear timeout on error
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (mounted && err instanceof Error && err.name !== 'AbortError') {
          setError(true);
          setLoading(false);
        } else if (mounted) {
          setLoading(false);
          setError(false);
        }
      }
    };

    loadThumbnail();

    return () => {
      mounted = false;
      clearRetryTimer();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      controller.abort();
      if (thumbnailUrlRef.current) {
        URL.revokeObjectURL(thumbnailUrlRef.current);
        thumbnailUrlRef.current = null;
      }
    };
  }, [
    isVisible,
    file.id,
    size,
    isVideoFile,
    fileName,
    file.updated_at,
    retryCount,
    file.encrypted_file_key,
    file.file_key_iv,
    canPreview,
    file.file_id,
    // Note: thumbnailUrl removed from dependencies - it was causing re-renders
    // The cleanup function still has access to it via closure
  ]);

  // Size mapping
  const sizeClasses: Record<ThumbnailSize, string> = {
    small: 'w-12 h-12',
    medium: 'w-24 h-24',
    large: 'w-32 h-32',
  };

  const iconSizes: Record<ThumbnailSize, number> = {
    small: 24,
    medium: 48,
    large: 64,
  };

  const containerClass = `${sizeClasses[size]} relative flex items-center justify-center rounded-lg overflow-hidden ${className}`;

  // Show loading state
  if (loading && canPreview) {
    return (
      <div
        ref={imgRef}
        className={`${containerClass} bg-surface-muted animate-pulse`}
      >
        <div className="w-full h-full flex items-center justify-center">
          {getFileTypeIcon(fileName, iconSizes[size] / 2)}
        </div>
      </div>
    );
  }

  // Show thumbnail if loaded
  if (thumbnailUrl && !error) {
    return (
      <div
        ref={imgRef}
        className={`${containerClass} bg-surface-muted relative`}
      >
        <img
          src={thumbnailUrl}
          alt={fileName}
          className="w-full h-full object-cover"
          onError={() => setError(true)}
        />
        {/* Processing indicator overlay on thumbnail */}
        {isProcessing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded-lg">
            <Loader2
              className="text-white animate-spin"
              size={size === 'small' ? 12 : size === 'medium' ? 20 : 28}
            />
          </div>
        )}
      </div>
    );
  }

  // Fallback to icon with optional processing indicator
  return (
    <div
      ref={imgRef}
      className={`${containerClass} bg-surface-muted relative`}
    >
      {getFileTypeIcon(fileName, iconSizes[size])}

      {/* Processing indicator overlay */}
      {isProcessing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 rounded-lg">
          <Loader2
            className="text-primary animate-spin"
            size={size === 'small' ? 16 : size === 'medium' ? 24 : 32}
          />
          {size !== 'small' && (
            <span className="text-white text-xs mt-1 font-medium">Processing</span>
          )}
        </div>
      )}
    </div>
  );
};

// Memoize to prevent re-renders when parent refreshes file list
const FileThumbnail = React.memo(FileThumbnailInner, (prevProps, nextProps) => {
  // Only re-render if these specific props actually change
  return (
    prevProps.file.id === nextProps.file.id &&
    prevProps.file.updated_at === nextProps.file.updated_at &&
    prevProps.size === nextProps.size &&
    prevProps.className === nextProps.className
  );
});

export default FileThumbnail;
