import React from 'react';
import { File, Image, FileText, Video, Music, Archive, Code, Table, FileCode } from 'lucide-react';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff'];
export const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp'];
export const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'rtf', 'ppt', 'pptx'];
export const EXCEL_EXTENSIONS = ['xls', 'xlsx', 'csv'];
export const XML_EXTENSIONS = ['xml', 'xsl', 'xslt'];
export const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'yaml', 'yml', 'ini', 'conf', 'log'];
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];
export const ARCHIVE_EXTENSIONS = ['zip', 'rar', 'tar', 'gz', '7z'];
export const CODE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'py', 'sql', 'sh', 'rb', 'go', 'rs'];

export const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

export const formatDate = (dateString) => {
  if (!dateString) return '';

  let date;

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
    minute: '2-digit'
  });
};

export const formatDuration = (milliseconds) => {
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

export const getFileType = (fileName = '') => {
  const normalized = fileName.toLowerCase();
  const parts = normalized.split('.');
  if (parts.length < 2) return 'file';
  const extension = parts.pop();

  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (EXCEL_EXTENSIONS.includes(extension)) return 'excel';
  if (XML_EXTENSIONS.includes(extension)) return 'xml';
  if (TEXT_EXTENSIONS.includes(extension)) return 'text';
  if (DOCUMENT_EXTENSIONS.includes(extension)) return 'document';
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  if (ARCHIVE_EXTENSIONS.includes(extension)) return 'archive';
  if (CODE_EXTENSIONS.includes(extension)) return 'code';
  return 'file';
};

export const getFileIcon = (fileName, size = 24) => {
  const fileType = getFileType(fileName);

  const iconMap = {
    image: <Image size={size} className="text-green-500" />,
    document: <FileText size={size} className="text-blue-500" />,
    excel: <Table size={size} className="text-emerald-600" />,
    xml: <FileCode size={size} className="text-amber-500" />,
    text: <FileText size={size} className="text-gray-500" />,
    video: <Video size={size} className="text-purple-500" />,
    audio: <Music size={size} className="text-pink-500" />,
    archive: <Archive size={size} className="text-yellow-500" />,
    code: <Code size={size} className="text-orange-500" />,
    file: <File size={size} className="text-gray-400" />
  };

  return iconMap[fileType] || iconMap.file;
};

export const isImageFile = (fileName) => {
  return getFileType(fileName) === 'image';
};

export const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.replace(/[<>"']/g, '').trim();
};
