import React, { useState, useEffect, useRef } from 'react';
import { FileText, Film, FileImage, Music, Archive, File } from 'lucide-react';
import { API_URL } from '../../config/constants';

// File type to icon mapping
const getFileTypeIcon = (fileName, size = 48) => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const iconProps = { size, className: 'text-gray-400' };

  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    return <FileImage {...iconProps} />;
  }
  if (['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv'].includes(ext)) {
    return <Film {...iconProps} />;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(ext)) {
    return <FileText {...iconProps} />;
  }
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) {
    return <Music {...iconProps} />;
  }
  if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) {
    return <Archive {...iconProps} />;
  }
  return <File {...iconProps} />;
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
  const imgRef = useRef(null);
  const observerRef = useRef(null);

  // Determine if file type supports preview
  const supportsPreview = () => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const previewableTypes = [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',  // Images
      'pdf',  // PDFs
      'mp4', 'avi', 'mov', 'mkv', 'webm',  // Videos
      'docx', 'txt', 'md',  // Documents
      'py', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'xml', 'sql'  // Code
    ];
    return previewableTypes.includes(ext);
  };

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
    if (!isVisible || !supportsPreview()) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const controller = new AbortController();

    const loadThumbnail = async () => {
      try {
        setLoading(true);
        setError(false);

        const response = await fetch(
          `${API_URL}/files/${file.id}/preview?size=${size}`,
          {
            credentials: 'include',
            signal: controller.signal
          }
        );

        // If file not found (404), silently fall back to icon instead of showing error
        if (response.status === 404) {
          if (mounted) {
            setLoading(false);
            setError(false); // Don't show error state, just use fallback icon
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
        if (mounted && err.name !== 'AbortError') {
          setError(true);
          setLoading(false);
        }
      }
    };

    loadThumbnail();

    return () => {
      mounted = false;
      controller.abort();
      if (thumbnailUrl) {
        URL.revokeObjectURL(thumbnailUrl);
      }
    };
  }, [isVisible, file.id, size]);

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

  const containerClass = `${sizeClasses[size]} flex items-center justify-center rounded-lg overflow-hidden ${className}`;

  // Show loading state
  if (loading && supportsPreview()) {
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
      className={`${containerClass} ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}
    >
      {getFileTypeIcon(file.name, iconSizes[size])}
    </div>
  );
}
