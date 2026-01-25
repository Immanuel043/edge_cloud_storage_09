/**
 * ZK Storage Service - Zero-Knowledge File Operations
 *
 * Handles ZK-encrypted file downloads and previews.
 * All decryption happens client-side with the user's master key.
 */

import { ZK_SERVICE_URL } from '../config/constants';
import * as zkEncryptionService from './zkEncryptionService';
import { getWorkerPool } from './zkDecryptWorkerPool';

// ==================== Type Definitions ====================

export interface FileMetadata {
  file_id?: string;
  encrypted_file_key?: string;
  file_key_iv?: string;
  file_size?: number;
  mime_type?: string;
  chunk_size?: number;
  encryption_version?: number;
}

export interface DownloadResult {
  success?: boolean | undefined;
  fileName?: string | undefined;
  size?: number | undefined;
  blobUrl?: string | undefined;
  blob?: Blob | undefined;
  mimeType?: string | undefined;
}

// ==================== ZK Storage Service Class ====================

class ZKStorageService {
  /**
   * Download encrypted chunk with retry logic
   */
  private async _downloadChunkWithRetry(
    fileId: string,
    chunkIndex: number,
    retryCount: number = 0,
    maxRetries: number = 3
  ): Promise<ArrayBuffer> {
    const retryDelay = 2000; // 2 seconds

    try {
      const endpoint = `${ZK_SERVICE_URL}/api/v1/zk/files/${fileId}/chunk/${chunkIndex}`;
      const chunkResponse = await fetch(endpoint, { credentials: 'include' });

      if (!chunkResponse.ok) {
        throw new Error(`HTTP ${chunkResponse.status}: ${chunkResponse.statusText}`);
      }

      return await chunkResponse.arrayBuffer();
    } catch (error) {
      // Retry with exponential backoff
      if (retryCount < maxRetries) {
        const delay = retryDelay * Math.pow(2, retryCount);
        console.log(
          `[ZK Download] Chunk ${chunkIndex} failed, retrying in ${delay}ms (attempt ${
            retryCount + 1
          }/${maxRetries})`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this._downloadChunkWithRetry(fileId, chunkIndex, retryCount + 1, maxRetries);
      }

      // Max retries exceeded
      throw new Error(
        `Failed to download chunk ${chunkIndex} after ${maxRetries} retries: ${(error as Error).message}`
      );
    }
  }

  /**
   * Download ZK-encrypted file with client-side decryption
   */
  async downloadZKFile(
    fileId: string,
    fileName: string,
    metadata: FileMetadata,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<DownloadResult> {
    console.log('[ZK Download] Starting ZK file download:', fileName);

    // 1. Check if ZK session is unlocked
    if (!zkEncryptionService.isZKSessionUnlocked()) {
      throw new Error('ZK session is locked. Please unlock to download encrypted files.');
    }

    try {
      // 2. Decrypt file key with master key
      console.log('[ZK Download] Decrypting file key...');
      const fileKey = zkEncryptionService.prepareFileForDecryption(
        metadata.encrypted_file_key!,
        metadata.file_key_iv!
      );

      // 3. Determine number of chunks
      const chunkSize = metadata.chunk_size || 32 * 1024 * 1024; // 32MB default
      const totalChunks = Math.ceil((metadata.file_size || 0) / chunkSize);
      console.log(`[ZK Download] File has ${totalChunks} chunks`);

      // 4. Download and decrypt chunks
      const decryptedChunks: Uint8Array[] = [];

      for (let i = 0; i < totalChunks; i++) {
        // Update progress: downloading stage
        if (onProgress) {
          onProgress({
            currentStage: 'downloading',
            currentChunk: i + 1,
            totalChunks,
            downloadProgress: ((i + 1) / totalChunks) * 100,
            decryptProgress: 0,
            bytesDownloaded: i * chunkSize,
            totalBytes: metadata.file_size,
            isZK: true,
            retrying: false,
          });
        }

        // Download encrypted chunk
        const encryptedChunk = await this._downloadChunkWithRetry(fileId, i, 0, 3);
        console.log(`[ZK Download] Downloaded chunk ${i}: ${encryptedChunk.byteLength} bytes`);

        // Update progress: decrypting stage
        if (onProgress) {
          onProgress({
            currentStage: 'decrypting',
            currentChunk: i + 1,
            totalChunks,
            downloadProgress: 100,
            decryptProgress: ((i + 1) / totalChunks) * 100,
            bytesDownloaded: (i + 1) * chunkSize,
            totalBytes: metadata.file_size,
            chunksDecrypted: i + 1,
            isZK: true,
          });
        }

        // Decrypt chunk with corruption detection (auto-detects V1/V2)
        let decryptedChunk: Uint8Array;
        try {
          decryptedChunk = zkEncryptionService.decryptFileChunk(
            new Uint8Array(encryptedChunk),
            fileKey,
            fileId, // Pass fileId for V2 AAD verification
            i       // Chunk index
          );
          console.log(`[ZK Download] Decrypted chunk ${i}: ${decryptedChunk.length} bytes`);
        } catch (decryptError) {
          // Detect corruption or authentication errors
          const errorMessage = (decryptError as Error).message;
          if (
            errorMessage &&
            (errorMessage.includes('authentication') ||
              errorMessage.includes('corrupted') ||
              errorMessage.includes('tag mismatch') ||
              errorMessage.includes('Decryption failed'))
          ) {
            throw new Error(
              `File corruption detected in chunk ${i}. The file may have been tampered with or corrupted during storage. ` +
                `Please try re-uploading the file or contact support if this persists.`
            );
          }
          // Re-throw other decryption errors
          throw new Error(`Failed to decrypt chunk ${i}: ${errorMessage}`);
        }

        decryptedChunks.push(decryptedChunk);

        // Dispatch progress event (for backward compatibility)
        window.dispatchEvent(
          new CustomEvent('downloadProgress', {
            detail: {
              fileId,
              fileName,
              progress: ((i + 1) / totalChunks) * 100,
              bytesDownloaded: (i + 1) * chunkSize,
              totalBytes: metadata.file_size,
              decrypting: true,
              isZK: true,
            },
          })
        );
      }

      // 5. Assemble decrypted chunks into Blob
      console.log('[ZK Download] Assembling decrypted chunks...');
      const blob = new Blob(decryptedChunks as BlobPart[], {
        type: (metadata as Record<string, unknown>).mime_type as string || 'application/octet-stream',
      });

      // 6. Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try {
          document.body.removeChild(a);
        } catch (_) {
          /* ignore */
        }
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* ignore */
        }
      }, 10000);

      console.log('[ZK Download] ZK file downloaded and decrypted successfully!');

      // Final progress update
      if (onProgress) {
        onProgress({
          currentStage: 'completed',
          currentChunk: totalChunks,
          totalChunks,
          downloadProgress: 100,
          decryptProgress: 100,
          bytesDownloaded: metadata.file_size,
          totalBytes: metadata.file_size,
          chunksDecrypted: totalChunks,
          isZK: true,
        });
      }

      return { success: true, fileName, size: metadata.file_size || 0 };
    } catch (error) {
      console.error('[ZK Download] ZK download failed:', error);
      throw new Error(`ZK download failed: ${(error as Error).message}`);
    }
  }

  /**
   * Download ZK-encrypted file with streaming decryption using Web Workers
   * Performance-optimized version that decrypts chunks in parallel
   */
  async downloadZKFileStreaming(
    fileId: string,
    fileName: string,
    metadata: FileMetadata,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<DownloadResult> {
    console.log('[ZK Download] Starting ZK file download with streaming decryption:', fileName);

    // 1. Check if ZK session is unlocked
    if (!zkEncryptionService.isZKSessionUnlocked()) {
      throw new Error('ZK session is locked. Please unlock to download encrypted files.');
    }

    try {
      // 2. Decrypt file key with master key
      console.log('[ZK Download] Decrypting file key...');
      const fileKey = zkEncryptionService.prepareFileForDecryption(
        metadata.encrypted_file_key!,
        metadata.file_key_iv!
      );

      // 3. Determine number of chunks
      const chunkSize = metadata.chunk_size || 32 * 1024 * 1024; // 32MB default
      const totalChunks = Math.ceil((metadata.file_size || 0) / chunkSize);
      console.log(`[ZK Download] File has ${totalChunks} chunks - using parallel decryption`);

      // 4. Initialize worker pool
      const workerPool = getWorkerPool();
      await workerPool.init();

      // 5. Download and decrypt chunks in parallel (streaming approach)
      const decryptedChunks: Uint8Array[] = new Array(totalChunks);
      const downloadPromises: Promise<void>[] = [];

      for (let i = 0; i < totalChunks; i++) {
        const chunkIndex = i;
        const promise = (async () => {
          // Download encrypted chunk
          const encryptedChunk = await this._downloadChunkWithRetry(fileId, chunkIndex, 0, 3);
          console.log(`[ZK Download] Downloaded chunk ${chunkIndex}: ${encryptedChunk.byteLength} bytes`);

          // Decrypt chunk using worker pool
          const result = await workerPool.decryptChunk(
            new Uint8Array(encryptedChunk),
            fileKey,
            chunkIndex,
            fileId
          );
          console.log(`[ZK Download] Decrypted chunk ${chunkIndex}: ${result.decryptedChunk.length} bytes`);

          decryptedChunks[chunkIndex] = result.decryptedChunk;

          // Update progress
          if (onProgress) {
            const chunksDecrypted = decryptedChunks.filter(c => c !== undefined).length;
            onProgress({
              currentStage: 'decrypting',
              currentChunk: chunksDecrypted,
              totalChunks,
              downloadProgress: 100,
              decryptProgress: (chunksDecrypted / totalChunks) * 100,
              bytesDownloaded: metadata.file_size,
              totalBytes: metadata.file_size,
              chunksDecrypted,
              isZK: true,
            });
          }
        })();

        downloadPromises.push(promise);
      }

      // Wait for all chunks to decrypt
      await Promise.all(downloadPromises);

      // 6. Assemble decrypted chunks into Blob
      console.log('[ZK Download] Assembling decrypted chunks...');
      const blob = new Blob(decryptedChunks as BlobPart[], {
        type: (metadata as Record<string, unknown>).mime_type as string || 'application/octet-stream',
      });

      // 7. Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try {
          document.body.removeChild(a);
        } catch (_) {
          /* ignore */
        }
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* ignore */
        }
      }, 10000);

      console.log('[ZK Download] ZK file downloaded and decrypted successfully with streaming!');

      // Final progress update
      if (onProgress) {
        onProgress({
          currentStage: 'completed',
          currentChunk: totalChunks,
          totalChunks,
          downloadProgress: 100,
          decryptProgress: 100,
          bytesDownloaded: metadata.file_size,
          totalBytes: metadata.file_size,
          chunksDecrypted: totalChunks,
          isZK: true,
        });
      }

      return { success: true, fileName, size: metadata.file_size || 0 };
    } catch (error) {
      console.error('[ZK Download] ZK streaming download failed:', error);
      throw new Error(`ZK streaming download failed: ${(error as Error).message}`);
    }
  }

  /**
   * Preview ZK-encrypted file (returns blob URL for in-browser viewing)
   * Used for previewing ZK-encrypted images, PDFs, and other viewable files
   */
  async previewZKFile(
    fileId: string,
    metadata: FileMetadata,
    onProgress?: (progress: Record<string, unknown>) => void
  ): Promise<DownloadResult> {
    console.log('[ZK Preview] Starting ZK file preview:', fileId);

    // 1. Check if ZK session is unlocked
    if (!zkEncryptionService.isZKSessionUnlocked()) {
      throw new Error('ZK session is locked. Please unlock to preview encrypted files.');
    }

    try {
      // 2. Decrypt file key with master key
      console.log('[ZK Preview] Decrypting file key...');
      const fileKey = zkEncryptionService.prepareFileForDecryption(
        metadata.encrypted_file_key!,
        metadata.file_key_iv!
      );

      // 3. Determine number of chunks
      const chunkSize = metadata.chunk_size || 32 * 1024 * 1024; // 32MB default
      const totalChunks = Math.ceil((metadata.file_size || 0) / chunkSize);
      console.log(`[ZK Preview] File has ${totalChunks} chunks`);

      // 4. Download and decrypt chunks
      const decryptedChunks: Uint8Array[] = [];

      for (let i = 0; i < totalChunks; i++) {
        // Update progress
        if (onProgress) {
          onProgress({ stage: 'downloading', progress: ((i + 1) / totalChunks) * 50 });
        }

        // Download encrypted chunk
        const encryptedChunk = await this._downloadChunkWithRetry(fileId, i, 0, 3);

        // Update progress
        if (onProgress) {
          onProgress({ stage: 'decrypting', progress: 50 + ((i + 1) / totalChunks) * 50 });
        }

        // Decrypt chunk (auto-detects V1/V2)
        const decryptedChunk = zkEncryptionService.decryptFileChunk(
          new Uint8Array(encryptedChunk),
          fileKey,
          fileId, // Pass fileId for V2 AAD verification
          i       // Chunk index
        );
        decryptedChunks.push(decryptedChunk);
      }

      // 5. Assemble decrypted chunks into Blob
      const blob = new Blob(decryptedChunks as BlobPart[], {
        type: (metadata as Record<string, unknown>).mime_type as string || 'application/octet-stream',
      });
      const blobUrl = URL.createObjectURL(blob);

      console.log('[ZK Preview] ZK file decrypted successfully for preview');

      if (onProgress) {
        onProgress({ stage: 'complete', progress: 100 });
      }

      return { blobUrl, blob, mimeType: (metadata as Record<string, unknown>).mime_type as string };
    } catch (error) {
      console.error('[ZK Preview] ZK preview failed:', error);
      throw new Error(`ZK preview failed: ${(error as Error).message}`);
    }
  }
}

// Export singleton instance
export const zkStorageService = new ZKStorageService();
