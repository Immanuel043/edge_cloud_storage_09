import React, { useState, useMemo } from 'react';
import {
  Share2,
  Link2,
  Copy,
  Check,
  Lock,
  Clock,
  Download,
  Eye,
  AlertCircle,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  Zap,
  Package,
  Folder,
} from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { API_URL } from '../../config/constants';
import type { ShareBundleComposerProps, ShareBundleResult } from './types';
import { getErrorMessage } from './types';
import type { LucideIcon } from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  FormField,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
} from '@/components/ui';
import { cn } from '@/lib/cn';

type ShareType = 'view' | 'download';

interface QuickPreset {
  label: string;
  shareType: ShareType;
  expiresHours: number | null;
  icon: LucideIcon;
}

// Quick share presets
const QUICK_PRESETS: QuickPreset[] = [
  { label: 'View 24h', shareType: 'view', expiresHours: 24, icon: Eye },
  { label: 'Download 7d', shareType: 'download', expiresHours: 168, icon: Download },
  { label: 'Permanent link', shareType: 'view', expiresHours: null, icon: Link2 },
];

interface ShareBundleRequest {
  file_ids: string[];
  folder_ids: string[];
  name: string;
  share_type: ShareType;
  expires_hours: number | null;
  password: string | null;
  max_downloads: number | null;
  allow_preview: boolean;
  allow_zip_download: boolean;
  show_file_sizes: boolean;
  watermark_text: string | null;
}

interface ShareBundleError {
  detail?: string;
}

/**
 * ShareBundleComposer — modal for creating share bundles. Two-state UI:
 * the composer form and the success card revealing the share URL.
 */
const ShareBundleComposer: React.FC<ShareBundleComposerProps> = ({
  selectedFiles = [],
  selectedFolders = [],
  onClose,
  onSuccess,
}) => {
  const [bundleName, setBundleName] = useState<string>('');
  const [shareType, setShareType] = useState<ShareType>('view');
  const [expiresHours, setExpiresHours] = useState<number | null>(null);
  const [password, setPassword] = useState<string>('');
  const [maxDownloads, setMaxDownloads] = useState<number | null>(null);
  const [allowPreview, setAllowPreview] = useState<boolean>(true);
  const [allowZipDownload, setAllowZipDownload] = useState<boolean>(true);
  const [showFileSizes, setShowFileSizes] = useState<boolean>(true);
  const [watermarkText, setWatermarkText] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [shareResult, setShareResult] = useState<ShareBundleResult | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Calculate total size (files only — folder sizes calculated on backend)
  const totalSize = useMemo(() => {
    return selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  }, [selectedFiles]);

  const totalItems = selectedFiles.length + selectedFolders.length;

  // Check for ZK-encrypted files that cannot be shared via bundles
  const zkFiles = selectedFiles.filter(
    (f) => f.is_encrypted || f.encrypted_file_key || f.encryption_mode === 'client_zk'
  );
  const hasZKFiles = zkFiles.length > 0;
  const allFilesAreZK = zkFiles.length === selectedFiles.length && selectedFolders.length === 0;

  const defaultBundleName = useMemo(() => {
    if (selectedFolders.length === 1 && selectedFiles.length === 0) {
      return selectedFolders[0]?.name || 'Bundle';
    }
    if (selectedFiles.length === 1 && selectedFolders.length === 0) {
      return selectedFiles[0]?.name || 'Bundle';
    }
    const parts: string[] = [];
    if (selectedFolders.length > 0) {
      parts.push(`${selectedFolders.length} folder${selectedFolders.length > 1 ? 's' : ''}`);
    }
    if (selectedFiles.length > 0) {
      parts.push(`${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`);
    }
    return parts.join(' + ') + ' shared';
  }, [selectedFiles, selectedFolders]);

  const handleQuickPreset = (preset: QuickPreset): void => {
    setShareType(preset.shareType);
    setExpiresHours(preset.expiresHours);
  };

  const handleCreateBundle = async (): Promise<void> => {
    if (selectedFiles.length === 0 && selectedFolders.length === 0) {
      setError('Please select at least one file or folder');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const requestBody: ShareBundleRequest = {
        file_ids: selectedFiles.map((f) => f.id),
        folder_ids: selectedFolders.map((f) => f.id),
        name: bundleName || defaultBundleName,
        share_type: shareType,
        expires_hours: expiresHours,
        password: password || null,
        max_downloads: maxDownloads,
        allow_preview: allowPreview,
        allow_zip_download: allowZipDownload,
        show_file_sizes: showFileSizes,
        watermark_text: watermarkText.trim() || null,
      };

      const response = await fetch(`${API_URL}/api/v1/share-bundles`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as ShareBundleError;
        throw new Error(errorData.detail || 'Failed to create share bundle');
      }

      const result = (await response.json()) as ShareBundleResult;
      setShareResult(result);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to create share bundle:', err);
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyLink = async (): Promise<void> => {
    if (shareResult?.share_url) {
      try {
        await navigator.clipboard.writeText(shareResult.share_url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err: unknown) {
        console.error('Failed to copy:', err);
      }
    }
  };

  const getFileIcon = (mimeType?: string): LucideIcon => {
    if (!mimeType) return FileText;
    if (mimeType.startsWith('image/')) return Image;
    if (mimeType.startsWith('video/')) return Video;
    if (mimeType.startsWith('audio/')) return Music;
    if (mimeType.includes('zip') || mimeType.includes('archive')) return Archive;
    if (mimeType.includes('code') || mimeType.includes('javascript') || mimeType.includes('json')) {
      return Code;
    }
    return FileText;
  };

  // Success state — show the share link
  if (shareResult) {
    return (
      <Modal open onClose={onSuccess || onClose} size="md">
        <ModalHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-success/80 to-success">
              <Check className="text-white" size={24} />
            </div>
            <div>
              <h2 className="text-h2 font-bold text-fg">Share bundle created</h2>
              <p className="text-body-sm text-fg-muted">
                {shareResult.file_count || 0} files · {formatBytes(shareResult.total_size || 0)}
              </p>
            </div>
          </div>
        </ModalHeader>

        <ModalBody>
          <div className="space-y-4">
            <FormField label="Share link">
              <div className="flex gap-2">
                <Input type="text" value={shareResult.share_url} readOnly className="flex-1" />
                <Button
                  variant={copied ? 'primary' : 'secondary'}
                  onClick={() => void handleCopyLink()}
                  leftIcon={copied ? <Check size={18} /> : <Copy size={18} />}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </FormField>

            {shareResult.excluded_zk_count != null && shareResult.excluded_zk_count > 0 && (
              <Banner variant="warning" icon={<AlertCircle />}>
                {shareResult.excluded_zk_count} ZK-encrypted file
                {shareResult.excluded_zk_count > 1 ? 's were' : ' was'} excluded from this bundle.
              </Banner>
            )}

            <div className="rounded-xl bg-surface-muted p-4">
              <div className="grid grid-cols-2 gap-4 text-body-sm">
                <div>
                  <span className="text-fg-muted">Access:</span>
                  <span className="ml-2 font-medium text-fg">
                    {shareResult.share_type === 'download' ? 'Download' : 'View only'}
                  </span>
                </div>
                <div>
                  <span className="text-fg-muted">Expires:</span>
                  <span className="ml-2 font-medium text-fg">
                    {shareResult.expires_at
                      ? new Date(shareResult.expires_at).toLocaleDateString()
                      : 'Never'}
                  </span>
                </div>
                {shareResult.password_protected && (
                  <div className="col-span-2">
                    <Badge variant="accent" size="sm">
                      <Lock size={12} />
                      Password protected
                    </Badge>
                  </div>
                )}
              </div>
            </div>
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="primary" fullWidth onClick={onSuccess || onClose}>
            Done
          </Button>
        </ModalFooter>
      </Modal>
    );
  }

  // Main composer UI
  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent">
            <Package className="text-white" size={24} />
          </div>
          <div>
            <h2 className="text-h2 font-bold text-fg">Create share bundle</h2>
            <p className="text-body-sm text-fg-muted">
              Share {totalItems} {totalItems === 1 ? 'item' : 'items'} with a single link
            </p>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        <div className="space-y-6">
          {/* Quick presets */}
          <div>
            <div className="mb-3 flex items-center gap-2 text-body-sm font-medium text-fg">
              <Zap size={14} />
              Quick presets
            </div>
            <div className="flex flex-wrap gap-2">
              {QUICK_PRESETS.map((preset, idx) => {
                const Icon = preset.icon;
                const isActive =
                  shareType === preset.shareType && expiresHours === preset.expiresHours;
                return (
                  <Button
                    key={idx}
                    variant={isActive ? 'primary' : 'secondary'}
                    size="sm"
                    leftIcon={<Icon size={16} />}
                    onClick={() => handleQuickPreset(preset)}
                  >
                    {preset.label}
                  </Button>
                );
              })}
            </div>
          </div>

          {/* ZK encrypted file warning */}
          {hasZKFiles && (
            <Banner variant="warning" icon={<AlertCircle />}>
              {allFilesAreZK
                ? 'All selected files use ZK encryption and cannot be shared via bundles.'
                : `${zkFiles.length} ZK-encrypted file${
                    zkFiles.length > 1 ? 's' : ''
                  } will be excluded from the bundle. Only non-ZK files will be shared.`}
            </Banner>
          )}

          {/* Selected items preview */}
          <div>
            <div className="mb-3 text-body-sm font-medium text-fg">
              Selected items ({totalItems})
              {totalSize > 0 && ` · ${formatBytes(totalSize)}`}
              {selectedFolders.length > 0 && ' + folder contents'}
            </div>
            <div className="max-h-40 overflow-y-auto rounded-xl border border-border bg-surface-muted">
              {selectedFolders.map((folder, idx) => (
                <div
                  key={folder.id}
                  className={cn(
                    'flex items-center gap-3 px-4 py-2.5',
                    (idx !== selectedFolders.length - 1 || selectedFiles.length > 0) &&
                      'border-b border-border'
                  )}
                >
                  <Folder size={18} className="text-primary" />
                  <span className="flex-1 truncate text-body-sm text-fg">{folder.name}</span>
                  <Badge variant="info" size="sm">
                    Folder
                  </Badge>
                </div>
              ))}
              {selectedFiles.map((file, idx) => {
                const IconComponent = getFileIcon(file.mime_type);
                return (
                  <div
                    key={file.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5',
                      idx !== selectedFiles.length - 1 && 'border-b border-border'
                    )}
                  >
                    <IconComponent size={18} className="text-fg-muted" />
                    <span className="flex-1 truncate text-body-sm text-fg">{file.name}</span>
                    <span className="text-caption text-fg-subtle">{formatBytes(file.size)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bundle name */}
          <FormField label="Bundle name">
            <Input
              type="text"
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              placeholder={defaultBundleName}
            />
          </FormField>

          {/* Share type */}
          <div>
            <div className="mb-2 text-body-sm font-medium text-fg">Access type</div>
            <div className="flex gap-3">
              <Button
                variant={shareType === 'view' ? 'primary' : 'secondary'}
                fullWidth
                leftIcon={<Eye size={18} />}
                onClick={() => setShareType('view')}
              >
                View only
              </Button>
              <Button
                variant={shareType === 'download' ? 'primary' : 'secondary'}
                fullWidth
                leftIcon={<Download size={18} />}
                onClick={() => setShareType('download')}
              >
                Download
              </Button>
            </div>
          </div>

          {/* Expiration */}
          <FormField
            label={
              <span className="flex items-center gap-2">
                <Clock size={14} />
                Expiration
              </span>
            }
          >
            <Select
              value={expiresHours || 'never'}
              onChange={(e) =>
                setExpiresHours(e.target.value === 'never' ? null : parseInt(e.target.value))
              }
            >
              <option value="1">1 hour</option>
              <option value="24">24 hours</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
              <option value="never">Never expires</option>
            </Select>
          </FormField>

          {/* Password protection */}
          <FormField
            label={
              <span className="flex items-center gap-2">
                <Lock size={14} />
                Password protection (optional)
              </span>
            }
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave empty for no password"
            />
          </FormField>

          {/* Advanced options */}
          <div className="rounded-xl bg-surface-muted p-4">
            <div className="mb-3 text-body-sm font-medium text-fg">Advanced options</div>
            <div className="space-y-3">
              <Checkbox
                checked={allowPreview}
                onChange={(e) => setAllowPreview(e.target.checked)}
                label="Allow file preview"
              />
              <Checkbox
                checked={allowZipDownload}
                onChange={(e) => setAllowZipDownload(e.target.checked)}
                label="Allow ZIP download (all files)"
              />
              <Checkbox
                checked={showFileSizes}
                onChange={(e) => setShowFileSizes(e.target.checked)}
                label="Show file sizes to viewers"
              />
              <FormField label="Watermark text (overlaid on previews)">
                <Input
                  type="text"
                  value={watermarkText}
                  onChange={(e) => setWatermarkText(e.target.value)}
                  placeholder="e.g. Confidential"
                  maxLength={100}
                />
              </FormField>
              <FormField label="Max downloads">
                <Input
                  type="number"
                  min={1}
                  value={maxDownloads ?? ''}
                  onChange={(e) =>
                    setMaxDownloads(e.target.value ? parseInt(e.target.value) : null)
                  }
                  placeholder="Unlimited"
                  className="max-w-[12rem]"
                />
              </FormField>
            </div>
          </div>

          {/* Error */}
          {error && (
            <Banner variant="danger" icon={<AlertCircle />}>
              {error}
            </Banner>
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={isCreating}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={isCreating}
          disabled={
            isCreating ||
            (selectedFiles.length === 0 && selectedFolders.length === 0) ||
            allFilesAreZK
          }
          leftIcon={!isCreating ? <Share2 size={18} /> : undefined}
          onClick={() => void handleCreateBundle()}
        >
          {isCreating ? 'Creating...' : 'Create share link'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default ShareBundleComposer;
