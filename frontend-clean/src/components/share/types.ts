/**
 * Share Components Type Definitions
 *
 * Strict TypeScript types for all share-related components.
 * Following best practices:
 * - No `any` types
 * - `unknown` at trust boundaries
 * - Explicit return types
 * - Proper React types
 */

// ==================== Share API Response Types ====================

/**
 * Individual file in a share bundle or folder
 */
export interface ShareFile {
  id: string;
  name: string;
  size: number;
  mime_type?: string;
  folder_path?: string;
  relativePath?: string; // Added by grouping logic in ShareBundleViewer
}

/**
 * Bundle information from API
 */
export interface BundleInfo {
  name: string;
  file_count: number;
  total_size: number;
  files: ShareFile[];
  allow_zip_download: boolean;
  show_file_sizes: boolean;
  share_type: 'view' | 'download';
  allow_preview: boolean;
  owner_name?: string;
  requires_password?: boolean;
  watermark_text?: string;
}

/**
 * Share information for single file/folder
 */
export interface ShareInfo {
  item_name: string;
  item_type: 'file' | 'folder';
  share_type: 'view' | 'download' | 'edit';
  file_id?: string;
  mime_type?: string;
  file_size?: number;
  allow_preview?: boolean;
  password_required?: boolean;
  watermark_text?: string;
}

/**
 * ZK-encrypted share information
 */
export interface ZKShareInfo extends ShareInfo {
  encrypted_file_key: string;
  file_key_iv: string;
  chunks: Array<{ url: string; index: number }>;
}

/**
 * Folder contents from API
 */
export interface FolderContents {
  folder_name: string;
  files: Array<{
    id: string;
    name: string;
    size: number;
    mime_type?: string;
  }>;
  notice?: string;
  watermark_text?: string;
}

/**
 * View mode for bundle viewer
 */
export type ViewMode = 'grid' | 'list';

/**
 * Grouped files structure (root files + folders)
 */
export interface GroupedFiles {
  rootFiles: ShareFile[];
  folders: Record<string, ShareFile[]>;
}

// ==================== Type Guards ====================

/**
 * Type guard for BundleInfo
 */
export function isBundleInfo(data: unknown): data is BundleInfo {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.file_count === 'number' &&
    typeof obj.total_size === 'number' &&
    Array.isArray(obj.files) &&
    typeof obj.allow_zip_download === 'boolean' &&
    typeof obj.share_type === 'string' &&
    typeof obj.allow_preview === 'boolean'
  );
}

/**
 * Type guard for ShareInfo
 */
export function isShareInfo(data: unknown): data is ShareInfo {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.item_name === 'string' &&
    typeof obj.item_type === 'string' &&
    typeof obj.share_type === 'string'
  );
}

/**
 * Type guard for ZKShareInfo
 */
export function isZKShareInfo(data: unknown): data is ZKShareInfo {
  if (!isShareInfo(data)) return false;
  const obj = data as unknown as Record<string, unknown>;
  return (
    typeof obj.encrypted_file_key === 'string' &&
    typeof obj.file_key_iv === 'string' &&
    Array.isArray(obj.chunks)
  );
}

/**
 * Type guard for FolderContents
 */
export function isFolderContents(data: unknown): data is FolderContents {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.folder_name === 'string' &&
    Array.isArray(obj.files)
  );
}

/**
 * Type guard for error with message property
 */
export function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
}
