/**
 * Web Worker Pool for Parallel Chunk Decryption
 *
 * Manages a pool of Web Workers to decrypt file chunks in parallel,
 * improving performance for large file downloads.
 *
 * Supports both V1 and V2 encryption:
 * - V1: Uses worker pool for parallel decryption
 * - V2: Uses main thread (requires HKDF from @noble/hashes)
 */

import type { WorkerResponseMessage } from '../workers/types';
import * as zkEncryptionService from './zkEncryptionService';

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

interface DecryptChunkInput {
  encryptedChunk: Uint8Array;
  fileKey: Uint8Array;
  chunkIndex: number;
  fileId?: string; // Required for V2 decryption (AAD verification)
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
          // Use Vite's worker import syntax
          const worker = new Worker(
            new URL('../workers/zkDecryptWorker.ts', import.meta.url),
            { type: 'module' }
          );

          // Handle worker ready event
          const readyHandler = (event: MessageEvent<WorkerResponseMessage>) => {
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
  private _handleWorkerMessage(event: MessageEvent<WorkerResponseMessage>): void {
    const message = event.data;

    if (message.type === 'DECRYPT_SUCCESS') {
      const { jobId, chunkIndex, decryptedChunk } = message.data;
      const job = this.jobs.get(jobId);

      if (job) {
        job.resolve({
          chunkIndex: chunkIndex,
          decryptedChunk: new Uint8Array(decryptedChunk),
        });
        this.jobs.delete(jobId);
      }

      // Return worker to available pool
      this.availableWorkers.push(event.target as Worker);
      this._processQueue();
    } else if (message.type === 'DECRYPT_ERROR') {
      const { jobId, chunkIndex, error } = message.data;
      const job = this.jobs.get(jobId || -1);

      if (job) {
        job.reject(new Error(`Chunk ${chunkIndex || 'unknown'} decryption failed: ${error}`));
        this.jobs.delete(jobId || -1);
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
   * Decrypt a chunk using the worker pool (V1) or main thread (V2)
   * @param encryptedChunk - Encrypted chunk data
   * @param fileKey - File decryption key
   * @param chunkIndex - Chunk index
   * @param fileId - File ID (required for V2 AAD verification)
   * @returns Promise resolving to decrypted chunk
   */
  async decryptChunk(
    encryptedChunk: Uint8Array,
    fileKey: Uint8Array,
    chunkIndex: number,
    fileId?: string
  ): Promise<DecryptResult> {
    // Auto-detect version from first byte
    const version = encryptedChunk[0];
    const V2_VERSION = 0x02;

    if (version === V2_VERSION) {
      // V2 encryption - use main thread (requires HKDF from @noble/hashes)
      console.log(`[WorkerPool] V2 chunk detected, using main thread decryption for chunk ${chunkIndex}`);

      try {
        const decryptedChunk = zkEncryptionService.decryptFileChunk(
          encryptedChunk,
          fileKey,
          fileId || '',
          chunkIndex
        );
        return { chunkIndex, decryptedChunk };
      } catch (error) {
        throw new Error(`V2 chunk ${chunkIndex} decryption failed: ${(error as Error).message}`);
      }
    }

    // V1 encryption - use worker pool for parallel processing
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
            data: {
              encryptedChunk: job.encryptedChunk,
              fileKey: job.fileKey,
              chunkIndex: job.chunkIndex,
              jobId: job.jobId,
            },
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
      this.decryptChunk(chunk.encryptedChunk, chunk.fileKey, chunk.chunkIndex, chunk.fileId)
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
