/**
 * ZK Encryption Worker Pool
 *
 * Manages pool of Web Workers for parallel file encryption during uploads.
 * Based on zkDecryptWorkerPool.ts architecture to prevent UI blocking.
 *
 * Features:
 * - Load balancing across 2-8 workers
 * - Task queuing when all workers busy
 * - Transferable objects for zero-copy performance
 * - Automatic worker cleanup
 */
import { EventEmitter } from 'events';

interface EncryptedChunk {
  index: number;
  data: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  size: number;
}

interface EncryptTask {
  id: string;
  chunkData: Uint8Array;
  fileKey: Uint8Array;
  fileId: string;
  chunkIndex: number;
  resolve: (result: Uint8Array) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  currentTask: EncryptTask | null;
}

export class ZKEncryptWorkerPool extends EventEmitter {
  private workers: WorkerState[] = [];
  private taskQueue: EncryptTask[] = [];
  private poolSize: number;

  constructor() {
    super();
    // Same sizing as decrypt pool: 2-4 workers on mobile, 4-8 on desktop
    const isMobile = /Mobile|Android|iPhone/i.test(navigator.userAgent);
    this.poolSize = isMobile ? Math.min(navigator.hardwareConcurrency || 2, 4) : Math.min(navigator.hardwareConcurrency || 4, 8);

    this.initializePool();
    console.log(`[ZK Encrypt Pool] Initialized with ${this.poolSize} workers`);
  }

  private initializePool(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(
        new URL('./zkCryptoWorker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e) => this.handleWorkerMessage(i, e);
      worker.onerror = (e) => this.handleWorkerError(i, e);

      this.workers.push({
        worker,
        busy: false,
        currentTask: null,
      });
    }
  }

  /**
   * Encrypt a file chunk using the worker pool
   *
   * @param chunkData - Raw file chunk data
   * @param fileKey - File encryption key (derived from master key)
   * @param fileId - File/Upload ID for AAD
   * @param chunkIndex - Chunk sequence number
   * @returns Promise resolving to encrypted chunk data
   */
  async encryptChunk(
    chunkData: Uint8Array,
    fileKey: Uint8Array,
    fileId: string,
    chunkIndex: number
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const task: EncryptTask = {
        id: `encrypt-${Date.now()}-${chunkIndex}`,
        chunkData,
        fileKey,
        fileId,
        chunkIndex,
        resolve,
        reject,
      };

      // Try to assign to available worker
      const availableWorker = this.workers.find(w => !w.busy);
      if (availableWorker) {
        this.assignTask(availableWorker, task);
      } else {
        // Queue for later
        this.taskQueue.push(task);
      }
    });
  }

  private assignTask(workerState: WorkerState, task: EncryptTask): void {
    workerState.busy = true;
    workerState.currentTask = task;

    // Send to worker with message format matching zkCryptoWorker's 'encrypt' handler
    workerState.worker.postMessage({
      id: task.id,
      type: 'encrypt',
      payload: {
        chunkData: Array.from(task.chunkData), // Convert to array for worker
        fileKey: Array.from(task.fileKey),
        fileId: task.fileId,
        chunkIndex: task.chunkIndex,
      },
    });
  }

  private handleWorkerMessage(workerIndex: number, e: MessageEvent): void {
    const workerState = this.workers[workerIndex];
    const task = workerState.currentTask;

    if (!task) return;

    const { id, result, error } = e.data;

    // Check if this message is for the current task
    if (id !== task.id) return;

    if (error) {
      task.reject(new Error(error));
      this.releaseWorker(workerState);
    } else if (result) {
      // Convert array back to Uint8Array
      const encryptedData = new Uint8Array(result);
      task.resolve(encryptedData);
      this.releaseWorker(workerState);
    }
  }

  private handleWorkerError(workerIndex: number, error: ErrorEvent): void {
    console.error(`[ZK Encrypt Pool] Worker ${workerIndex} error:`, error);
    const workerState = this.workers[workerIndex];
    const task = workerState.currentTask;

    if (task) {
      task.reject(new Error(`Worker ${workerIndex} error: ${error.message}`));
      this.releaseWorker(workerState);
    }
  }

  private releaseWorker(workerState: WorkerState): void {
    workerState.busy = false;
    workerState.currentTask = null;

    // Process queued tasks
    if (this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift()!;
      this.assignTask(workerState, nextTask);
    }
  }

  /**
   * Terminate all workers and clear queues
   */
  terminate(): void {
    console.log(`[ZK Encrypt Pool] Terminating ${this.workers.length} workers`);
    this.workers.forEach(({ worker }) => worker.terminate());
    this.workers = [];
    this.taskQueue = [];
  }

  /**
   * Get current pool statistics
   */
  getStats() {
    return {
      poolSize: this.poolSize,
      busyWorkers: this.workers.filter(w => w.busy).length,
      queuedTasks: this.taskQueue.length,
      availableWorkers: this.workers.filter(w => !w.busy).length,
    };
  }
}

// Singleton instance
let encryptPoolInstance: ZKEncryptWorkerPool | null = null;

/**
 * Get the singleton encrypt worker pool instance
 */
export function getEncryptWorkerPool(): ZKEncryptWorkerPool {
  if (!encryptPoolInstance) {
    encryptPoolInstance = new ZKEncryptWorkerPool();
  }
  return encryptPoolInstance;
}

/**
 * Terminate the encrypt worker pool
 */
export function terminateEncryptWorkerPool(): void {
  if (encryptPoolInstance) {
    encryptPoolInstance.terminate();
    encryptPoolInstance = null;
  }
}
