/**
 * XSS Protection Utility
 * Sanitizes user input to prevent XSS attacks
 */

// Simple sanitization without external dependencies
export const sanitizeHTML = (html) => {
  if (!html) return '';

  const element = document.createElement('div');
  element.textContent = html;
  return element.innerHTML;
};

// Sanitize file names (strip dangerous characters)
export const sanitizeFileName = (fileName) => {
  if (!fileName) return '';

  return fileName
    .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_') // Replace dangerous chars with underscore
    .replace(/^\.+/, '') // Remove leading dots
    .trim();
};

// Validate and sanitize URLs
export const sanitizeURL = (url) => {
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

// Escape special characters for safe display
export const escapeHTML = (str) => {
  if (!str) return '';

  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };

  return String(str).replace(/[&<>"'/]/g, (char) => map[char]);
};

// Safe component for rendering user content
export const SafeText = ({ children }) => {
  if (!children) return null;
  return <span>{escapeHTML(String(children))}</span>;
};

export default {
  sanitizeHTML,
  sanitizeFileName,
  sanitizeURL,
  escapeHTML,
  SafeText
};
