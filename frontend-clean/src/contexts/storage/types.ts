/**
 * Shared types for Storage Context (ZK and Normal modes)
 */

export interface FileItem {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  created_at: string;
  updated_at: string;
  is_encrypted?: boolean;
  encryption_mode?: string;
  encryption_version?: number;
  encrypted_file_key?: string;
  file_key_iv?: string;
  folder_id?: string | null;
  encrypted_file_name?: string;
  file_name_iv?: string;
  chunk_size?: number;
  [key: string]: unknown;
}

export interface FolderItem {
  id: string;
  name: string;
  created_at: string;
  parent_id?: string | null;
  path?: string;
  [key: string]: unknown;
}

// Per-user synthetic root anchor created at signup (auth.py).
// Backend intentionally returns it in the root folder list; this helper only
// identifies it for special handling.
export const isRootAnchor = (f: FolderItem): boolean =>
  f.name === '/' && f.path === '/' && f.parent_id == null;

export interface StorageStats {
  used: number;
  total: number;
  quota: number;
  available: number;
  files_count: number;
  percentage_used: number;
  [key: string]: unknown;
}

export interface DedupStats {
  logical_size: number;
  physical_size: number;
  saved_size: number;
  savings_percentage: number;
  storage_efficiency: number;
}

export interface UploadProgress {
  uploadId?: string;
  progress: number;
  bytesUploaded: number;
  totalBytes: number;
  chunksUploaded?: number;
  totalChunks?: number;
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'paused';
  error?: string;
}

export interface ShareLinkOptions {
  expires_in?: number;
  max_downloads?: number;
  password?: string;
}

export interface MigrationStats {
  total_files: number;
  v1_files: number;
  v2_files: number;
  migration_required: boolean;
  estimated_time_minutes?: number;
}

export interface MigrationProgress {
  current: number;
  total: number;
  currentFile: string | null;
}

export interface MigrationResult {
  completed: number;
  failed: number;
  skipped: number;
  errors?: Array<{ file: string; error: string }>;
}

export interface BulkDeleteResult {
  deleted: number;
  freed_space: number;
}

export interface StorageContextValue {
  // Files and folders
  files: FileItem[];
  folders: FolderItem[];
  currentFolder: string | null;
  currentFolderName: string | null;

  // Statistics
  storageStats: StorageStats | null;
  dedupStats: DedupStats | null;

  // Selection
  selectedFiles: Set<string>;
  lastClickedIndex: number | null;
  selectFile: (fileId: string, index: number, ctrlKey: boolean, shiftKey: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;

  // Navigation
  navigateToFolder: (folderId: string | null, folderName?: string) => void;

  // File operations
  uploadFile: (file: File, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal) => Promise<{ success: boolean; fileId?: string; encrypted?: boolean; serverUploadId?: string }>;
  downloadFile: (fileId: string, fileName: string, onProgress?: (progress: Record<string, unknown>) => void) => Promise<void>;
  deleteFile: (fileId: string, fileName?: string) => Promise<void>;

  // Folder operations
  createFolder: (name: string) => Promise<void>;

  // Sharing
  createShareLink: (fileId: string, options?: ShareLinkOptions) => Promise<{ share_link: string; expires_at?: string }>;

  // Bulk operations
  bulkDelete: (ids: string[], options?: { force?: boolean }) => Promise<BulkDeleteResult>;

  // Trash operations
  getTrash: () => Promise<FileItem[]>;
  restoreFromTrash: (fileId: string) => Promise<void>;
  permanentDelete: (fileId: string) => Promise<void>;
  emptyTrash: () => Promise<void>;

  // Data loading
  loadFiles: (folderId?: string | null) => Promise<void>;
  loadStorageStats: () => Promise<void>;
  loadDedupStats: () => Promise<void>;
  loadOfflineData: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshAll: () => Promise<void>;

  // Migration (ZK only)
  migrationStats: MigrationStats | null;
  migrationInProgress: boolean;
  migrationProgress: MigrationProgress;
  migrateFile: (fileId: string) => Promise<{ success?: boolean; skipped?: boolean; reason?: string; newFileId?: string }>;
  migrateAllFiles: (onProgress?: (progress: MigrationProgress) => void) => Promise<MigrationResult>;
  dismissMigrationPrompt: () => void;
  isMigrationPromptDismissed: () => boolean;
  updateMigrationStats: () => Promise<void>;

  // Utility
  getAllItems: () => Array<FileItem | FolderItem>;
  isOnline: boolean;
  lastSyncedAt: string | null;
}
