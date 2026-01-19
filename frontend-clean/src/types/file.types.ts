/**
 * File, Folder, and Upload Types
 */

export interface FileObject {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  folderId?: string;
  storageTier?: 'hot' | 'warm' | 'cold';
  createdAt: string;
  lastAccessed?: string;
  isEncrypted?: boolean;
  encryptedFileKey?: string;  // Base64
  fileKeyIv?: string;  // Base64
  encryptionAlgorithm?: 'AES-256-GCM';
  encryptionVersion?: 1 | 2;
  encryptionMode?: 'client_zk';
  isFavorite?: boolean;
  isShared?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  createdAt: string;
}

export interface UploadSession {
  uploadId: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  zkEnabled: boolean;
  fileKey?: Uint8Array;  // In-memory only, not serialized
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
}

export interface ChunkMetadata {
  index: number;
  hash: string;
  size: number;
  compressed?: boolean;
}

export interface FileUploadInit {
  fileName: string;
  fileSize: number;
  folderId?: string;
  mimeType?: string;
}
