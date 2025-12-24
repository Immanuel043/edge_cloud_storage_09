/**
 * Zero-Knowledge Crypto Worker Pool
 *
 * Manages a pool of Web Workers for parallel crypto operations.
 * Provides a Promise-based API for async operations.
 */

// Vite worker import
import CryptoWorker from './zkCryptoWorker.js?worker';

const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 8);

class ZKCryptoWorkerPool {
  constructor() {
    this.workers = [];
    this.queue = [];
    this.callbacks = new Map();
    this.nextId = 0;
    this.initialized = false;
    this.readyCount = 0;
  }

  /**
   * Initialize the worker pool
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) return;

    const readyPromises = [];

    for (let i = 0; i < MAX_WORKERS; i++) {
      const worker = new CryptoWorker();

      // Wait for worker to be ready
      const readyPromise = new Promise((resolve) => {
        const handler = (event) => {
          if (event.data.type === 'ready') {
            worker.removeEventListener('message', handler);
            resolve();
          }
        };
        worker.addEventListener('message', handler);
      });

      readyPromises.push(readyPromise);

      // Handle responses
      worker.onmessage = (event) => {
        const { id, result, error } = event.data;

        if (id === undefined) return; // Ready message or other

        const callback = this.callbacks.get(id);
        if (callback) {
          this.callbacks.delete(id);
          if (error) {
            callback.reject(new Error(error));
          } else {
            callback.resolve(result);
          }
        }

        // Process next job in queue
        this.processQueue(worker);
      };

      worker.onerror = (error) => {
        console.error('Worker error:', error);
      };

      this.workers.push({
        worker,
        busy: false,
      });
    }

    await Promise.all(readyPromises);
    this.initialized = true;
  }

  /**
   * Process the next job in queue with an available worker
   */
  processQueue(workerObj = null) {
    if (this.queue.length === 0) {
      if (workerObj) workerObj.busy = false;
      return;
    }

    // Find an available worker
    const available = workerObj || this.workers.find((w) => !w.busy);
    if (!available) return;

    const job = this.queue.shift();
    available.busy = true;

    available.worker.postMessage(job.message, job.transfer);
  }

  /**
   * Send a job to the worker pool
   * @param {string} type - Operation type
   * @param {Object} payload - Operation data
   * @param {Array} transfer - Transferable objects
   * @returns {Promise<any>}
   */
  async execute(type, payload, transfer = []) {
    await this.init();

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });

      const job = {
        message: { id, type, payload },
        transfer,
      };

      // Find available worker
      const available = this.workers.find((w) => !w.busy);
      if (available) {
        available.busy = true;
        available.worker.postMessage(job.message, job.transfer);
      } else {
        // Queue the job
        this.queue.push(job);
      }
    });
  }

  /**
   * Derive key using Argon2id (in worker)
   */
  async deriveKeyArgon2id(password, salt, options = {}) {
    const result = await this.execute('deriveKey', {
      password,
      salt: Array.from(salt),
      options,
    });
    return new Uint8Array(result);
  }

  /**
   * Derive key using HKDF (in worker)
   */
  async deriveKeyHKDF(masterKey, label) {
    const result = await this.execute('deriveKeyHKDF', {
      masterKey: Array.from(masterKey),
      label,
    });
    return new Uint8Array(result);
  }

  /**
   * Encrypt a chunk (in worker)
   */
  async encryptChunk(chunk, fileKey, fileId, chunkIndex) {
    const result = await this.execute(
      'encryptChunk',
      {
        chunk: Array.from(chunk),
        fileKey: Array.from(fileKey),
        fileId,
        chunkIndex,
      },
      [chunk.buffer]
    );
    return new Uint8Array(result);
  }

  /**
   * Decrypt a chunk (in worker)
   */
  async decryptChunk(chunk, fileKey, fileId, chunkIndex) {
    const result = await this.execute(
      'decryptChunk',
      {
        chunk: Array.from(chunk),
        fileKey: Array.from(fileKey),
        fileId,
        chunkIndex,
      },
      [chunk.buffer]
    );
    return new Uint8Array(result);
  }

  /**
   * Test worker connectivity
   */
  async ping() {
    return this.execute('ping', {});
  }

  /**
   * Terminate all workers
   */
  terminate() {
    for (const { worker } of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.queue = [];
    this.callbacks.clear();
    this.initialized = false;
  }
}

// Singleton instance
let workerPool = null;

/**
 * Get the worker pool instance
 * @returns {ZKCryptoWorkerPool}
 */
export function getWorkerPool() {
  if (!workerPool) {
    workerPool = new ZKCryptoWorkerPool();
  }
  return workerPool;
}

/**
 * Terminate the worker pool
 */
export function terminateWorkerPool() {
  if (workerPool) {
    workerPool.terminate();
    workerPool = null;
  }
}

export default {
  getWorkerPool,
  terminateWorkerPool,
};
