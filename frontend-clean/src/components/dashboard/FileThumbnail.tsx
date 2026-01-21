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
    return <File size={size} className="text-gray-400" />;
  }
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const iconProps = { size };

  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileImage {...iconProps} className="text-green-500" />;
  }
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Film {...iconProps} className="text-purple-500" />;
  }
  if ((EXCEL_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Table {...iconProps} className="text-emerald-600" />;
  }
  if ((XML_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileCode {...iconProps} className="text-amber-500" />;
  }
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileText {...iconProps} className="text-gray-500" />;
  }
  if ((DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return <FileText {...iconProps} className="text-blue-500" />;
  }
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Music {...iconProps} className="text-pink-500" />;
  }
  if ((ARCHIVE_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Archive {...iconProps} className="text-yellow-500" />;
  }
  if ((CODE_EXTENSIONS as readonly string[]).includes(ext)) {
    return <Code {...iconProps} className="text-orange-500" />;
  }
  return <File {...iconProps} className="text-gray-400" />;
};

/**
 * FileThumbnail Component
 *
 * Displays file thumbnails with lazy loading and ZK decryption support.
 */
const FileThumbnail: React.FC<FileThumbnailProps> = ({
  file,
  size = 'medium',
  darkMode = false,
  className = '',
}) => {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

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

  // Load thumbnail when visible
  useEffect(() => {
    if (!isVisible || !canPreview) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const controller = new AbortController();

    // Timeout: 15s for videos, 8s for other files
    const timeoutMs = isVideoFile ? 15000 : 8000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const loadThumbnail = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(false);

        // Set a timeout to abort the request if it takes too long
        timeoutId = setTimeout(() => {
          if (mounted) {
            controller.abort();
            setLoading(false);
            setError(false);

            if (isVideoFile && retryCount < 2) {
              setTimeout(() => {
                if (mounted) {
                  setRetryCount((prev) => prev + 1);
                }
              }, 10000);
            }
          }
        }, timeoutMs);

        // Add cache-busting for video files
        const cacheBuster = isVideoFile ? `&_t=${file.updated_at || Date.now()}` : '';
        const fileId = file.id || file.file_id;

        // Determine if this is a ZK file
        const isZKFile = file.encrypted_file_key && file.file_key_iv;
        const baseUrl = isZKFile ? ZK_SERVICE_URL : API_URL;
        const apiPath = isZKFile ? '/api/v1/zk/files' : '/api/v1/files';

        const fetchUrl = `${baseUrl}${apiPath}/${fileId}/preview?size=${size}${cacheBuster}`;

        const response = await fetch(fetchUrl, {
          credentials: 'include',
          signal: controller.signal,
          cache: 'no-cache',
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

        // Handle 202 Accepted - preview is being generated
        if (response.status === 202) {
          if (mounted) {
            try {
              const data = (await response.json()) as { retry_after?: number; status?: string };
              const retryAfter = (data.retry_after || 5) * 1000;

              setIsProcessing(true);

              if (retryCount < 10) {
                setTimeout(() => {
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
              setIsProcessing(true);
              if (retryCount < 10) {
                setTimeout(() => {
                  if (mounted) {
                    setRetryCount((prev) => prev + 1);
                  }
                }, 5000);
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
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      controller.abort();
      if (thumbnailUrl) {
        URL.revokeObjectURL(thumbnailUrl);
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
    thumbnailUrl,
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
        className={`${containerClass} ${darkMode ? 'bg-gray-800' : 'bg-gray-100'} animate-pulse`}
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
        className={`${containerClass} ${darkMode ? 'bg-gray-800' : 'bg-gray-100'} relative`}
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
      className={`${containerClass} ${darkMode ? 'bg-gray-800' : 'bg-gray-100'} relative`}
    >
      {getFileTypeIcon(fileName, iconSizes[size])}

      {/* Processing indicator overlay */}
      {isProcessing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 rounded-lg">
          <Loader2
            className="text-blue-400 animate-spin"
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

export default FileThumbnail;
