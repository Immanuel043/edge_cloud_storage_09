/**
 * XSS Protection Utility
 * Sanitizes user input to prevent XSS attacks
 */

import React from 'react';

// Simple sanitization without external dependencies
export const sanitizeHTML = (html: string | null | undefined): string => {
  if (!html) return '';

  const element = document.createElement('div');
  element.textContent = html;
  return element.innerHTML;
};

// Sanitize file names (strip dangerous characters)
export const sanitizeFileName = (fileName: string | null | undefined): string => {
  if (!fileName) return '';

  return fileName
    .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_') // Replace dangerous chars with underscore
    .replace(/^\.+/, '') // Remove leading dots
    .trim();
};

// Validate and sanitize URLs
export const sanitizeURL = (url: string | null | undefined): string => {
  if (!url) return '';

  try {
    const parsed = new URL(url);
    // Only allow http(s) protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    return parsed.href;
  } catch {
    return '';
  }
};

// HTML escape map
type EscapeMap = {
  [key: string]: string;
};

// Escape special characters for safe display
export const escapeHTML = (str: string | null | undefined): string => {
  if (!str) return '';

  const map: EscapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };

  return String(str).replace(/[&<>"'/]/g, (char) => map[char] ?? char);
};

// Safe component props
interface SafeTextProps {
  children: React.ReactNode;
}

// Safe component for rendering user content
export const SafeText: React.FC<SafeTextProps> = ({ children }) => {
  if (!children) return null;
  return <span>{escapeHTML(String(children))}</span>;
};

export default {
  sanitizeHTML,
  sanitizeFileName,
  sanitizeURL,
  escapeHTML,
  SafeText,
};
