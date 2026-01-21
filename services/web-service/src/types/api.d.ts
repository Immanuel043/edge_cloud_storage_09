export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  user: {
    id: string;
    email: string;
    username: string;
    userType: string;
  };
}

export interface UploadInitRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
}

export interface UploadSession {
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  uploadedChunks: number[];
  startTime: number;
}

export interface UploadProgressEvent {
  uploadId: string;
  chunkIndex: number;
  progress: number;
  chunksUploaded: number;
  totalChunks: number;
}

export interface ShareRequest {
  expiresHours?: number;
  password?: string;
  maxDownloads?: number;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded';
  services: {
    postgres: boolean;
    redis: boolean;
    kafka: boolean;
  };
  timestamp: string;
}

export interface ErrorResponse {
  error: string;
}
