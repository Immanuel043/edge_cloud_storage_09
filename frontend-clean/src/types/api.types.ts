/**
 * API Response and Error Types
 */

export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

export class UploadError extends Error {
  type: 'QUOTA_EXCEEDED' | 'RATE_LIMITED' | 'NETWORK' | 'AUTH' | 'CANCELLED';
  context: Record<string, unknown> | undefined;

  constructor(
    message: string,
    type: UploadError['type'],
    context?: Record<string, unknown>
  ) {
    super(message);
    this.type = type;
    this.context = context;
    this.name = 'UploadError';
  }
}

export interface ErrorResponse {
  detail: string | ErrorDetail[];
}

export interface ErrorDetail {
  loc: string[];
  msg: string;
  type: string;
}
