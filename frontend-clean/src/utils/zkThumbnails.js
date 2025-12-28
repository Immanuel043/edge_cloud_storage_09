/**
 * Zero-Knowledge Thumbnail Pipeline
 *
 * Generates thumbnails client-side and encrypts them with file-specific keys.
 * Server NEVER sees plaintext thumbnails.
 *
 * Supported formats:
 * - Images: JPEG, PNG, GIF, WebP, BMP
 * - Videos: MP4, WebM (using video element)
 * - PDFs: First page (using pdf.js if available)
 */

import { deriveThumbnailKey, encryptAESGCM, decryptAESGCM, bytesToBase64, base64ToBytes } from './zkCryptoV2.js';

// Thumbnail configuration
const THUMBNAIL_CONFIG = {
  maxWidth: 256,
  maxHeight: 256,
  quality: 0.8,      // JPEG quality (0-1)
  format: 'image/jpeg',
};

/**
 * Generate and encrypt a thumbnail for a file
 * @param {File} file - Source file
 * @param {Uint8Array} fileKey - File encryption key (from HKDF)
 * @returns {Promise<Object|null>} { encryptedThumbnail, iv, width, height } or null
 */
export async function generateEncryptedThumbnail(file, fileKey) {
  try {
    let thumbnailData;

    if (file.type.startsWith('image/')) {
      thumbnailData = await generateImageThumbnail(file);
    } else if (file.type.startsWith('video/')) {
      thumbnailData = await generateVideoThumbnail(file);
    } else if (file.type === 'application/pdf') {
      thumbnailData = await generatePdfThumbnail(file);
    } else {
      // No thumbnail for this file type
      return null;
    }

    if (!thumbnailData) return null;

    // Derive thumbnail-specific key
    const thumbKey = deriveThumbnailKey(fileKey);

    // Encrypt the thumbnail
    const { ciphertext, iv, tag } = encryptAESGCM(thumbnailData.data, thumbKey);

    // Combine ciphertext and tag
    const encrypted = new Uint8Array(ciphertext.length + tag.length);
    encrypted.set(ciphertext);
    encrypted.set(tag, ciphertext.length);

    return {
      encryptedThumbnail: bytesToBase64(encrypted),
      iv: bytesToBase64(iv),
      width: thumbnailData.width,
      height: thumbnailData.height,
      format: THUMBNAIL_CONFIG.format,
    };
  } catch (error) {
    console.warn('Thumbnail generation failed:', error.message);
    return null;
  }
}

/**
 * Generate thumbnail from image file
 * @param {File} file
 * @returns {Promise<Object>} { data: Uint8Array, width, height }
 */
async function generateImageThumbnail(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const { width, height } = calculateDimensions(
          img.width,
          img.height,
          THUMBNAIL_CONFIG.maxWidth,
          THUMBNAIL_CONFIG.maxHeight
        );

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          async (blob) => {
            if (!blob) {
              reject(new Error('Failed to create thumbnail blob'));
              return;
            }

            const arrayBuffer = await blob.arrayBuffer();
            resolve({
              data: new Uint8Array(arrayBuffer),
              width,
              height,
            });
          },
          THUMBNAIL_CONFIG.format,
          THUMBNAIL_CONFIG.quality
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for thumbnail'));
    };

    img.src = url;
  });
}

/**
 * Generate thumbnail from video file
 * @param {File} file
 * @returns {Promise<Object>} { data: Uint8Array, width, height }
 */
async function generateVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      // Seek to 1 second or 10% of video, whichever is smaller
      const seekTime = Math.min(1, video.duration * 0.1);
      video.currentTime = seekTime;
    };

    video.onseeked = () => {
      try {
        const { width, height } = calculateDimensions(
          video.videoWidth,
          video.videoHeight,
          THUMBNAIL_CONFIG.maxWidth,
          THUMBNAIL_CONFIG.maxHeight
        );

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, width, height);

        canvas.toBlob(
          async (blob) => {
            if (!blob) {
              reject(new Error('Failed to create video thumbnail blob'));
              return;
            }

            const arrayBuffer = await blob.arrayBuffer();
            resolve({
              data: new Uint8Array(arrayBuffer),
              width,
              height,
            });
          },
          THUMBNAIL_CONFIG.format,
          THUMBNAIL_CONFIG.quality
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load video for thumbnail'));
    };

    video.src = url;
    video.load();
  });
}

/**
 * Generate thumbnail from PDF file
 * Requires pdf.js to be loaded
 * @param {File} file
 * @returns {Promise<Object|null>}
 */
async function generatePdfThumbnail(file) {
  // Check if pdf.js is available
  if (typeof window.pdfjsLib === 'undefined') {
    console.warn('pdf.js not loaded, skipping PDF thumbnail');
    return null;
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      THUMBNAIL_CONFIG.maxWidth / viewport.width,
      THUMBNAIL_CONFIG.maxHeight / viewport.height
    );

    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    const ctx = canvas.getContext('2d');
    await page.render({
      canvasContext: ctx,
      viewport: scaledViewport,
    }).promise;

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async (blob) => {
          if (!blob) {
            reject(new Error('Failed to create PDF thumbnail blob'));
            return;
          }

          const arrayBuffer = await blob.arrayBuffer();
          resolve({
            data: new Uint8Array(arrayBuffer),
            width: canvas.width,
            height: canvas.height,
          });
        },
        THUMBNAIL_CONFIG.format,
        THUMBNAIL_CONFIG.quality
      );
    });
  } catch (error) {
    console.warn('PDF thumbnail generation failed:', error.message);
    return null;
  }
}

/**
 * Calculate thumbnail dimensions maintaining aspect ratio
 */
function calculateDimensions(srcWidth, srcHeight, maxWidth, maxHeight) {
  const ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight, 1);
  return {
    width: Math.round(srcWidth * ratio),
    height: Math.round(srcHeight * ratio),
  };
}

/**
 * Decrypt a thumbnail
 * @param {string} encryptedThumbnailB64 - Base64 encrypted thumbnail
 * @param {string} ivB64 - Base64 IV
 * @param {Uint8Array} fileKey - File encryption key
 * @returns {Uint8Array} Decrypted thumbnail data (JPEG)
 */
export function decryptThumbnail(encryptedThumbnailB64, ivB64, fileKey) {
  const encrypted = base64ToBytes(encryptedThumbnailB64);
  const iv = base64ToBytes(ivB64);
  const thumbKey = deriveThumbnailKey(fileKey);

  // Split ciphertext and tag
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);

  return decryptAESGCM(ciphertext, thumbKey, iv, tag);
}

/**
 * Create a blob URL for a decrypted thumbnail
 * @param {Uint8Array} thumbnailData
 * @param {string} format - MIME type (default: image/jpeg)
 * @returns {string} Blob URL (remember to revoke when done)
 */
export function createThumbnailUrl(thumbnailData, format = 'image/jpeg') {
  const blob = new Blob([thumbnailData], { type: format });
  return URL.createObjectURL(blob);
}

/**
 * Check if a file type supports thumbnails
 * @param {string} mimeType
 * @returns {boolean}
 */
export function supportsThumbnail(mimeType) {
  const supported = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'application/pdf',
  ];

  return supported.some(type => mimeType.startsWith(type.split('/')[0]));
}

export default {
  generateEncryptedThumbnail,
  decryptThumbnail,
  createThumbnailUrl,
  supportsThumbnail,
  THUMBNAIL_CONFIG,
};
