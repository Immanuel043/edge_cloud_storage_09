// Web Worker for parallel chunk decryption
// This runs in a separate thread to avoid blocking the main UI

// Import crypto libraries (using importScripts for web workers)
importScripts('https://cdn.jsdelivr.net/npm/node-forge@1.3.1/dist/forge.min.js');

// AES-GCM constants
const GCM_IV_LENGTH = 12; // 96 bits
const GCM_TAG_LENGTH = 16; // 128 bits

/**
 * Decrypt a chunk using AES-256-GCM
 * @param {Uint8Array} encryptedChunk - The encrypted chunk (IV + ciphertext + tag)
 * @param {Uint8Array} fileKey - The 256-bit file key
 * @param {number} chunkIndex - Chunk index for verification
 * @returns {Uint8Array} Decrypted plaintext
 */
function decryptChunk(encryptedChunk, fileKey, chunkIndex) {
  try {
    // Extract IV from the beginning of encrypted chunk (first 12 bytes)
    const iv = encryptedChunk.slice(0, GCM_IV_LENGTH);
    const ciphertextWithTag = encryptedChunk.slice(GCM_IV_LENGTH);

    // Split ciphertext and tag
    const ciphertext = ciphertextWithTag.slice(0, -GCM_TAG_LENGTH);
    const tag = ciphertextWithTag.slice(-GCM_TAG_LENGTH);

    // Convert to forge binary strings
    const keyStr = forge.util.createBuffer(fileKey).toString();
    const ivStr = forge.util.createBuffer(iv).toString();
    const ciphertextStr = forge.util.createBuffer(ciphertext).toString();
    const tagStr = forge.util.createBuffer(tag).toString();

    // Create AES-GCM decipher
    const decipher = forge.cipher.createDecipher('AES-GCM', keyStr);

    // Set IV and tag
    decipher.start({
      iv: ivStr,
      tag: tagStr
    });

    // Decrypt
    decipher.update(forge.util.createBuffer(ciphertextStr));
    const success = decipher.finish();

    if (!success) {
      throw new Error('Decryption failed: Invalid key, corrupted data, or authentication tag mismatch');
    }

    // Convert result to Uint8Array
    const decryptedBytes = decipher.output.getBytes();
    const plaintext = new Uint8Array(decryptedBytes.length);
    for (let i = 0; i < decryptedBytes.length; i++) {
      plaintext[i] = decryptedBytes.charCodeAt(i);
    }

    return plaintext;

  } catch (error) {
    throw new Error(`Chunk ${chunkIndex} decryption failed: ${error.message}`);
  }
}

// Listen for messages from main thread
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  try {
    if (type === 'DECRYPT_CHUNK') {
      const { encryptedChunk, fileKey, chunkIndex, jobId } = data;

      // Convert arrays back to Uint8Array (transferred as ArrayBuffer)
      const encryptedChunkArray = new Uint8Array(encryptedChunk);
      const fileKeyArray = new Uint8Array(fileKey);

      // Decrypt the chunk
      const decryptedChunk = decryptChunk(encryptedChunkArray, fileKeyArray, chunkIndex);

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
