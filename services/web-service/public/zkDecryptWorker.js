// Web Worker for parallel chunk decryption
// This runs in a separate thread to avoid blocking the main UI
// Uses native Web Crypto API (works in workers, no external dependencies)

// AES-GCM constants
const GCM_IV_LENGTH = 12; // 96 bits
const GCM_TAG_LENGTH = 16; // 128 bits

/**
 * Decrypt a chunk using AES-256-GCM via Web Crypto API
 * @param {Uint8Array} encryptedChunk - The encrypted chunk (IV + ciphertext + tag)
 * @param {Uint8Array} fileKey - The 256-bit file key
 * @param {number} chunkIndex - Chunk index for verification
 * @returns {Promise<Uint8Array>} Decrypted plaintext
 */
async function decryptChunk(encryptedChunk, fileKey, chunkIndex) {
  try {
    // Extract IV from the beginning of encrypted chunk (first 12 bytes)
    const iv = encryptedChunk.slice(0, GCM_IV_LENGTH);

    // The rest is ciphertext + auth tag (Web Crypto expects them together)
    const ciphertextWithTag = encryptedChunk.slice(GCM_IV_LENGTH);

    // Import the raw key for AES-GCM
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      fileKey,
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

  } catch (error) {
    // Provide more helpful error messages
    if (error.name === 'OperationError') {
      throw new Error(`Chunk ${chunkIndex} decryption failed: Invalid key or corrupted data (authentication failed)`);
    }
    throw new Error(`Chunk ${chunkIndex} decryption failed: ${error.message}`);
  }
}

// Listen for messages from main thread
self.addEventListener('message', async (event) => {
  const { type, data } = event.data;

  try {
    if (type === 'DECRYPT_CHUNK') {
      const { encryptedChunk, fileKey, chunkIndex, jobId } = data;

      // Convert arrays back to Uint8Array (transferred as ArrayBuffer)
      const encryptedChunkArray = new Uint8Array(encryptedChunk);
      const fileKeyArray = new Uint8Array(fileKey);

      // Decrypt the chunk
      const decryptedChunk = await decryptChunk(encryptedChunkArray, fileKeyArray, chunkIndex);

      // Send result back to main thread
      self.postMessage({
        type: 'DECRYPT_SUCCESS',
        data: {
          jobId,
          chunkIndex,
          decryptedChunk: decryptedChunk.buffer // Transfer as ArrayBuffer
        }
      }, [decryptedChunk.buffer]); // Transfer ownership for performance

    } else if (type === 'PING') {
      // Health check
      self.postMessage({ type: 'PONG' });
    }

  } catch (error) {
    // Send error back to main thread
    self.postMessage({
      type: 'DECRYPT_ERROR',
      data: {
        jobId: data?.jobId,
        chunkIndex: data?.chunkIndex,
        error: error.message
      }
    });
  }
});

// Signal worker is ready
self.postMessage({ type: 'WORKER_READY' });
