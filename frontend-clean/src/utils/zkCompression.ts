/**
 * Zero-Knowledge Compression Utility
 *
 * Provides compression before encryption (per ZK spec).
 * CRITICAL: Always compress BEFORE encryption, never after.
 *
 * Uses fflate for high-performance compression in browser.
 * Falls back to no compression if fflate fails.
 */

import { deflateSync, inflateSync, gzipSync, gunzipSync } from 'fflate';

// Compression format markers (prepended to compressed data)
export const COMPRESSION_MARKERS = {
  NONE: 0x00,      // No compression
  DEFLATE: 0x01,   // DEFLATE compression
  GZIP: 0x02,      // GZIP compression
} as const;

export type CompressionMarker = typeof COMPRESSION_MARKERS[keyof typeof COMPRESSION_MARKERS];
export type CompressionFormat = 'deflate' | 'gzip' | 'auto';

// Minimum size to consider compression (smaller files may grow)
const MIN_COMPRESSION_SIZE = 1024; // 1KB

// Maximum compression level (0-9, higher = slower but smaller)
const COMPRESSION_LEVEL = 6; // Balanced

/**
 * Compress data before encryption
 * @param data - Plaintext data to compress
 * @param format - 'deflate' | 'gzip' | 'auto' (default: 'deflate')
 * @returns Compressed data with format marker prefix
 */
export function compress(data: Uint8Array, format: CompressionFormat = 'deflate'): Uint8Array {
  // Skip compression for small data
  if (data.length < MIN_COMPRESSION_SIZE) {
    return prependMarker(data, COMPRESSION_MARKERS.NONE);
  }

  try {
    let compressed: Uint8Array;
    let marker: CompressionMarker;

    if (format === 'gzip') {
      compressed = gzipSync(data, { level: COMPRESSION_LEVEL });
      marker = COMPRESSION_MARKERS.GZIP;
    } else {
      compressed = deflateSync(data, { level: COMPRESSION_LEVEL });
      marker = COMPRESSION_MARKERS.DEFLATE;
    }

    // Only use compression if it actually reduces size
    if (compressed.length >= data.length) {
      console.debug('Compression did not reduce size, skipping');
      return prependMarker(data, COMPRESSION_MARKERS.NONE);
    }

    const ratio = ((data.length - compressed.length) / data.length * 100).toFixed(1);
    console.debug(`Compressed: ${data.length} → ${compressed.length} bytes (${ratio}% reduction)`);

    return prependMarker(compressed, marker);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('Compression failed, using uncompressed:', errorMessage);
    return prependMarker(data, COMPRESSION_MARKERS.NONE);
  }
}

/**
 * Decompress data after decryption
 * @param data - Compressed data with format marker
 * @returns Decompressed data
 */
export function decompress(data: Uint8Array): Uint8Array {
  if (data.length < 1) {
    throw new Error('Invalid compressed data: empty');
  }

  const marker = data[0] as CompressionMarker;
  const compressedData = data.slice(1);

  try {
    switch (marker) {
      case COMPRESSION_MARKERS.NONE:
        return compressedData;

      case COMPRESSION_MARKERS.DEFLATE:
        return inflateSync(compressedData);

      case COMPRESSION_MARKERS.GZIP:
        return gunzipSync(compressedData);

      default:
        // Unknown marker - assume no compression (backward compatibility)
        console.warn('Unknown compression marker, assuming uncompressed');
        return data;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Decompression failed:', errorMessage);
    throw new Error('Failed to decompress data');
  }
}

/**
 * Check if data is compressible (heuristic)
 * @param data
 * @param mimeType - Optional MIME type hint
 */
export function isCompressible(data: Uint8Array, mimeType = ''): boolean {
  // Already compressed formats - don't recompress
  const incompressibleMimes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'audio/mp3',
    'audio/mpeg',
    'audio/ogg',
    'application/zip',
    'application/gzip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
  ];

  if (mimeType && incompressibleMimes.some(m => {
    const prefix = m.split('/')[0];
    return prefix !== undefined && mimeType.startsWith(prefix);
  })) {
    return false;
  }

  // For unknown types, sample first 1KB to estimate compressibility
  const sampleSize = Math.min(1024, data.length);
  const sample = data.slice(0, sampleSize);

  // Count unique bytes - high entropy = low compressibility
  const uniqueBytes = new Set(sample).size;
  const entropy = uniqueBytes / sampleSize;

  // If entropy > 0.9, data is likely already compressed or random
  return entropy < 0.9;
}

/**
 * Compress only if beneficial
 */
export function smartCompress(data: Uint8Array, mimeType = ''): Uint8Array {
  if (!isCompressible(data, mimeType)) {
    return prependMarker(data, COMPRESSION_MARKERS.NONE);
  }
  return compress(data);
}

/**
 * Async compression for large files (uses Web Worker if available)
 */
export async function compressAsync(data: Uint8Array): Promise<Uint8Array> {
  // For now, use sync compression
  // TODO: Implement Web Worker for truly async compression
  return new Promise((resolve, reject) => {
    try {
      const result = compress(data);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Async decompression for large files
 */
export async function decompressAsync(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      const result = decompress(data);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Compression statistics
 */
export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  overhead: number;
  ratio: string;
  format: string;
  wasCompressed: boolean;
}

/**
 * Get compression stats
 */
export function getCompressionStats(original: Uint8Array, compressed: Uint8Array): CompressionStats {
  const marker = compressed[0] as CompressionMarker;
  const actualCompressed = compressed.slice(1);

  return {
    originalSize: original.length,
    compressedSize: actualCompressed.length,
    overhead: 1, // Marker byte
    ratio: ((original.length - actualCompressed.length) / original.length * 100).toFixed(2),
    format: Object.keys(COMPRESSION_MARKERS).find(
      key => COMPRESSION_MARKERS[key as keyof typeof COMPRESSION_MARKERS] === marker
    ) ?? 'UNKNOWN',
    wasCompressed: marker !== COMPRESSION_MARKERS.NONE,
  };
}

// Helper function to prepend marker
function prependMarker(data: Uint8Array, marker: CompressionMarker): Uint8Array {
  const result = new Uint8Array(1 + data.length);
  result[0] = marker;
  result.set(data, 1);
  return result;
}

export default {
  compress,
  decompress,
  smartCompress,
  compressAsync,
  decompressAsync,
  isCompressible,
  getCompressionStats,
  COMPRESSION_MARKERS,
};
