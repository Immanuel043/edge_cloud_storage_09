import { useState, useEffect, useRef } from 'react';
import { FileText, Film, FileImage, Music, Archive, File, Table, FileCode, Code } from 'lucide-react';
import { API_URL } from '../../config/constants';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  EXCEL_EXTENSIONS,
  XML_EXTENSIONS,
  TEXT_EXTENSIONS,
  AUDIO_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  CODE_EXTENSIONS
} from '../../utils/helpers';

// File type to icon mapping
const getFileTypeIcon = (fileName, size = 48) => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const iconProps = { size };

  if (IMAGE_EXTENSIONS.includes(ext)) {
    return <FileImage {...iconProps} className="text-green-500" />;
  }
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return <Film {...iconProps} className="text-purple-500" />;
  }
  if (EXCEL_EXTENSIONS.includes(ext)) {
    return <Table {...iconProps} className="text-emerald-600" />;
  }
  if (XML_EXTENSIONS.includes(ext)) {
    return <FileCode {...iconProps} className="text-amber-500" />;
  }
  if (TEXT_EXTENSIONS.includes(ext)) {
    return <FileText {...iconProps} className="text-gray-500" />;
  }
  if (DOCUMENT_EXTENSIONS.includes(ext)) {
    return <FileText {...iconProps} className="text-blue-500" />;
  }
  if (AUDIO_EXTENSIONS.includes(ext)) {
    return <Music {...iconProps} className="text-pink-500" />;
  }
  if (ARCHIVE_EXTENSIONS.includes(ext)) {
    return <Archive {...iconProps} className="text-yellow-500" />;
  }
  if (CODE_EXTENSIONS.includes(ext)) {
    return <Code {...iconProps} className="text-orange-500" />;
  }
  return <File {...iconProps} className="text-gray-400" />;
};

export default function FileThumbnail({
  file,
  size = 'medium',  // small, medium, large
  darkMode = false,
  className = ''
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const imgRef = useRef(null);
  const observerRef = useRef(null);

  const extension = file.name?.split('.').pop()?.toLowerCase() || '';
  const mimeType = (file.mime_type || '').toLowerCase();
  const isVideoFile = mimeType.startsWith('video/') || VIDEO_EXTENSIONS.includes(extension);
  const isImageFile = mimeType.startsWith('image/') || IMAGE_EXTENSIONS.includes(extension);
  const isPdfFile = mimeType === 'application/pdf' || extension === 'pdf';

  // Only images, videos, and PDFs can have generated thumbnails
  const canHaveThumbnail = isImageFile || isVideoFile || isPdfFile;
  const canPreview = file?.allow_preview !== false && canHaveThumbnail;

  // Lazy loading with Intersection Observer
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
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

    // Timeout: 15s for videos (they take longer), 8s for other files
    const timeoutMs = isVideoFile ? 15000 : 8000;
    let timeoutId = null;

    const loadThumbnail = async () => {
      try {
        setLoading(true);
        setError(false);

        // Set a timeout to abort the request if it takes too long
        timeoutId = setTimeout(() => {
          if (mounted) {
            console.log(`Thumbnail timeout for ${file.name} after ${timeoutMs}ms`);
            controller.abort();
            setLoading(false);
            setError(false); // Don't show error, just use fallback icon

            // For video files, schedule a retry after 10 seconds (preview might be generating)
            if (isVideoFile && retryCount < 2) {
              setTimeout(() => {
                if (mounted) {
                  setRetryCount(prev => prev + 1);
                }
              }, 10000);
            }
          }
        }, timeoutMs);

        // Add cache-busting for video files to ensure fresh thumbnails
        const cacheBuster = isVideoFile ? `&_t=${file.updated_at || Date.now()}` : '';
        const response = await fetch(
          `${API_URL}/files/${file.id}/preview?size=${size}${cacheBuster}`,
          {
            credentials: 'include',
            signal: controller.signal,
            cache: 'no-cache'  // Prevent browser caching stale thumbnails
          }
        );

        // Clear timeout on successful response
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // If file not found (404), silently fall back to icon instead of showing error
        if (response.status === 404) {
          if (mounted) {
            setLoading(false);
            setError(false); // Don't show error state, just use fallback icon
          }
          return;
        }

        // Handle 202 Accepted - preview is being generated in background
        if (response.status === 202) {
          if (mounted) {
            try {
              const data = await response.json();
              const retryAfter = (data.retry_after || 5) * 1000; // Convert to ms

              console.log(`Preview ${data.status} for ${file.name}, retrying in ${retryAfter/1000}s`);

              // Schedule retry after the suggested delay
              if (retryCount < 5) { // Allow up to 5 retries for background processing
                setTimeout(() => {
                  if (mounted) {
                    setRetryCount(prev => prev + 1);
                  }
                }, retryAfter);
              }

              setLoading(false);
              setError(false); // Show fallback icon while waiting
            } catch (e) {
              // If JSON parsing fails, just use default retry
              if (retryCount < 5) {
                setTimeout(() => {
                  if (mounted) {
                    setRetryCount(prev => prev + 1);
                  }
                }, 5000);
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

        const blob = await response.blob();
        if (mounted) {
          const url = URL.createObjectURL(blob);
          setThumbnailUrl(url);
          setLoading(false);
        }
      } catch (err) {
        // Clear timeout on error
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (mounted && err.name !== 'AbortError') {
          setError(true);
          setLoading(false);
        } else if (mounted && err.name === 'AbortError') {
          // Timeout or manual abort - don't show error, just use fallback icon
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
  }, [isVisible, file.id, size, isVideoFile, file.name, file.updated_at, retryCount]);

  // Size mapping
  const sizeClasses = {
    small: 'w-12 h-12',
    medium: 'w-24 h-24',
    large: 'w-32 h-32'
  };

  const iconSizes = {
    small: 24,
    medium: 48,
    large: 64
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
          {getFileTypeIcon(file.name, iconSizes[size] / 2)}
        </div>
      </div>
    );
  }

  // Show thumbnail if loaded
  if (thumbnailUrl && !error) {
    return (
      <div ref={imgRef} className={`${containerClass} ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>
        <img
          src={thumbnailUrl}
          alt={file.name}
          className="w-full h-full object-cover"
          onError={() => setError(true)}
        />
      </div>
    );
  }

  // Fallback to icon
  return (
    <div
      ref={imgRef}
      className={`${containerClass} ${darkMode ? 'bg-gray-800' : 'bg-gray-100'} relative`}
    >
      {getFileTypeIcon(file.name, iconSizes[size])}
    </div>
  );
}
