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

import {
  deriveThumbnailKey,
  encryptAESGCM,
  decryptAESGCM,
  bytesToBase64,
  base64ToBytes,
} from './zkCryptoV2';

// Thumbnail configuration
export const THUMBNAIL_CONFIG = {
  maxWidth: 256,
  maxHeight: 256,
  quality: 0.8,      // JPEG quality (0-1)
  format: 'image/jpeg' as const,
};

/**
 * Thumbnail data with dimensions
 */
interface ThumbnailData {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Encrypted thumbnail result
 */
export interface EncryptedThumbnail {
  encryptedThumbnail: string;
  iv: string;
  width: number;
  height: number;
  format: string;
}

/**
 * Generate and encrypt a thumbnail for a file
 * @param file - Source file
 * @param fileKey - File encryption key (from HKDF)
 * @returns Encrypted thumbnail metadata or null
 */
export async function generateEncryptedThumbnail(
  file: File,
  fileKey: Uint8Array
): Promise<EncryptedThumbnail | null> {
  try {
    let thumbnailData: ThumbnailData | null;

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('Thumbnail generation failed:', errorMessage);
    return null;
  }
}

/**
 * Generate thumbnail from image file
 */
async function generateImageThumbnail(file: File): Promise<ThumbnailData> {
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
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

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
 */
async function generateVideoThumbnail(file: File): Promise<ThumbnailData> {
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
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

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
 * PDF.js type definitions (minimal)
 */
interface PDFDocumentProxy {
  getPage(pageNumber: number): Promise<PDFPageProxy>;
}

interface PDFPageProxy {
  getViewport(params: { scale: number }): PDFViewport;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PDFViewport;
  }): { promise: Promise<void> };
}

interface PDFViewport {
  width: number;
  height: number;
}

interface PDFLib {
  getDocument(params: { data: ArrayBuffer }): { promise: Promise<PDFDocumentProxy> };
}

declare global {
  interface Window {
    pdfjsLib?: PDFLib;
  }
}

/**
 * Generate thumbnail from PDF file
 * Requires pdf.js to be loaded
 */
async function generatePdfThumbnail(file: File): Promise<ThumbnailData | null> {
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
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('PDF thumbnail generation failed:', errorMessage);
    return null;
  }
}

/**
 * Calculated dimensions maintaining aspect ratio
 */
interface Dimensions {
  width: number;
  height: number;
}

/**
 * Calculate thumbnail dimensions maintaining aspect ratio
 */
function calculateDimensions(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number
): Dimensions {
  const ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight, 1);
  return {
    width: Math.round(srcWidth * ratio),
    height: Math.round(srcHeight * ratio),
  };
}

/**
 * Decrypt a thumbnail
 * @param encryptedThumbnailB64 - Base64 encrypted thumbnail
 * @param ivB64 - Base64 IV
 * @param fileKey - File encryption key
 * @returns Decrypted thumbnail data (JPEG)
 */
export function decryptThumbnail(
  encryptedThumbnailB64: string,
  ivB64: string,
  fileKey: Uint8Array
): Uint8Array {
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
 * @param thumbnailData
 * @param format - MIME type (default: image/jpeg)
 * @returns Blob URL (remember to revoke when done)
 */
export function createThumbnailUrl(thumbnailData: Uint8Array, format = 'image/jpeg'): string {
  const blob = new Blob([thumbnailData as BlobPart], { type: format });
  return URL.createObjectURL(blob);
}

/**
 * Check if a file type supports thumbnails
 */
export function supportsThumbnail(mimeType: string): boolean {
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

  return supported.some(type => {
    const prefix = type.split('/')[0];
    return prefix !== undefined && mimeType.startsWith(prefix);
  });
}

export default {
  generateEncryptedThumbnail,
  decryptThumbnail,
  createThumbnailUrl,
  supportsThumbnail,
  THUMBNAIL_CONFIG,
};
