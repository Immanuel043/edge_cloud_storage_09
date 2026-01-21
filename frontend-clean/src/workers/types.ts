/**
 * Worker message types for zkDecryptWorker
 */

export interface DecryptChunkMessage {
  type: 'DECRYPT_CHUNK';
  data: {
    encryptedChunk: ArrayBuffer;
    fileKey: ArrayBuffer;
    chunkIndex: number;
    jobId: string;
  };
}

export interface DecryptSuccessMessage {
  type: 'DECRYPT_SUCCESS';
  data: {
    jobId: string;
    chunkIndex: number;
    decryptedChunk: ArrayBuffer;
  };
}

export interface DecryptErrorMessage {
  type: 'DECRYPT_ERROR';
  data: {
    jobId?: string;
    chunkIndex?: number;
    error: string;
  };
}

export interface PingMessage {
  type: 'PING';
}

export interface PongMessage {
  type: 'PONG';
}

export interface WorkerReadyMessage {
  type: 'WORKER_READY';
}

export type WorkerRequestMessage = DecryptChunkMessage | PingMessage;

export type WorkerResponseMessage = DecryptSuccessMessage | DecryptErrorMessage | PongMessage | WorkerReadyMessage;

export type WorkerMessage = WorkerRequestMessage | WorkerResponseMessage;
