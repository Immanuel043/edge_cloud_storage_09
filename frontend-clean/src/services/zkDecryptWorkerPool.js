/**
 * Web Worker Pool for Parallel Chunk Decryption
 *
 * Manages a pool of Web Workers to decrypt file chunks in parallel,
 * improving performance for large file downloads.
 */

class ZKDecryptWorkerPool {
  constructor(poolSize = navigator.hardwareConcurrency || 4) {
    this.poolSize = Math.min(poolSize, 8); // Max 8 workers
    this.workers = [];
    this.availableWorkers = [];
    this.jobQueue = [];
    this.jobs = new Map(); // jobId -> { resolve, reject, chunkIndex }
    this.jobIdCounter = 0;
    this.initialized = false;
  }

  /**
   * Initialize the worker pool
   */
  async init() {
    if (this.initialized) return;

    console.log(`[WorkerPool] Initializing ${this.poolSize} decryption workers...`);

    const workerPromises = [];

    for (let i = 0; i < this.poolSize; i++) {
      const workerPromise = new Promise((resolve, reject) => {
        try {
          const worker = new Worker('/zkDecryptWorker.js');

          // Handle worker ready event
          const readyHandler = (event) => {
            if (event.data.type === 'WORKER_READY') {
              worker.removeEventListener('message', readyHandler);
              this.workers.push(worker);
              this.availableWorkers.push(worker);
              console.log(`[WorkerPool] Worker ${i + 1}/${this.poolSize} ready`);
              resolve(worker);
            }
          };

          worker.addEventListener('message', readyHandler);
          worker.addEventListener('error', (error) => {
            console.error(`[WorkerPool] Worker ${i + 1} error:`, error);
            reject(error);
          });

          // Setup message handler for job results
          worker.addEventListener('message', this._handleWorkerMessage.bind(this));

        } catch (error) {
          console.error(`[WorkerPool] Failed to create worker ${i + 1}:`, error);
          reject(error);
        }
      });

      workerPromises.push(workerPromise);
    }

    try {
      await Promise.all(workerPromises);
      this.initialized = true;
      console.log(`[WorkerPool] All ${this.poolSize} workers initialized successfully`);
    } catch (error) {
      console.error('[WorkerPool] Failed to initialize workers:', error);
      throw error;
    }
  }

  /**
   * Handle messages from workers
   */
  _handleWorkerMessage(event) {
    const { type, data } = event.data;

    if (type === 'DECRYPT_SUCCESS') {
      const { jobId, chunkIndex, decryptedChunk } = data;
      const job = this.jobs.get(jobId);

      if (job) {
        job.resolve({
          chunkIndex,
          decryptedChunk: new Uint8Array(decryptedChunk)
        });
        this.jobs.delete(jobId);
      }

      // Return worker to available pool
      this.availableWorkers.push(event.target);
      this._processQueue();

    } else if (type === 'DECRYPT_ERROR') {
      const { jobId, chunkIndex, error } = data;
      const job = this.jobs.get(jobId);

      if (job) {
        job.reject(new Error(`Chunk ${chunkIndex} decryption failed: ${error}`));
        this.jobs.delete(jobId);
      }

      // Return worker to available pool
      this.availableWorkers.push(event.target);
      this._processQueue();
    }
  }

  /**
   * Process queued jobs
   */
  _processQueue() {
    while (this.jobQueue.length > 0 && this.availableWorkers.length > 0) {
      const job = this.jobQueue.shift();
      const worker = this.availableWorkers.shift();

      worker.postMessage({
        type: 'DECRYPT_CHUNK',
        data: {
          encryptedChunk: job.encryptedChunk,
          fileKey: job.fileKey,
          chunkIndex: job.chunkIndex,
          jobId: job.jobId
        }
      }, [job.encryptedChunk, job.fileKey]); // Transfer ownership for performance
    }
  }

  /**
   * Decrypt a chunk using the worker pool
   * @param {Uint8Array} encryptedChunk
   * @param {Uint8Array} fileKey
   * @param {number} chunkIndex
   * @returns {Promise<{chunkIndex: number, decryptedChunk: Uint8Array}>}
   */
  async decryptChunk(encryptedChunk, fileKey, chunkIndex) {
    if (!this.initialized) {
      await this.init();
    }

    const jobId = this.jobIdCounter++;

    return new Promise((resolve, reject) => {
      // Store job
      this.jobs.set(jobId, { resolve, reject, chunkIndex });

      // Create job object
      const job = {
        jobId,
        encryptedChunk: encryptedChunk.buffer, // Convert to ArrayBuffer
        fileKey: fileKey.buffer,
        chunkIndex
      };

      // If worker available, process immediately
      if (this.availableWorkers.length > 0) {
        const worker = this.availableWorkers.shift();
        worker.postMessage({
          type: 'DECRYPT_CHUNK',
          data: job
        }, [job.encryptedChunk, job.fileKey]);
      } else {
        // Queue for later
        this.jobQueue.push(job);
      }
    });
  }

  /**
   * Decrypt multiple chunks in parallel
   * @param {Array<{encryptedChunk: Uint8Array, fileKey: Uint8Array, chunkIndex: number}>} chunks
   * @returns {Promise<Array<{chunkIndex: number, decryptedChunk: Uint8Array}>>}
   */
  async decryptChunksParallel(chunks) {
    if (!this.initialized) {
      await this.init();
    }

    const decryptPromises = chunks.map(chunk =>
      this.decryptChunk(chunk.encryptedChunk, chunk.fileKey, chunk.chunkIndex)
    );

    return Promise.all(decryptPromises);
  }

  /**
   * Terminate all workers and cleanup
   */
  terminate() {
    console.log('[WorkerPool] Terminating all workers...');

    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
    this.availableWorkers = [];
    this.jobQueue = [];
    this.jobs.clear();
    this.initialized = false;

    console.log('[WorkerPool] All workers terminated');
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      poolSize: this.poolSize,
      availableWorkers: this.availableWorkers.length,
      queuedJobs: this.jobQueue.length,
      activeJobs: this.jobs.size
    };
  }
}

// Singleton instance
let workerPoolInstance = null;

export function getWorkerPool() {
  if (!workerPoolInstance) {
    workerPoolInstance = new ZKDecryptWorkerPool();
  }
  return workerPoolInstance;
}

export function terminateWorkerPool() {
  if (workerPoolInstance) {
    workerPoolInstance.terminate();
    workerPoolInstance = null;
  }
}

export default ZKDecryptWorkerPool;
