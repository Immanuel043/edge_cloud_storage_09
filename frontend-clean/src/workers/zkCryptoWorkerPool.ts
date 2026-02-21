/**
 * Zero-Knowledge Crypto Worker Pool
 *
 * Manages a pool of Web Workers for parallel crypto operations.
 * Provides a Promise-based API for async operations.
 */

// Vite worker import
// @ts-ignore - Vite worker import syntax
import CryptoWorker from './zkCryptoWorker?worker';
import { deriveKeyArgon2id as deriveKeyArgon2idMain } from '../utils/zkCryptoV2';

const MAX_WORKERS = Math.min(navigator.hardwareConcurrency ?? 4, 8);

interface WorkerJob {
  message: {
    id: number;
    type: string;
    payload: Record<string, unknown>;
  };
  transfer: Transferable[];
}

interface WorkerCallback {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerWrapper {
  worker: Worker;
  busy: boolean;
}

interface DeriveKeyOptions {
  iterations?: number;
  parallelism?: number;
}

class ZKCryptoWorkerPool {
  private workers: WorkerWrapper[];
  private queue: WorkerJob[];
  private callbacks: Map<number, WorkerCallback>;
  private nextId: number;
  private initialized: boolean;

  constructor() {
    this.workers = [];
    this.queue = [];
    this.callbacks = new Map();
    this.nextId = 0;
    this.initialized = false;
  }

  /**
   * Initialize the worker pool
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < MAX_WORKERS; i++) {
      const worker = new CryptoWorker();

      // Wait for worker to be ready
      const readyPromise = new Promise<void>((resolve) => {
        const handler = (event: MessageEvent) => {
          if (event.data.type === 'ready') {
            worker.removeEventListener('message', handler);
            resolve();
          }
        };
        worker.addEventListener('message', handler);
      });

      readyPromises.push(readyPromise);

      // Handle responses
      worker.onmessage = (event: MessageEvent) => {
        const { id, result, error } = event.data as { id?: number; result?: unknown; error?: string };

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
        this.processQueue(workerWrapper);
      };

      worker.onerror = (error: ErrorEvent) => {
        console.error('Worker error:', error);
      };

      const workerWrapper: WorkerWrapper = {
        worker,
        busy: false,
      };

      this.workers.push(workerWrapper);
    }

    await Promise.all(readyPromises);
    this.initialized = true;
  }

  /**
   * Process the next job in queue with an available worker
   */
  private processQueue(workerObj: WorkerWrapper | null = null): void {
    if (this.queue.length === 0) {
      if (workerObj) workerObj.busy = false;
      return;
    }

    // Find an available worker
    const available = workerObj ?? this.workers.find((w) => !w.busy);
    if (!available) return;

    const job = this.queue.shift();
    if (!job) return;

    available.busy = true;

    available.worker.postMessage(job.message, job.transfer);
  }

  /**
   * Send a job to the worker pool
   * @param type - Operation type
   * @param payload - Operation data
   * @param transfer - Transferable objects
   */
  async execute(type: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    await this.init();

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });

      const job: WorkerJob = {
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
   * Derive key using Argon2id
   * Note: This runs on the MAIN THREAD, not in worker
   * because Vite module workers don't support the argon2-browser script
   */
  async deriveKeyArgon2id(password: string, salt: Uint8Array, options: DeriveKeyOptions = {}): Promise<Uint8Array> {
    return deriveKeyArgon2idMain(password, salt, options);
  }

  /**
   * Derive key using HKDF (in worker)
   */
  async deriveKeyHKDF(masterKey: Uint8Array, label: string): Promise<Uint8Array> {
    const result = await this.execute('deriveKeyHKDF', {
      masterKey: Array.from(masterKey),
      label,
    });
    return new Uint8Array(result as ArrayBuffer);
  }

  /**
   * Encrypt a chunk (in worker)
   */
  async encryptChunk(chunk: Uint8Array, fileKey: Uint8Array, fileId: string, chunkIndex: number): Promise<Uint8Array> {
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
    return new Uint8Array(result as ArrayBuffer);
  }

  /**
   * Decrypt a chunk (in worker)
   */
  async decryptChunk(chunk: Uint8Array, fileKey: Uint8Array, fileId: string, chunkIndex: number): Promise<Uint8Array> {
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
    return new Uint8Array(result as ArrayBuffer);
  }

  /**
   * Test worker connectivity
   */
  async ping(): Promise<string> {
    const result = await this.execute('ping', {});
    return result as string;
  }

  /**
   * Terminate all workers
   */
  terminate(): void {
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
let workerPool: ZKCryptoWorkerPool | null = null;

/**
 * Get the worker pool instance
 */
export function getWorkerPool(): ZKCryptoWorkerPool {
  if (!workerPool) {
    workerPool = new ZKCryptoWorkerPool();
  }
  return workerPool;
}

/**
 * Terminate the worker pool
 */
export function terminateWorkerPool(): void {
  if (workerPool) {
    workerPool.terminate();
    workerPool = null;
  }
}

export default {
  getWorkerPool,
  terminateWorkerPool,
};
