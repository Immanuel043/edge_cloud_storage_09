/**
 * Dashboard Components Type Definitions
 *
 * Shared types for dashboard UI components.
 * Following best practices:
 * - No `any` types
 * - Explicit interfaces for all props
 * - Proper React event types
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// ==================== Common Types ====================

/**
 * Common dark mode prop used by most dashboard components
 */
export interface DarkModeProps {
  darkMode: boolean;
}

// ==================== File/Folder Types ====================

/**
 * File item data structure
 */
export interface FileItem {
  id: string;
  name: string;
  size: number;
  mime_type?: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
  last_accessed?: string;
  folder_id?: string | null;
  is_favorite?: boolean;
  is_encrypted?: boolean;
  encrypted_file_key?: string;
  encryption_mode?: 'client_zk' | string;
  storage_tier?: 'cache' | 'warm' | 'cold';
  version?: number;
  trashed_at?: string;
}

/**
 * Folder item data structure
 */
export interface FolderItem {
  id: string;
  name: string;
  parent_id?: string | null;
  created_at?: string;
  updated_at?: string;
  file_count?: number;
  is_favorite?: boolean;
}

// ==================== Storage Stats Types ====================

/**
 * Storage distribution by tier
 */
export interface StorageDistribution {
  cache?: { size: number; count: number };
  warm?: { size: number; count: number };
  cold?: { size: number; count: number };
}

/**
 * Storage statistics data
 */
export interface StorageStatsData {
  used?: number;
  quota?: number;
  percentage_used?: number;
  files_count?: number;
  fileCount?: number;
  distribution?: StorageDistribution;
}

// ==================== Upload/Download Types ====================

/**
 * Upload status type
 */
export type UploadStatus = 'uploading' | 'encrypting' | 'complete' | 'error' | 'cancelled';

/**
 * Upload item data structure
 */
export interface UploadItem {
  id: string;
  name: string;
  status: UploadStatus;
  progress: number;
  chunksUploaded: number;
  totalChunks: number;
  bytesUploaded?: number;
  totalBytes?: number;
  error?: string;
  zkEnabled?: boolean;
  elapsedTime?: number;
  serverUploadId?: string;
  isNetworkError?: boolean;
  canRetry?: boolean;
}

/**
 * Download status type
 */
export type DownloadStatus = 'downloading' | 'decrypting' | 'complete' | 'error' | 'cancelled';

/**
 * Download item data structure
 */
export interface DownloadItem {
  id: string;
  fileName: string;
  status: DownloadStatus;
  progress: number;
  chunksDownloaded?: number;
  totalChunks?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
  isZK?: boolean;
  decryptionProgress?: number;
}

// ==================== Sidebar Types ====================

/**
 * Sidebar menu item
 */
export interface MenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  badge?: string | number;
}

/**
 * Sidebar AI feature item
 */
export interface AIMenuItem extends MenuItem {
  isNew?: boolean;
}

// ==================== Filter Types ====================

/**
 * Quick filter option
 */
export interface FilterOption {
  value: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Active filter type
 */
export type FilterValue = 'all' | 'recent' | 'folders' | 'image' | 'document' | 'video' | 'audio';

// ==================== Keyboard Shortcut Types ====================

/**
 * Keyboard shortcut definition
 */
export interface KeyboardShortcut {
  keys: string;
  description: string;
}

// ==================== Component Props ====================

/**
 * Sidebar component props
 */
export interface SidebarProps extends DarkModeProps {
  activeView: string;
  onViewChange: (view: string) => void;
  storageStats: StorageStatsData | null;
  isMobileOpen: boolean;
  onMobileToggle: () => void;
}

/**
 * StorageStats component props
 */
export interface StorageStatsProps extends DarkModeProps {
  stats: StorageStatsData | null;
  onUpgradeClick?: () => void;
}

/**
 * QuickFilters component props
 */
export interface QuickFiltersProps extends DarkModeProps {
  activeFilter?: FilterValue | string;
  onFilterChange: (filter: string) => void;
  isZK?: boolean;
}

/**
 * UploadProgress component props
 */
export interface UploadProgressProps extends DarkModeProps {
  uploads: Record<string, UploadItem>;
  onCancel: (id: string) => void;
  onRetry?: (id: string) => void;
}

/**
 * DownloadProgress component props
 */
export interface DownloadProgressProps extends DarkModeProps {
  downloads: Record<string, DownloadItem> | null;
  onCancel?: (id: string) => void;
}

/**
 * BulkActions component props
 */
export interface BulkActionsProps extends DarkModeProps {
  selectedCount: number;
  onDownload: () => void;
  onDelete: () => void;
  onShare: () => void;
  onClear: () => void;
}

/**
 * KeyboardShortcuts component props
 */
export interface KeyboardShortcutsProps extends DarkModeProps {
  onClose: () => void;
  isZK?: boolean;
}

/**
 * RenameModal component props
 */
export interface RenameModalProps extends DarkModeProps {
  file: FileItem | null;
  onClose: () => void;
  onRename: (fileId: string, newName: string) => Promise<void>;
}

// ==================== File Grid/List Types ====================

/**
 * Menu position for context menu
 */
export interface MenuPosition {
  top: number;
  left: number;
}

/**
 * Name suggestion entry returned by pending-suggestions batch endpoint
 */
export interface NameSuggestionEntry {
  suggested_name: string;
  reason: string;
}

/**
 * FileGrid component props
 */
export interface FileGridProps extends DarkModeProps {
  folders: FolderItem[];
  files: FileItem[];
  emptyState?: ReactNode;
  selectedFiles: Set<string>;
  onFolderClick: (folderId: string, folderName: string) => void;
  onFileClick: (fileId: string, index: number, ctrlKey: boolean, shiftKey: boolean) => void;
  onFilePreview: (file: FileItem) => void;
  onFileDownload: (fileId: string, fileName: string) => void;
  onFileShare: (fileId: string) => void;
  onFileDelete: (fileId: string, fileName: string) => void;
  onVersionHistory: (file: FileItem) => void;
  onToggleFavorite?: ((fileId: string) => void) | undefined;
  onRename?: ((file: FileItem) => void) | undefined;
  onFileInfo?: ((file: FileItem) => void) | undefined;
  onFileCopy?: ((file: FileItem) => void) | undefined;
  trashedView?: boolean | undefined;
  onRestore?: ((fileId: string) => void) | undefined;
  nameSuggestions?: Record<string, NameSuggestionEntry>;
  onAcceptNameSuggestion?: (fileId: string) => void;
  onDismissNameSuggestion?: (fileId: string) => void;
}

/**
 * FileList component props
 */
export interface FileListProps extends FileGridProps {
  isZKMode?: boolean | undefined;
}

/**
 * FileContextMenu component props
 */
export interface FileContextMenuProps extends DarkModeProps {
  file: FileItem;
  isOpen: boolean;
  onClose: () => void;
  position: MenuPosition;
  onFilePreview: (file: FileItem) => void;
  onFileDownload: (fileId: string, fileName: string) => void;
  onFileShare: (fileId: string) => void;
  onFileCopy: ((file: FileItem) => void) | undefined;
  onRename: ((file: FileItem) => void) | undefined;
  onVersionHistory: (file: FileItem) => void;
  onFileInfo: ((file: FileItem) => void) | undefined;
  onFileDelete: (fileId: string, fileName: string) => void;
  trashedView: boolean | undefined;
  onRestore: ((fileId: string) => void) | undefined;
}

// ==================== File Info Panel Types ====================

/**
 * Tab definition for FileInfoPanel
 */
export interface FileInfoTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

/**
 * FileInfoPanel component props
 */
export interface FileInfoPanelProps extends DarkModeProps {
  file: FileItem | null;
  onClose: () => void;
  onRename?: (file: FileItem) => void;
  isZK?: boolean;
}

// ==================== File Thumbnail Types ====================

/**
 * Thumbnail size options
 */
export type ThumbnailSize = 'small' | 'medium' | 'large';

/**
 * FileThumbnail component props
 */
export interface FileThumbnailProps {
  file: FileItem & {
    file_name?: string;
    file_id?: string;
    file_size?: number;
    allow_preview?: boolean;
    file_key_iv?: string;
  };
  size?: ThumbnailSize;
  darkMode?: boolean;
  className?: string;
}

// ==================== Search Types ====================

/**
 * Search filters
 */
export interface SearchFilters {
  mime_type: string;
  storage_tier: string;
  size_min: string | number;
  size_max: string | number;
  date_from: string;
  date_to: string;
}

/**
 * Smart search status response
 */
export interface SmartSearchStatus {
  semantic_enabled: boolean;
  coverage_percent?: number;
}

/**
 * Search mode type
 */
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

/**
 * SearchBar component props
 */
export interface SearchBarProps extends DarkModeProps {
  onSearch: (results: SearchResults | null) => void;
  zkMode?: boolean;
  files?: FileItem[];
}

/**
 * Search result hit
 */
export interface SearchHit {
  id: string;
  name: string;
  size?: number | undefined;
  mime_type?: string | undefined;
  created_at?: string | undefined;
  storage_tier?: string | undefined;
  is_encrypted?: boolean | undefined;
  score?: number | undefined;
  semantic_score?: number | undefined;
  hybrid_score?: number | undefined;
  highlight?: {
    name?: string[];
  } | undefined;
  path?: string | undefined;
  tags?: { tag: string; source: string; confidence: number }[] | undefined;
}

/**
 * Search results structure
 */
export interface SearchResults {
  files?: {
    hits: SearchHit[];
    total: number;
  } | undefined;
  folders?: {
    hits: SearchHit[];
    total: number;
  } | undefined;
  mode?: SearchMode | 'client-side' | undefined;
  semantic_enabled?: boolean | undefined;
  zk_mode?: boolean | undefined;
}

/**
 * SearchResults component props
 */
export interface SearchResultsProps extends DarkModeProps {
  results: SearchResults | null;
  onClose: () => void;
  onFileClick: (file: { id: string; name: string }) => void;
  onFolderClick: (folderId: string) => void;
}

// ==================== Filter Panel Types ====================

/**
 * Filter panel filter state
 */
export interface FilterPanelFilters {
  type: string;
  size: string;
  date: string;
}

/**
 * FilterPanel component props
 */
export interface FilterPanelProps extends DarkModeProps {
  filters: FilterPanelFilters;
  setFilters: React.Dispatch<React.SetStateAction<FilterPanelFilters>>;
}

// ==================== View Components Types ====================

/**
 * View mode type
 */
export type ViewMode = 'grid' | 'list';

/**
 * Common view component props
 */
export interface FileViewBaseProps extends DarkModeProps {
  viewMode: ViewMode;
  selectedFiles: Set<string>;
  onFileClick: (fileId: string, index: number, ctrlKey: boolean, shiftKey: boolean) => void;
  onFilePreview: (file: FileItem) => void;
  onFileDownload: (fileId: string, fileName: string) => void;
  onFileShare: (fileId: string) => void;
  onFileDelete: (fileId: string, fileName?: string) => void;
  onVersionHistory: (file: FileItem) => void;
}

/**
 * FavoritesView component props
 */
export interface FavoritesViewProps extends FileViewBaseProps {}

/**
 * RecentsView component props
 */
export interface RecentsViewProps extends FileViewBaseProps {}

/**
 * SharedWithMeView component props
 */
export interface SharedWithMeViewProps extends FileViewBaseProps {
  onToggleFavorite?: (fileId: string) => void;
  onRename?: (file: FileItem) => void;
}

// ==================== Modal Components Types ====================

/**
 * Share data from API
 */
export interface ShareData {
  share_url?: string;
  expires_at?: string;
  password_protected?: boolean;
  max_downloads?: number;
  downloads_used?: number;
  invited_count?: number;
  invited_emails?: string[];
}

/**
 * ShareModal component props
 */
export interface ShareModalProps extends DarkModeProps {
  shareData: ShareData | null;
  onClose: () => void;
}

/**
 * FileCorruptionModal component props
 */
export interface FileCorruptionModalProps extends DarkModeProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  errorMessage?: string;
}

/**
 * URLUploadModal component props
 */
export interface URLUploadModalProps extends DarkModeProps {
  isOpen: boolean;
  onClose: () => void;
  onUploadComplete?: () => void;
}

/**
 * URL upload progress response
 */
export interface URLUploadProgress {
  file_name?: string;
  file_size?: number;
  status?: string;
}

// ==================== Banner Components Types ====================

/**
 * ZKStorageStats component props
 */
export interface ZKStorageStatsProps extends DarkModeProps {
  stats: StorageStatsData | null;
  onUpgradeClick?: () => void;
}

/**
 * Payment reminder data from API
 */
export interface PaymentReminderData {
  days_until_payment: number;
  plan_name: string;
  billing_cycle: string;
  payment_due_date: string;
  amount_due: number;
}

/**
 * PaymentReminderBanner component props
 */
export interface PaymentReminderBannerProps extends DarkModeProps {}

/**
 * FreeAccountUpgradeBanner component props
 */
export interface FreeAccountUpgradeBannerProps extends DarkModeProps {}

/**
 * Migration stats data
 */
export interface MigrationStats {
  migrationNeeded: boolean;
  v1Files?: number;
  totalFiles?: number;
}

/**
 * Migration progress data
 */
export interface MigrationProgress {
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Migration result data
 */
export interface MigrationResult {
  completed: number;
  failed: number;
  skipped: number;
}

// ==================== Type Guards ====================

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

// ==================== Deduplication Types ====================

/**
 * Deduplication savings data
 */
export interface DeduplicationSavings {
  logical_size: number;
  physical_size: number;
  saved_size: number;
  storage_efficiency: number;
  savings_percentage: number;
}

/**
 * Deduplication analytics blocks data
 */
export interface DeduplicationBlocks {
  total_blocks: number;
  avg_references: number;
}

/**
 * Deduplication analytics summary
 */
export interface DeduplicationSummary {
  total_files: number;
  dedup_ratio: number;
  compression_ratio: number;
}

/**
 * Deduplication analytics data
 */
export interface DeduplicationAnalytics {
  blocks?: DeduplicationBlocks;
  summary?: DeduplicationSummary;
}

/**
 * Deduplication stats
 */
export interface DeduplicationStats {
  savings: DeduplicationSavings | null;
  analytics: DeduplicationAnalytics | null;
  error: string | null;
}

/**
 * DeduplicationPanel component props
 */
export interface DeduplicationPanelProps extends DarkModeProps {
  onOptimizeFile?: (fileId: string) => Promise<{ status?: string; error?: string }>;
  stats: DeduplicationStats | null;
  loading: boolean;
  onRefresh: () => void;
}

// ==================== ZK Encryption Status Types ====================

/**
 * ZKEncryptionStatus component props
 */
export interface ZKEncryptionStatusProps extends DarkModeProps {
  isUnlocked: boolean;
  onLock?: () => void;
  kdfAlgorithm?: string;
  kdfIterations?: number;
  kdfMemory?: number;
}

// ==================== File Activity Types ====================

/**
 * File activity action type
 */
export type FileActivityAction =
  | 'file_uploaded'
  | 'file_modified'
  | 'file_downloaded'
  | 'file_shared'
  | 'file_viewed'
  | 'file_renamed'
  | 'file_deleted'
  | 'upload'
  | 'download';

/**
 * File activity metadata
 */
export interface FileActivityMetadata {
  old_name?: string;
  new_name?: string;
  [key: string]: unknown;
}

/**
 * File activity item
 */
export interface FileActivity {
  id: string;
  action: FileActivityAction;
  created_at: string;
  ip_address?: string;
  metadata?: FileActivityMetadata;
}

/**
 * FileActivityTab component props
 */
export interface FileActivityTabProps extends DarkModeProps {
  file: FileItem;
}

// ==================== File Security Types ====================

/**
 * File encryption info
 */
export interface FileEncryptionInfo {
  enabled: boolean;
  algorithm: string;
  status: string;
}

/**
 * File virus scan info
 */
export interface FileVirusScanInfo {
  status: 'clean' | 'infected';
  lastScanned: string;
  scanner: string;
}

/**
 * File permissions
 */
export interface FilePermissions {
  canView: boolean;
  canDownload: boolean;
  canEdit: boolean;
  canShare: boolean;
}

/**
 * Share link info
 */
export interface ShareLinkInfo {
  access_type?: string;
  password_protected?: boolean;
  expires_at?: string;
}

/**
 * Shared with person info
 */
export interface SharedWithPerson {
  email: string;
  role?: string;
}

/**
 * FileSecurityTab component props
 */
export interface FileSecurityTabProps extends DarkModeProps {
  file: FileItem & {
    share_links?: ShareLinkInfo[];
    shared_with?: SharedWithPerson[];
  };
}

// ==================== File Details Types ====================

/**
 * FileDetailsTab component props
 */
export interface FileDetailsTabProps extends DarkModeProps {
  file: FileItem & {
    tags?: string[];
    pages?: number;
    folder_path?: string;
  };
  onRename?: ((file: FileItem) => void) | undefined;
  isZK?: boolean;
}

// ==================== Analytics Types ====================

/**
 * File type distribution item
 */
export interface FileTypeDistributionItem {
  type: string;
  count: number;
  size: number;
  icon: LucideIcon;
  color: string;
}

/**
 * Monthly activity data
 */
export interface MonthlyActivity {
  month: string;
  uploads: number;
  downloads: number;
}

/**
 * ML insight item
 */
export interface MLInsight {
  feature: string;
  status: string;
  predictions?: number;
  accuracy?: number;
  savings?: string;
  recommendations?: number;
  filesOrganized?: number;
  clusters?: number;
  suggested?: number;
  accepted?: number;
}

/**
 * Analytics data structure
 */
export interface AnalyticsData {
  fileTypeDistribution: FileTypeDistributionItem[];
  uploadTrend: MonthlyActivity[];
  totalFiles: number;
  totalSize: number;
  mlInsights: MLInsight[];
}

/**
 * AnalyticsView component props
 */
export interface AnalyticsViewProps extends DarkModeProps {
  storageStats?: StorageStatsData | null;
}

/**
 * EnhancedAnalyticsView component props
 */
export interface EnhancedAnalyticsViewProps extends DarkModeProps {
  storageStats?: StorageStatsData | null;
}

// ==================== File Preview Types ====================

/**
 * SecureVideoPlayer component props
 */
export interface SecureVideoPlayerProps {
  fileId: string;
  metadata?: FileItem;
  darkMode?: boolean;
  onClose?: () => void;
  className?: string;
}

/**
 * ZK Decrypt Progress
 */
export interface ZKDecryptProgress {
  stage: 'starting' | 'downloading' | 'decrypting' | 'complete';
  progress: number;
  chunk?: number;
  totalChunks?: number;
}

/**
 * Transcode Progress Response
 */
export interface TranscodeProgressResponse {
  status: 'complete' | 'transcoding' | 'not_started' | 'rejected';
  percent?: number;
  fps?: number;
  eta_seconds?: number;
  // Populated only when status === 'rejected'
  reason?: 'size_or_duration' | 'worker_failed';
  duration_seconds?: number | null;
  size_bytes?: number | null;
  max_size_gib?: number;
  max_duration_minutes?: number;
  message?: string;
}

export interface TranscodeRejection {
  reason: 'size_or_duration' | 'worker_failed';
  durationSeconds: number | null;
  sizeBytes: number | null;
  maxSizeGib: number;
  maxDurationMinutes: number;
  message: string;
}

/**
 * FilePreview component props
 */
export interface FilePreviewProps extends DarkModeProps {
  file: FileItem & {
    file_name?: string;
    file_id?: string;
    file_size?: number;
    allow_preview?: boolean;
    file_key_iv?: string;
    chunk_size?: number;
  };
  onClose: () => void;
}

// ==================== Version History Types ====================

/**
 * File version item
 */
export interface FileVersion {
  id: string;
  version: number;
  created_at: string;
  size: number;
  created_by?: string;
  change_description?: string;
  is_current?: boolean;
  version_number?: number;
  comment?: string;
  file_size?: number;
}

/**
 * VersionHistory component props
 */
export interface VersionHistoryProps extends DarkModeProps {
  file: FileItem;
  onClose: () => void;
  onRestore?: (versionId: string) => Promise<void>;
}

// ==================== Share Options Types ====================

/**
 * ShareOptionsModal component props
 */
export interface ShareOptionsModalProps extends DarkModeProps {
  file?: FileItem;
  folder?: FolderItem;
  onClose: () => void;
  onShareComplete?: (shareData: ShareData) => void;
}

// ==================== Share Bundle Types ====================

/**
 * Share bundle result
 */
export interface ShareBundleResult {
  share_url: string;
  file_count?: number;
  total_size?: number;
  share_type?: string;
  expires_at?: string;
  password_protected?: boolean;
  excluded_zk_count?: number;
  warning?: string;
}

/**
 * ShareBundleComposer component props
 */
export interface ShareBundleComposerProps extends DarkModeProps {
  selectedFiles?: FileItem[];
  selectedFolders?: FolderItem[];
  onClose: () => void;
  onSuccess?: () => void;
}

// ==================== ZK Dashboard Layout Types ====================

/**
 * Upload progress data
 */
export interface UploadProgressData {
  progress: number;
  chunksUploaded: number;
  totalChunks: number;
  bytesUploaded?: number;
}

/**
 * Download progress data
 */
export interface DownloadProgressData {
  status: DownloadStatus;
  progress: number;
  downloadProgress?: number;
  decryptProgress?: number;
  currentStage?: string;
  currentChunk?: number;
  totalChunks?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
  isZK?: boolean;
}

/**
 * Upload error info
 */
export interface UploadErrorInfo {
  type: string;
  message: string;
  fileName: string;
}

/**
 * Corruption error info
 */
export interface CorruptionErrorInfo {
  fileName: string;
  errorMessage: string;
}

/**
 * Pending Download Info
 */
export interface PendingDownload {
  fileId: string;
  fileName: string;
}

/**
 * Active View Type
 */
export type ActiveViewType =
  | 'cloud-drive'
  | 'recents'
  | 'favorites'
  | 'shared-with-me'
  | 'trash'
  | 'dedup'
  | 'analytics'
  | 'auto-organize'
  | 'recommendations'
  | 'quota-alerts'
  | 'storage-optimization'
  | 'settings'
  | 'billing'
  | 'payment-portal'
  | 'security-alerts'
  | 'my-share-links'
  | 'share-analytics';

/**
 * Sort By Type
 */
export type SortByType = 'name' | 'date' | 'size' | 'type';

/**
 * ZKDashboard component props
 * Theme, auth, and storage are read from contexts directly.
 * Only cross-dashboard handoff props are passed from the parent.
 */
export interface ZKDashboardProps {
  pendingDownload?: PendingDownload | null;
  onClearPendingDownload?: () => void;
}

/**
 * NormalDashboard Props - props passed from parent Dashboard
 */
export interface NormalDashboardProps {
  // Callback to lift pending download state to parent Dashboard for cross-dashboard retry
  onPendingDownload?: (download: PendingDownload | null) => void;
}

// ==================== Settings View Types ====================

/**
 * Index Status Response
 */
export interface IndexStatus {
  elasticsearch_status: 'connected' | 'disconnected';
  sync_status: 'synced' | 'out_of_sync';
  database_files: number;
  indexed_files: number;
}

/**
 * Reindex Result
 */
export interface ReindexResult {
  success: boolean;
  message: string;
  indexed?: number;
  failed?: number;
  total?: number;
}

/**
 * Video Optimization Mode
 */
export type VideoOptimizationMode = 'keep_both' | 'optimized' | 'no_optimization';

/**
 * Video Settings Response
 */
export interface VideoSettingsResponse {
  mode: VideoOptimizationMode;
}

/**
 * SettingsView component props
 */
export interface SettingsViewProps extends DarkModeProps {}

// ==================== Trash View Types ====================

/**
 * TrashView component props
 */
export interface TrashViewProps extends FileViewBaseProps {
  onRestore?: (fileId: string) => void;
  onToggleFavorite?: (fileId: string) => void;
  onFileInfo?: (file: FileItem) => void;
  onRefresh?: () => void | Promise<void>;
}

// ==================== Quota Alerts Types ====================

/**
 * Quota prediction data
 */
export interface QuotaPrediction {
  days_until_full: number | null;
  will_exceed_quota?: boolean;
  predicted_7d?: number;
  predicted_14d?: number;
  predicted_30d?: number;
  confidence_7d?: number;
  confidence_14d?: number;
  confidence_30d?: number;
  current_usage_bytes?: number;
  quota_bytes?: number;
  usage_percent?: number;
  model_type?: string;
  prediction_date?: string;
}

/**
 * Quota alert item
 */
export interface QuotaAlert {
  id: string;
  alert_type: '95_percent' | '85_percent' | '70_percent' | 'predicted_full' | string;
  message: string;
  current_usage_bytes?: number;
  quota_bytes?: number;
  usage_percent?: number;
  created_at: string;
}

/**
 * QuotaAlertsView component props
 */
export interface QuotaAlertsViewProps extends DarkModeProps {
  storageStats?: StorageStatsData | null;
}

// ==================== Auto Organize Types ====================

/**
 * Organization cluster
 */
export interface OrganizationCluster {
  id: string;
  cluster_id?: string;
  cluster_name?: string;
  cluster_description?: string;
  num_files: number;
  total_size: number;
  common_extensions?: string[];
  top_keywords?: string[];
  suggested_folder_path?: string;
}

/**
 * Organization rule
 */
export interface OrganizationRule {
  id: string;
  rule_name: string;
  rule_type: string;
  target_folder_path: string;
  file_extensions?: string[];
  keywords?: string[];
  auto_apply?: boolean;
  is_active?: boolean;
  priority?: number;
  files_organized?: number;
}

/**
 * AutoOrganizeView component props
 */
export interface AutoOrganizeViewProps extends DarkModeProps {
  onNavigate?: (path: string) => void;
}

// ==================== Recommendations Types ====================

/**
 * Recommendation item
 */
export interface Recommendation {
  id: string;
  recommended_file: FileItem;
  reason?: string;
  recommendation_score?: number;
  feedbackGiven?: 'positive' | 'negative';
}

/**
 * Recommendation summary
 */
export interface RecommendationSummary {
  total_recommendations?: number;
  accepted?: number;
  accuracy?: number;
}

/**
 * Trending file item
 */
export interface TrendingFile extends FileItem {
  access_count?: number;
  interaction_count?: number;
  file_name?: string;
  file_size?: number;
}

/**
 * RecommendationsView component props
 */
export interface RecommendationsViewProps extends DarkModeProps {
  onFileClick?: (file: FileItem) => void;
}
