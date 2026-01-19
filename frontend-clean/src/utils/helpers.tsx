import { File, Image, FileText, Video, Music, Archive, Code, Table, FileCode } from 'lucide-react';
import type { JSX } from 'react';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp'] as const;
export const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'rtf', 'ppt', 'pptx'] as const;
export const EXCEL_EXTENSIONS = ['xls', 'xlsx', 'csv'] as const;
export const XML_EXTENSIONS = ['xml', 'xsl', 'xslt'] as const;
export const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'yaml', 'yml', 'ini', 'conf', 'log'] as const;
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] as const;
export const ARCHIVE_EXTENSIONS = ['zip', 'rar', 'tar', 'gz', '7z'] as const;
export const CODE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'py', 'sql', 'sh', 'rb', 'go', 'rs'] as const;

export type FileType = 'image' | 'video' | 'document' | 'excel' | 'xml' | 'text' | 'audio' | 'archive' | 'code' | 'file';

export const formatBytes = (bytes: number | null | undefined): string => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // Calculate the value in the current unit
  const value = bytes / Math.pow(k, i);

  // If we're in MB and the value is >= 1000 MB (close to 1 GB), show in GB instead
  if (sizes[i] === 'MB' && value >= 1000) {
    return `${parseFloat((bytes / Math.pow(k, 3)).toFixed(1))} GB`;
  }

  // Use 1 decimal place for better readability
  // Show 2 decimals for very small values (< 10), otherwise 1 decimal
  const decimals = value < 10 ? 2 : 1;
  return `${parseFloat(value.toFixed(decimals))} ${sizes[i] ?? 'B'}`;
};

export const formatDate = (dateString: string | number | Date | null | undefined): string => {
  if (!dateString) return '';

  let date: Date;

  // Backend sends UTC time - ensure it's interpreted as UTC
  if (typeof dateString === 'string') {
    // If the date string doesn't have timezone info, append 'Z' to indicate UTC
    if (!dateString.endsWith('Z') && !dateString.includes('+') && !/T\d{2}:\d{2}:\d{2}-/.test(dateString)) {
      date = new Date(dateString + 'Z');
    } else {
      date = new Date(dateString);
    }
  } else {
    date = new Date(dateString);
  }

  // Convert UTC to user's local timezone for display
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

export const getFileType = (fileName = ''): FileType => {
  const normalized = fileName.toLowerCase();
  const parts = normalized.split('.');
  if (parts.length < 2) return 'file';
  const extension = parts.pop();

  if (!extension) return 'file';

  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video';
  if ((EXCEL_EXTENSIONS as readonly string[]).includes(extension)) return 'excel';
  if ((XML_EXTENSIONS as readonly string[]).includes(extension)) return 'xml';
  if ((TEXT_EXTENSIONS as readonly string[]).includes(extension)) return 'text';
  if ((DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) return 'document';
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(extension)) return 'audio';
  if ((ARCHIVE_EXTENSIONS as readonly string[]).includes(extension)) return 'archive';
  if ((CODE_EXTENSIONS as readonly string[]).includes(extension)) return 'code';
  return 'file';
};

export const getFileIcon = (fileName: string, size = 24): JSX.Element => {
  const fileType = getFileType(fileName);

  const iconMap: Record<FileType, JSX.Element> = {
    image: <Image size={size} className="text-green-500" />,
    document: <FileText size={size} className="text-blue-500" />,
    excel: <Table size={size} className="text-emerald-600" />,
    xml: <FileCode size={size} className="text-amber-500" />,
    text: <FileText size={size} className="text-gray-500" />,
    video: <Video size={size} className="text-purple-500" />,
    audio: <Music size={size} className="text-pink-500" />,
    archive: <Archive size={size} className="text-yellow-500" />,
    code: <Code size={size} className="text-orange-500" />,
    file: <File size={size} className="text-gray-400" />,
  };

  return iconMap[fileType] ?? iconMap.file;
};

export const isImageFile = (fileName: string): boolean => {
  return getFileType(fileName) === 'image';
};

export const sanitizeInput = (input: unknown): unknown => {
  if (typeof input !== 'string') return input;
  return input.replace(/[<>"']/g, '').trim();
};
