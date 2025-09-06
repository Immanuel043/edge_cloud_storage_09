import React from 'react';
import { File, Image, FileText, Video, Music, Archive, Code } from 'lucide-react';

export const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

export const formatDate = (dateString) => {
  return new Date(dateString).toLocaleDateString('en-US', {
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

export const getFileType = (fileName) => {
  const extension = fileName.toLowerCase().split('.').pop();
  
  const typeMap = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
    pdf: 'document', doc: 'document', docx: 'document',
    mp4: 'video', avi: 'video', mkv: 'video',
    mp3: 'audio', wav: 'audio',
    zip: 'archive', rar: 'archive',
    js: 'code', jsx: 'code', html: 'code', css: 'code'
  };
  
  return typeMap[extension] || 'file';
};

export const getFileIcon = (fileName, size = 24) => {
  const fileType = getFileType(fileName);
  
  const iconMap = {
    image: <Image size={size} className="text-green-500" />,
    document: <FileText size={size} className="text-blue-500" />,
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