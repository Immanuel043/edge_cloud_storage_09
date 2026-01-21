export interface KafkaEvent {
  event: string;
  userId?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface UploadEvent extends KafkaEvent {
  event: 'chunk_uploaded' | 'upload_completed' | 'upload_failed';
  uploadId: string;
  chunkIndex?: number;
  fileId?: string;
}

export interface StorageEvent extends KafkaEvent {
  event: 'file_created' | 'file_deleted' | 'file_updated';
  fileId: string;
  userId: string;
}
