/**
 * Frontend-specific types (UI state, React props, etc.)
 */

import { FileObject, Folder } from './file.types';
import { User, ZKData } from './user.types';

// Context Types
export interface AuthContextValue {
  user: User | null;
  zkEnabled: boolean;
  zkSessionUnlocked: boolean;
  zkRecoveryEnabled: boolean;
  zkData: ZKData | null;
  login: (email: string, password: string) => Promise<void>;
  loginZK: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  unlockZKSession: (password: string) => Promise<boolean>;
  isLoading: boolean;
  error: string | null;
}

export interface StorageContextValue {
  files: FileObject[];
  folders: Folder[];
  currentFolder: Folder | null;
  storageUsed: number;
  storageQuota: number;
  isLoading: boolean;
  error: string | null;
  refreshFiles: () => Promise<void>;
  uploadFile: (file: File, folderId?: string) => Promise<void>;
  deleteFile: (fileId: string) => Promise<void>;
}

export interface NotificationContextValue {
  showNotification: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
  notifications: Notification[];
}

export interface Notification {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  timestamp: number;
}

export type ViewMode = 'grid' | 'list';
export type SortField = 'name' | 'size' | 'date' | 'type';
export type SortDirection = 'asc' | 'desc';

export interface FileGridProps {
  files: FileObject[];
  onFileClick: (file: FileObject) => void;
  onFileSelect: (fileId: string, selected: boolean) => void;
  selectedFiles: Set<string>;
  viewMode: ViewMode;
  isLoading?: boolean;
}
