import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download,
  Lock,
  AlertCircle,
  FileText,
  Eye,
  Package,
  Image as ImageIcon,
  Video,
  Music,
  File,
  Archive,
  Code,
  Play,
  Folder,
  ChevronRight,
  Grid,
  List,
  Table as TableIcon,
  FileCode,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes, VIDEO_EXTENSIONS } from '../../utils/helpers';
import type {
  BundleInfo,
  ShareFile,
  ViewMode,
  GroupedFiles,
} from './types';
import { isBundleInfo, getErrorMessage } from './types';
import { cn } from '@/lib/cn';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  FormField,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalHeader,
  Spinner,
} from '@/components/ui';

// Image extensions for fallback detection
const IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
] as const;
const EXCEL_EXTENSIONS = ['xlsx', 'xls', 'csv'] as const;
const XML_EXTENSIONS = ['xml', 'xsl', 'xslt'] as const;
const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'yaml', 'yml', 'ini', 'conf', 'log'] as const;

/**
 * ShareBundleViewer — public page for multi-file share bundles.
 *
 * Rebuilt on Signal primitives (Modal/Card/Button/IconButton/Badge/Banner/
 * FormField/Input/Spinner). Grid + list views, folder expand/collapse,
 * password gate, preview modal with video/audio/pdf/image/text/excel
 * branches — all logic unchanged.
 */
const ShareBundleViewer: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [requiresPassword, setRequiresPassword] = useState<boolean>(false);
  const [password, setPassword] = useState<string>('');
  const [bundleInfo, setBundleInfo] = useState<BundleInfo | null>(null);
  const [previewFile, setPreviewFile] = useState<ShareFile | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloadError, setDownloadError] = useState<string>('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Group files by folder path
  const groupedFiles = useMemo((): GroupedFiles => {
    if (!bundleInfo?.files) return { rootFiles: [], folders: {} };

    const rootFiles: ShareFile[] = [];
    const folders: Record<string, ShareFile[]> = {};

    bundleInfo.files.forEach((file) => {
      if (!file.folder_path) {
        rootFiles.push(file);
      } else {
        const pathParts = file.folder_path.split('/').filter(Boolean);
        const topFolder = pathParts[0] || '';

        if (!folders[topFolder]) {
          folders[topFolder] = [];
        }
        folders[topFolder].push({
          ...file,
          relativePath: pathParts.slice(1).join('/'),
        });
      }
    });

    return { rootFiles, folders };
  }, [bundleInfo?.files]);

  const toggleFolder = (folderName: string): void => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) {
        next.delete(folderName);
      } else {
        next.add(folderName);
      }
      return next;
    });
  };

  // Auto-expand all folders initially
  useEffect(() => {
    if (bundleInfo?.files) {
      const folderNames = new Set<string>();
      bundleInfo.files.forEach((file) => {
        if (file.folder_path) {
          const topFolder = file.folder_path.split('/').filter(Boolean)[0];
          if (topFolder) {
            folderNames.add(topFolder);
          }
        }
      });
      setExpandedFolders(folderNames);
    }
  }, [bundleInfo?.files]);

  // --- Media detection helpers ---
  const getFileExtension = (filename: string | undefined): string => {
    return filename?.split('.').pop()?.toLowerCase() || '';
  };

  const isVideoFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.startsWith('video/') ||
      (VIDEO_EXTENSIONS as readonly string[]).includes(extension)
    );
  };

  const isAudioFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.startsWith('audio/') ||
      ['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(extension)
    );
  };

  const isImageFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.startsWith('image/') ||
      (IMAGE_EXTENSIONS as readonly string[]).includes(extension)
    );
  };

  const isPdfFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType === 'application/pdf' || extension === 'pdf';
  };

  const isExcelFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      (EXCEL_EXTENSIONS as readonly string[]).includes(extension)
    );
  };

  const isXmlFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.includes('xml') || (XML_EXTENSIONS as readonly string[]).includes(extension)
    );
  };

  const isTextFile = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.startsWith('text/') ||
      (TEXT_EXTENSIONS as readonly string[]).includes(extension) ||
      isXmlFile(file)
    );
  };

  const getFileIcon = (file: ShareFile | null): React.ReactElement => {
    if (!file) return <File className="h-6 w-6 text-fg-subtle" />;
    if (isImageFile(file)) return <ImageIcon className="h-6 w-6 text-accent" />;
    if (isVideoFile(file)) return <Video className="h-6 w-6 text-danger" />;
    if (isAudioFile(file)) return <Music className="h-6 w-6 text-accent" />;
    if (isPdfFile(file)) return <FileText className="h-6 w-6 text-danger" />;
    if (isExcelFile(file)) return <TableIcon className="h-6 w-6 text-success" />;
    if (isXmlFile(file)) return <FileCode className="h-6 w-6 text-warning" />;
    const ext = getFileExtension(file.name);
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext))
      return <Archive className="h-6 w-6 text-warning" />;
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'go', 'rs'].includes(ext))
      return <Code className="h-6 w-6 text-success" />;
    if ((TEXT_EXTENSIONS as readonly string[]).includes(ext))
      return <FileText className="h-6 w-6 text-primary" />;
    return <File className="h-6 w-6 text-fg-subtle" />;
  };

  // Build streaming URL for a file in the bundle
  // Password in URL required for direct media src (headers not supported)
  const getStreamUrl = (fileId: string): string => {
    let url = `${API_URL}/api/v1/share/bundle/${token}/file/${fileId}/stream`;
    if (password) url += `?password=${encodeURIComponent(password)}`;
    return url;
  };

  // Build thumbnail URL for a file in the bundle
  const getThumbnailUrl = (fileId: string, size: string = 'medium'): string => {
    let url = `${API_URL}/api/v1/share/bundle/${token}/file/${fileId}/thumbnail?size=${size}`;
    if (password) url += `&password=${encodeURIComponent(password)}`;
    return url;
  };

  const canHaveThumbnail = (file: ShareFile | null): boolean => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return (
      mimeType.startsWith('image/') ||
      mimeType.startsWith('video/') ||
      mimeType === 'application/pdf' ||
      [
        'jpg',
        'jpeg',
        'png',
        'gif',
        'webp',
        'bmp',
        'pdf',
        'mp4',
        'mov',
        'avi',
        'mkv',
        'webm',
      ].includes(extension)
    );
  };

  useEffect(() => {
    void loadBundleInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadBundleInfo = async (pwd: string | null = null): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      const url = new URL(`${API_URL}/api/v1/share/bundle/${token}/info`, window.location.origin);
      const headers: Record<string, string> = {};
      if (pwd || password) {
        headers['X-Share-Password'] = pwd || password;
      }

      const response = await fetch(url.toString(), {
        credentials: 'include',
        headers,
      });

      if (response.status === 401) {
        setRequiresPassword(true);
        setLoading(false);
        if (pwd) setError('Invalid password');
        return;
      } else if (response.status === 404) {
        setError('Share bundle not found');
        setLoading(false);
        return;
      } else if (response.status === 410) {
        setError('This share link has expired');
        setLoading(false);
        return;
      } else if (!response.ok) {
        const errData: unknown = await response.json().catch(() => ({}));
        const errorMessage =
          typeof errData === 'object' &&
          errData !== null &&
          'detail' in errData &&
          typeof (errData as { detail: unknown }).detail === 'string'
            ? (errData as { detail: string }).detail
            : 'Failed to load shared content';
        setError(errorMessage);
        setLoading(false);
        return;
      }

      const data: unknown = await response.json();

      // Password required sentinel (200 with no files)
      if (
        typeof data === 'object' &&
        data !== null &&
        'requires_password' in data &&
        (data as { requires_password: unknown }).requires_password === true &&
        (!('files' in data) ||
          !Array.isArray((data as { files: unknown }).files) ||
          ((data as { files: unknown[] }).files.length === 0))
      ) {
        setRequiresPassword(true);
        if (isBundleInfo(data)) {
          setBundleInfo(data);
        }
        setLoading(false);
        return;
      }

      if (isBundleInfo(data)) {
        setBundleInfo(data);
        setRequiresPassword(false);
      } else {
        setError('Invalid bundle data received');
      }

      setLoading(false);
    } catch (err: unknown) {
      console.error('Failed to load bundle info:', getErrorMessage(err));
      setError('Failed to connect to server');
      setLoading(false);
    }
  };

  const handlePasswordSubmit = (): void => {
    void loadBundleInfo(password);
  };

  const handleDownloadFile = async (file: ShareFile): Promise<void> => {
    setDownloadError('');
    try {
      const url = new URL(
        `${API_URL}/api/v1/share/bundle/${token}/file/${file.id}/download`
      );
      const dlHeaders: Record<string, string> = {};
      if (password) {
        dlHeaders['X-Share-Password'] = password;
      }

      const response = await fetch(url.toString(), {
        credentials: 'include',
        headers: dlHeaders,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.detail || 'Download failed');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err: unknown) {
      console.error('Download failed:', getErrorMessage(err));
      setDownloadError(getErrorMessage(err) || 'Download failed');
    }
  };

  const handleDownloadAll = async (): Promise<void> => {
    if (!bundleInfo?.allow_zip_download) return;
    setDownloading(true);
    setDownloadError('');

    try {
      const url = new URL(`${API_URL}/api/v1/share/bundle/${token}/download`, window.location.origin);
      const zipHeaders: Record<string, string> = {};
      if (password) {
        zipHeaders['X-Share-Password'] = password;
      }

      const response = await fetch(url.toString(), {
        credentials: 'include',
        headers: zipHeaders,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.detail || 'Download failed');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${bundleInfo.name || 'bundle'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err: unknown) {
      console.error('Download all failed:', getErrorMessage(err));
      setDownloadError(getErrorMessage(err) || 'Failed to download bundle');
    } finally {
      setDownloading(false);
    }
  };

  const canDownload = bundleInfo?.share_type === 'download';

  // ---------- Loading ----------
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <Spinner size="lg" className="mx-auto mb-3" />
          <p className="text-body-sm text-fg-muted">Loading shared bundle…</p>
        </div>
      </div>
    );
  }

  // ---------- Error ----------
  if (error && !requiresPassword) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
        <Card variant="elevated" className="max-w-md w-full">
          <CardContent className="p-8 text-center">
            <div
              aria-hidden
              className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-danger/10 text-danger"
            >
              <AlertCircle className="h-8 w-8" />
            </div>
            <h2 className="text-h3 font-semibold text-fg mb-2">Unable to access</h2>
            <p className="text-body text-fg-muted mb-6">{error}</p>
            <Button variant="primary" onClick={() => navigate('/auth')}>
              Go to login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------- Password gate ----------
  if (requiresPassword) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
        <Card variant="elevated" className="max-w-md w-full">
          <CardContent className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <div
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent text-white shadow-sm"
              >
                <Lock className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-h3 font-semibold text-fg">Password required</h1>
                <p className="text-body-sm text-fg-muted">This bundle is protected</p>
              </div>
            </div>

            {bundleInfo && (
              <div className="mb-6 p-4 rounded-xl bg-primary/5 border border-primary/20">
                <h2 className="font-semibold text-fg mb-1">{bundleInfo.name}</h2>
                <p className="text-body-sm text-fg-muted">
                  {bundleInfo.file_count} files
                  {bundleInfo.show_file_sizes !== false &&
                    ` · ${formatBytes(bundleInfo.total_size || 0)}`}
                </p>
                {bundleInfo.owner_name && (
                  <p className="text-caption text-fg-subtle mt-1">
                    Shared by {bundleInfo.owner_name}
                  </p>
                )}
              </div>
            )}

            {error && (
              <Banner variant="danger" className="mb-4">
                {error}
              </Banner>
            )}

            <div className="space-y-4">
              <FormField label="Enter password">
                <Input
                  type="password"
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setPassword(e.target.value)
                  }
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter' && password) {
                      handlePasswordSubmit();
                    }
                  }}
                  placeholder="Password"
                  autoFocus
                />
              </FormField>

              <Button
                variant="primary"
                fullWidth
                disabled={!password}
                leftIcon={<Lock className="h-4 w-4" />}
                onClick={handlePasswordSubmit}
              >
                Unlock bundle
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------- Preview modal ----------
  const renderPreviewModal = (): React.ReactElement | null => {
    if (!previewFile) return null;

    const streamUrl = getStreamUrl(previewFile.id);
    const closePreview = (): void => setPreviewFile(null);

    return (
      <Modal open={true} onClose={closePreview} hideCloseButton className="!max-w-5xl">
        <ModalHeader>
          <div className="flex items-center justify-between gap-4 w-full">
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0">{getFileIcon(previewFile)}</span>
              <div className="min-w-0">
                <h3 className="font-semibold text-fg truncate">{previewFile.name}</h3>
                {bundleInfo?.show_file_sizes !== false && (
                  <p className="text-body-sm text-fg-muted">
                    {formatBytes(previewFile.size)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {canDownload && (
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Download className="h-4 w-4" />}
                  onClick={() => void handleDownloadFile(previewFile)}
                >
                  Download
                </Button>
              )}
              <IconButton
                variant="ghost"
                size="sm"
                aria-label="Close preview"
                onClick={closePreview}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </IconButton>
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="relative">
          {bundleInfo?.watermark_text && (
            <div
              className="absolute inset-0 z-10 pointer-events-none overflow-hidden select-none"
              aria-hidden="true"
            >
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `repeating-linear-gradient(
                    -45deg,
                    transparent,
                    transparent 80px,
                    rgba(0,0,0,0.03) 80px,
                    rgba(0,0,0,0.03) 81px
                  )`,
                }}
              />
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className="absolute whitespace-nowrap text-fg-subtle/20 font-bold text-2xl"
                  style={{
                    top: `${(i % 4) * 30 + 5}%`,
                    left: `${Math.floor(i / 4) * 35 - 10}%`,
                    transform: 'rotate(-35deg)',
                  }}
                >
                  {bundleInfo.watermark_text}
                </div>
              ))}
            </div>
          )}

          {isVideoFile(previewFile) ? (
            <video
              ref={videoRef}
              controls
              className="w-full max-h-[70vh] rounded-lg bg-black"
              src={streamUrl}
              preload="metadata"
            >
              Your browser does not support video playback.
            </video>
          ) : isAudioFile(previewFile) ? (
            <div className="flex flex-col items-center py-12">
              <Music className="text-accent mb-6 h-20 w-20" />
              <audio
                controls
                className="w-full max-w-md"
                src={streamUrl}
                preload="metadata"
              >
                Your browser does not support audio playback.
              </audio>
            </div>
          ) : isPdfFile(previewFile) ? (
            <iframe
              src={streamUrl}
              className="w-full rounded-lg border-0"
              style={{ minHeight: '70vh' }}
              title={previewFile.name}
            />
          ) : isImageFile(previewFile) ? (
            <img
              src={streamUrl}
              alt={previewFile.name}
              className="max-w-full max-h-[70vh] mx-auto rounded object-contain"
            />
          ) : isExcelFile(previewFile) ? (
            <div className="text-center py-12">
              <TableIcon className="mx-auto mb-4 h-16 w-16 text-success" />
              <h4 className="text-body font-semibold text-fg mb-2">{previewFile.name}</h4>
              <p className="text-body-sm text-fg-muted mb-6">
                Excel files can be viewed after downloading
              </p>
              {canDownload && (
                <Button
                  variant="primary"
                  leftIcon={<Download className="h-4 w-4" />}
                  onClick={() => void handleDownloadFile(previewFile)}
                >
                  Download Excel file
                </Button>
              )}
            </div>
          ) : isTextFile(previewFile) ? (
            <div
              className="bg-[#0b1120] rounded-lg p-4 overflow-auto"
              style={{ minHeight: '50vh' }}
            >
              <iframe
                src={streamUrl}
                className="w-full bg-transparent text-gray-100 font-mono text-sm"
                style={{ minHeight: '50vh', border: 'none' }}
                title={previewFile.name}
              />
            </div>
          ) : (
            <div className="text-center py-16">
              <File className="mx-auto mb-4 h-16 w-16 text-fg-subtle" />
              <p className="text-body-sm text-fg-muted mb-4">
                Preview not available for this file type
              </p>
              {canDownload && (
                <Button
                  variant="primary"
                  leftIcon={<Download className="h-4 w-4" />}
                  onClick={() => void handleDownloadFile(previewFile)}
                >
                  Download to view
                </Button>
              )}
            </div>
          )}
        </ModalBody>
      </Modal>
    );
  };

  // ---------- Share-type badge ----------
  const shareTypeBadge =
    bundleInfo?.share_type === 'view' ? (
      <Badge variant="info" size="md">
        <Eye className="h-3 w-3" /> View only
      </Badge>
    ) : (
      <Badge variant="success" size="md">
        <Download className="h-3 w-3" /> Can download
      </Badge>
    );

  // ---------- File card helpers (grid view) ----------
  const renderGridFile = (file: ShareFile): React.ReactElement => (
    <div
      key={file.id}
      className="group rounded-xl border border-border bg-surface p-4 transition-all hover:border-primary/40 hover:shadow-md cursor-pointer"
      onClick={() => bundleInfo?.allow_preview && setPreviewFile(file)}
    >
      <div className="flex flex-col items-center text-center">
        {/* Thumbnail or icon */}
        <div className="w-full aspect-square flex items-center justify-center mb-3 rounded-lg bg-surface-muted overflow-hidden relative">
          {canHaveThumbnail(file) && (
            <img
              src={getThumbnailUrl(file.id, 'medium')}
              alt={file.name}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                const target = e.currentTarget;
                target.style.display = 'none';
                const fallback = target.parentElement?.querySelector(
                  '.fallback-icon'
                ) as HTMLElement | null;
                if (fallback) fallback.style.display = 'flex';
              }}
            />
          )}
          <div
            className={cn(
              'fallback-icon items-center justify-center w-full h-full absolute inset-0',
              canHaveThumbnail(file) ? 'hidden' : 'flex'
            )}
          >
            {getFileIcon(file)}
          </div>
          {isVideoFile(file) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
              <Play className="h-8 w-8 text-white" fill="white" />
            </div>
          )}
        </div>
        <p
          className="font-medium text-fg truncate w-full text-body-sm"
          title={file.name}
        >
          {file.name}
        </p>
        {bundleInfo?.show_file_sizes !== false && (
          <p className="text-caption text-fg-muted mt-1">{formatBytes(file.size)}</p>
        )}
        <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {bundleInfo?.allow_preview && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Preview ${file.name}`}
              title="Preview"
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                setPreviewFile(file);
              }}
            >
              <Eye className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {canDownload && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Download ${file.name}`}
              title="Download"
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                void handleDownloadFile(file);
              }}
            >
              <Download className="h-3.5 w-3.5 text-primary" />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );

  // ---------- Main bundle viewer ----------
  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Branded header */}
      <header className="bg-surface shadow-sm border-b border-border sticky top-0 z-10 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <div
                aria-hidden
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent text-white shadow-sm"
              >
                <Package className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h1 className="text-h3 font-semibold text-fg truncate">
                  {bundleInfo?.name || 'Shared bundle'}
                </h1>
                <p className="text-body-sm text-fg-muted">
                  {bundleInfo?.file_count} files
                  {bundleInfo?.show_file_sizes !== false &&
                    ` · ${formatBytes(bundleInfo?.total_size || 0)}`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {/* View-mode toggle */}
              <div
                role="group"
                aria-label="View mode"
                className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-muted p-0.5"
              >
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  title="Grid view"
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                    viewMode === 'grid'
                      ? 'bg-surface text-primary shadow-sm'
                      : 'text-fg-muted hover:text-fg'
                  )}
                >
                  <Grid className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  aria-pressed={viewMode === 'list'}
                  title="List view"
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                    viewMode === 'list'
                      ? 'bg-surface text-primary shadow-sm'
                      : 'text-fg-muted hover:text-fg'
                  )}
                >
                  <List className="h-4 w-4" />
                </button>
              </div>

              {shareTypeBadge}

              {canDownload && bundleInfo?.allow_zip_download && (
                <Button
                  variant="primary"
                  size="sm"
                  loading={downloading}
                  leftIcon={!downloading ? <Download className="h-4 w-4" /> : undefined}
                  onClick={() => void handleDownloadAll()}
                >
                  {downloading ? 'Downloading…' : 'Download all (ZIP)'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Download error banner */}
        {downloadError && (
          <Banner
            variant="danger"
            className="mb-4"
            onDismiss={() => setDownloadError('')}
          >
            {downloadError}
          </Banner>
        )}

        {/* Bundle info card — signature gradient */}
        <div className="bg-gradient-to-r from-primary to-accent rounded-2xl p-6 mb-8 text-white shadow-lg">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-h2 font-semibold mb-1">{bundleInfo?.name}</h2>
              <p className="text-white/80 text-body">
                {bundleInfo?.file_count} files ready to{' '}
                {bundleInfo?.share_type === 'download' ? 'download' : 'view'}
              </p>
            </div>
            {bundleInfo?.show_file_sizes !== false && (
              <div className="text-right shrink-0">
                <p className="text-h1 font-bold">
                  {formatBytes(bundleInfo?.total_size || 0)}
                </p>
                <p className="text-white/80 text-body-sm">Total size</p>
              </div>
            )}
          </div>
        </div>

        {/* Files section */}
        <Card variant="elevated" className="overflow-hidden">
          <div className="px-6 py-4 border-b border-border bg-surface-muted">
            <h3 className="font-semibold text-fg">Files in this bundle</h3>
          </div>

          {viewMode === 'grid' ? (
            <div className="p-6">
              {/* Folders */}
              {Object.keys(groupedFiles.folders).length > 0 && (
                <div className="mb-6">
                  <h4 className="text-body-sm font-medium text-fg-muted mb-3">
                    Folders
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {Object.entries(groupedFiles.folders).map(([folderName, files]) => {
                      const expanded = expandedFolders.has(folderName);
                      return (
                        <div
                          key={folderName}
                          onClick={() => toggleFolder(folderName)}
                          className={cn(
                            'group p-4 rounded-xl border-2 cursor-pointer transition-all hover:shadow-md',
                            expanded
                              ? 'border-primary/40 bg-primary/5'
                              : 'border-border bg-surface hover:border-primary/30'
                          )}
                        >
                          <div className="flex flex-col items-center text-center">
                            <div
                              className={cn(
                                'p-3 rounded-xl mb-3 transition-colors',
                                expanded
                                  ? 'bg-primary/10 text-primary'
                                  : 'bg-surface-muted text-primary group-hover:bg-primary/10'
                              )}
                            >
                              <Folder className="h-8 w-8" />
                            </div>
                            <p className="font-medium text-fg truncate w-full text-body-sm">
                              {folderName}
                            </p>
                            <p className="text-caption text-fg-muted mt-1">
                              {files.length} files
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Expanded folder contents */}
              {Object.entries(groupedFiles.folders).map(
                ([folderName, files]) =>
                  expandedFolders.has(folderName) && (
                    <div key={`expanded-${folderName}`} className="mb-6">
                      <div className="flex items-center gap-2 mb-3">
                        <Folder className="h-4 w-4 text-primary" />
                        <h4 className="text-body-sm font-medium text-fg">{folderName}</h4>
                        <span className="text-caption text-fg-subtle">
                          ({files.length} files)
                        </span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {files.map(renderGridFile)}
                      </div>
                    </div>
                  )
              )}

              {/* Root files */}
              {groupedFiles.rootFiles.length > 0 && (
                <div>
                  {Object.keys(groupedFiles.folders).length > 0 && (
                    <h4 className="text-body-sm font-medium text-fg-muted mb-3">
                      Files
                    </h4>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {groupedFiles.rootFiles.map(renderGridFile)}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* List view */
            <div className="divide-y divide-border">
              {Object.entries(groupedFiles.folders).map(([folderName, files]) => (
                <div key={folderName}>
                  <div
                    onClick={() => toggleFolder(folderName)}
                    className="px-6 py-3 flex items-center gap-3 bg-surface-muted hover:bg-surface-muted/80 cursor-pointer transition-colors"
                  >
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 text-fg-subtle transition-transform',
                        expandedFolders.has(folderName) && 'rotate-90'
                      )}
                    />
                    <Folder className="h-5 w-5 text-primary" />
                    <span className="font-medium text-fg">{folderName}</span>
                    <span className="text-body-sm text-fg-muted">
                      ({files.length} files)
                    </span>
                  </div>

                  {expandedFolders.has(folderName) && (
                    <div className="bg-surface-muted/30">
                      {files.map((file) => (
                        <div
                          key={file.id}
                          className="px-6 pl-14 py-3 flex items-center gap-4 hover:bg-surface-muted transition-colors border-t border-border"
                        >
                          <div className="shrink-0">{getFileIcon(file)}</div>

                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-fg truncate">{file.name}</p>
                            {(file.relativePath ||
                              bundleInfo?.show_file_sizes !== false) && (
                              <p className="text-body-sm text-fg-muted">
                                {file.relativePath && (
                                  <span className="text-fg-subtle">
                                    {file.relativePath}/
                                  </span>
                                )}
                                {bundleInfo?.show_file_sizes !== false &&
                                  formatBytes(file.size)}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {bundleInfo?.allow_preview && (
                              <Button
                                variant="secondary"
                                size="sm"
                                leftIcon={<Eye className="h-4 w-4" />}
                                onClick={() => setPreviewFile(file)}
                              >
                                Preview
                              </Button>
                            )}
                            {canDownload && (
                              <Button
                                variant="primary"
                                size="sm"
                                leftIcon={<Download className="h-4 w-4" />}
                                onClick={() => void handleDownloadFile(file)}
                              >
                                Download
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {groupedFiles.rootFiles.map((file) => (
                <div
                  key={file.id}
                  className="px-6 py-4 flex items-center gap-4 hover:bg-surface-muted transition-colors"
                >
                  <div className="shrink-0">{getFileIcon(file)}</div>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-fg truncate">{file.name}</p>
                    {bundleInfo?.show_file_sizes !== false && (
                      <p className="text-body-sm text-fg-muted">
                        {formatBytes(file.size)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {bundleInfo?.allow_preview && (
                      <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Eye className="h-4 w-4" />}
                        onClick={() => setPreviewFile(file)}
                      >
                        Preview
                      </Button>
                    )}
                    {canDownload && (
                      <Button
                        variant="primary"
                        size="sm"
                        leftIcon={<Download className="h-4 w-4" />}
                        onClick={() => void handleDownloadFile(file)}
                      >
                        Download
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(!bundleInfo?.files || bundleInfo.files.length === 0) && (
            <div className="px-6 py-12 text-center text-fg-muted">
              <Package className="mx-auto mb-3 h-12 w-12 opacity-50" />
              <p className="text-body-sm">This bundle is empty</p>
            </div>
          )}
        </Card>
      </main>

      {/* Footer */}
      <footer className="bg-surface border-t border-border mt-12 py-6">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <p className="text-body-sm text-fg-muted mb-2">
            Powered by{' '}
            <span className="font-semibold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Edge Cloud Storage
            </span>
          </p>
          <button
            type="button"
            onClick={() => navigate('/auth')}
            className="text-body-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Create your own share bundles →
          </button>
        </div>
      </footer>

      {/* Preview modal */}
      {renderPreviewModal()}
    </div>
  );
};

export default ShareBundleViewer;
