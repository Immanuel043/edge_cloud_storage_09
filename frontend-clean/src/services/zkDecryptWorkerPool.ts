/**
 * Web Worker Pool for Parallel Chunk Decryption
 *
 * Manages a pool of Web Workers to decrypt file chunks in parallel,
 * improving performance for large file downloads.
 */

// ==================== Type Definitions ====================

interface JobInfo {
  resolve: (value: DecryptResult) => void;
  reject: (reason: Error) => void;
  chunkIndex: number;
}

interface QueuedJob {
  jobId: number;
  encryptedChunk: ArrayBuffer;
  fileKey: ArrayBuffer;
  chunkIndex: number;
}

interface DecryptResult {
  chunkIndex: number;
  decryptedChunk: Uint8Array;
}

interface WorkerMessage {
  type: 'WORKER_READY' | 'DECRYPT_SUCCESS' | 'DECRYPT_ERROR';
  data?: {
    jobId?: number;
    chunkIndex?: number;
    decryptedChunk?: ArrayBuffer;
    error?: string;
  };
}

interface DecryptChunkInput {
  encryptedChunk: Uint8Array;
  fileKey: Uint8Array;
  chunkIndex: number;
}

interface PoolStats {
  poolSize: number;
  availableWorkers: number;
  queuedJobs: number;
  activeJobs: number;
}

// ==================== Worker Pool Class ====================

class ZKDecryptWorkerPool {
  private poolSize: number;
  private workers: Worker[];
  private availableWorkers: Worker[];
  private jobQueue: QueuedJob[];
  private jobs: Map<number, JobInfo>;
  private jobIdCounter: number;
  private initialized: boolean;

  constructor(poolSize?: number) {
    // Detect mobile devices for conservative worker count
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    // Use hardware concurrency, but cap based on device type
    const maxWorkers = isMobile ? 4 : 8;
    const defaultWorkers = isMobile ? 2 : 4;
    const hwConcurrency = navigator.hardwareConcurrency || defaultWorkers;

    this.poolSize = poolSize || Math.min(hwConcurrency, maxWorkers);
    this.workers = [];
    this.availableWorkers = [];
    this.jobQueue = [];
    this.jobs = new Map();
    this.jobIdCounter = 0;
    this.initialized = false;

    console.log(
      `[WorkerPool] Device: ${isMobile ? 'Mobile' : 'Desktop'}, Cores: ${hwConcurrency}, Workers: ${
        this.poolSize
      }`
    );
  }

  /**
   * Initialize the worker pool
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    console.log(`[WorkerPool] Initializing ${this.poolSize} decryption workers...`);

    const workerPromises: Promise<Worker>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const workerPromise = new Promise<Worker>((resolve, reject) => {
        try {
          const worker = new Worker('/zkDecryptWorker.js');

          // Handle worker ready event
          const readyHandler = (event: MessageEvent<WorkerMessage>) => {
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
  private _handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
    const { type, data } = event.data;

    if (type === 'DECRYPT_SUCCESS') {
      const { jobId, chunkIndex, decryptedChunk } = data!;
      const job = this.jobs.get(jobId!);

      if (job) {
        job.resolve({
          chunkIndex: chunkIndex!,
          decryptedChunk: new Uint8Array(decryptedChunk!),
        });
        this.jobs.delete(jobId!);
      }

      // Return worker to available pool
      this.availableWorkers.push(event.target as Worker);
      this._processQueue();
    } else if (type === 'DECRYPT_ERROR') {
      const { jobId, chunkIndex, error } = data!;
      const job = this.jobs.get(jobId!);

      if (job) {
        job.reject(new Error(`Chunk ${chunkIndex} decryption failed: ${error}`));
        this.jobs.delete(jobId!);
      }

      // Return worker to available pool
      this.availableWorkers.push(event.target as Worker);
      this._processQueue();
    }
  }

  /**
   * Process queued jobs
   */
  private _processQueue(): void {
    while (this.jobQueue.length > 0 && this.availableWorkers.length > 0) {
      const job = this.jobQueue.shift()!;
      const worker = this.availableWorkers.shift()!;

      worker.postMessage(
        {
          type: 'DECRYPT_CHUNK',
          data: {
            encryptedChunk: job.encryptedChunk,
            fileKey: job.fileKey,
            chunkIndex: job.chunkIndex,
            jobId: job.jobId,
          },
        },
        [job.encryptedChunk, job.fileKey]
      ); // Transfer ownership for performance
    }
  }

  /**
   * Decrypt a chunk using the worker pool
   * @param encryptedChunk - Encrypted chunk data
   * @param fileKey - File decryption key
   * @param chunkIndex - Chunk index
   * @returns Promise resolving to decrypted chunk
   */
  async decryptChunk(
    encryptedChunk: Uint8Array,
    fileKey: Uint8Array,
    chunkIndex: number
  ): Promise<DecryptResult> {
    if (!this.initialized) {
      await this.init();
    }

    const jobId = this.jobIdCounter++;

    return new Promise<DecryptResult>((resolve, reject) => {
      // Store job
      this.jobs.set(jobId, { resolve, reject, chunkIndex });

      // Create job object
      const job: QueuedJob = {
        jobId,
        encryptedChunk: encryptedChunk.buffer as ArrayBuffer, // Convert to ArrayBuffer
        fileKey: fileKey.buffer as ArrayBuffer,
        chunkIndex,
      };

      // If worker available, process immediately
      if (this.availableWorkers.length > 0) {
        const worker = this.availableWorkers.shift()!;
        worker.postMessage(
          {
            type: 'DECRYPT_CHUNK',
            data: job,
          },
          [job.encryptedChunk, job.fileKey]
        );
      } else {
        // Queue for later
        this.jobQueue.push(job);
      }
    });
  }

  /**
   * Decrypt multiple chunks in parallel
   * @param chunks - Array of chunks to decrypt
   * @returns Promise resolving to array of decrypted chunks
   */
  async decryptChunksParallel(chunks: DecryptChunkInput[]): Promise<DecryptResult[]> {
    if (!this.initialized) {
      await this.init();
    }

    const decryptPromises = chunks.map((chunk) =>
      this.decryptChunk(chunk.encryptedChunk, chunk.fileKey, chunk.chunkIndex)
    );

    return Promise.all(decryptPromises);
  }

  /**
   * Terminate all workers and cleanup
   */
  terminate(): void {
    console.log('[WorkerPool] Terminating all workers...');

    this.workers.forEach((worker) => worker.terminate());
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
  getStats(): PoolStats {
    return {
      poolSize: this.poolSize,
      availableWorkers: this.availableWorkers.length,
      queuedJobs: this.jobQueue.length,
      activeJobs: this.jobs.size,
    };
  }
}

// ==================== Singleton Pattern ====================

// Singleton instance
let workerPoolInstance: ZKDecryptWorkerPool | null = null;

export function getWorkerPool(): ZKDecryptWorkerPool {
  if (!workerPoolInstance) {
    workerPoolInstance = new ZKDecryptWorkerPool();
  }
  return workerPoolInstance;
}

export function terminateWorkerPool(): void {
  if (workerPoolInstance) {
    workerPoolInstance.terminate();
    workerPoolInstance = null;
  }
}

export default ZKDecryptWorkerPool;
