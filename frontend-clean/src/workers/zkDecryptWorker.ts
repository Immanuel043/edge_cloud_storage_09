// Web Worker for parallel chunk decryption
// This runs in a separate thread to avoid blocking the main UI
// Uses native Web Crypto API (works in workers, no external dependencies)

import type { WorkerRequestMessage, DecryptChunkMessage, DecryptSuccessMessage, DecryptErrorMessage } from './types';

// AES-GCM constants
const GCM_IV_LENGTH = 12; // 96 bits
const GCM_TAG_LENGTH = 16; // 128 bits

/**
 * Decrypt a chunk using AES-256-GCM via Web Crypto API
 * @param encryptedChunk - The encrypted chunk (IV + ciphertext + tag)
 * @param fileKey - The 256-bit file key
 * @param chunkIndex - Chunk index for verification
 * @returns Decrypted plaintext
 */
async function decryptChunk(
  encryptedChunk: Uint8Array,
  fileKey: Uint8Array,
  chunkIndex: number
): Promise<Uint8Array> {
  try {
    // Extract IV from the beginning of encrypted chunk (first 12 bytes)
    const iv = encryptedChunk.slice(0, GCM_IV_LENGTH);

    // The rest is ciphertext + auth tag (Web Crypto expects them together)
    const ciphertextWithTag = encryptedChunk.slice(GCM_IV_LENGTH);

    // Import the raw key for AES-GCM
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      fileKey as BufferSource,
      { name: 'AES-GCM' },
      false, // not extractable
      ['decrypt']
    );

    // Decrypt using Web Crypto API
    // Note: Web Crypto expects ciphertext + tag concatenated (which is what we have)
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: GCM_TAG_LENGTH * 8 // in bits
      },
      cryptoKey,
      ciphertextWithTag
    );

    return new Uint8Array(decryptedBuffer);

  } catch (error: unknown) {
    // Provide more helpful error messages
    const errorObj = error as { name?: string; message?: string };
    if (errorObj.name === 'OperationError') {
      throw new Error(`Chunk ${chunkIndex} decryption failed: Invalid key or corrupted data (authentication failed)`);
    }
    const errorMessage = errorObj.message || String(error);
    throw new Error(`Chunk ${chunkIndex} decryption failed: ${errorMessage}`);
  }
}

// Listen for messages from main thread
self.addEventListener('message', async (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data;

  try {
    if (message.type === 'DECRYPT_CHUNK') {
      const decryptMessage = message as DecryptChunkMessage;
      const { encryptedChunk, fileKey, chunkIndex, jobId } = decryptMessage.data;

      // Convert arrays back to Uint8Array (transferred as ArrayBuffer)
      const encryptedChunkArray = new Uint8Array(encryptedChunk);
      const fileKeyArray = new Uint8Array(fileKey);

      // Decrypt the chunk
      const decryptedChunk = await decryptChunk(encryptedChunkArray, fileKeyArray, chunkIndex);

      // Send result back to main thread
      const decryptedBuffer = decryptedChunk.buffer as ArrayBuffer;
      const successMessage: DecryptSuccessMessage = {
        type: 'DECRYPT_SUCCESS',
        data: {
          jobId,
          chunkIndex,
          decryptedChunk: decryptedBuffer // Transfer as ArrayBuffer
        }
      };
      self.postMessage(successMessage, { transfer: [decryptedBuffer] }); // Transfer ownership for performance

    } else if (message.type === 'PING') {
      // Health check
      self.postMessage({ type: 'PONG' });
    }

  } catch (error: unknown) {
    // Send error back to main thread
    const errorObj = error as { message?: string };
    const errorData: { error: string; jobId?: number; chunkIndex?: number } = {
      error: errorObj.message || String(error)
    };

    if (message.type === 'DECRYPT_CHUNK') {
      errorData.jobId = message.data.jobId;
      errorData.chunkIndex = message.data.chunkIndex;
    }

    const errorMessage: DecryptErrorMessage = {
      type: 'DECRYPT_ERROR',
      data: errorData
    };
    self.postMessage(errorMessage);
  }
});

// Signal worker is ready
self.postMessage({ type: 'WORKER_READY' });