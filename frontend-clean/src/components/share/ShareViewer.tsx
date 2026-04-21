import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download,
  Lock,
  AlertCircle,
  Cloud,
  Folder,
  Music,
  File,
  Eye,
  Edit3,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes, getFileIcon, VIDEO_EXTENSIONS } from '../../utils/helpers';
import type { ShareInfo, FolderContents } from './types';
import { isShareInfo, isFolderContents, getErrorMessage } from './types';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  FormField,
  IconButton,
  Input,
  Spinner,
} from '@/components/ui';

/**
 * ShareViewer — public page for single-file / single-folder shares.
 *
 * Rebuilt on Signal primitives: Card + Button + IconButton + Badge + Banner
 * + FormField / Input. Branded header lockup, token-driven surfaces for
 * clean dark-mode rendering. Business logic (fetching share info, password
 * gate, folder contents, stream-url building) is unchanged from the prior
 * implementation.
 */
const ShareViewer: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [requiresPassword, setRequiresPassword] = useState<boolean>(false);
  const [password, setPassword] = useState<string>('');
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [folderContents, setFolderContents] = useState<FolderContents | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isVideoFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    const extension = info.item_name?.split('.').pop()?.toLowerCase() || '';
    return (
      mimeType.startsWith('video/') ||
      (VIDEO_EXTENSIONS as readonly string[]).includes(extension)
    );
  };

  const isAudioFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    return mimeType.startsWith('audio/');
  };

  const isImageFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    return mimeType.startsWith('image/');
  };

  const isPdfFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    const extension = info.item_name?.split('.').pop()?.toLowerCase() || '';
    return mimeType === 'application/pdf' || extension === 'pdf';
  };

  // Password in URL required for direct media src (headers not supported)
  const getStreamUrl = (): string => {
    if (!shareInfo?.file_id) return '';
    let url = `${API_URL}/api/v1/share/${token}/stream?inline=true`;
    if (password) url += `&password=${encodeURIComponent(password)}`;
    if (isVideoFile(shareInfo)) url += '&compatible=true';
    return url;
  };

  useEffect(() => {
    void loadShareInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadShareInfo = async (pwd: string | null = null): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      const url = new URL(`${API_URL}/api/v1/share/${token}/info`, window.location.origin);
      const headers: Record<string, string> = {};
      if (pwd || password) {
        headers['X-Share-Password'] = pwd || password;
      }

      const response = await fetch(url.toString(), { headers });

      if (response.status === 401) {
        setRequiresPassword(true);
        setLoading(false);
        if (pwd) setError('Invalid password');
        return;
      } else if (response.status === 404) {
        setError('Share link not found');
        setLoading(false);
        return;
      } else if (response.status === 410) {
        setError('Share link has expired');
        setLoading(false);
        return;
      } else if (!response.ok) {
        setError('Failed to load shared content');
        setLoading(false);
        return;
      }

      const data: unknown = await response.json();

      if (isShareInfo(data)) {
        setShareInfo(data);

        if (data.item_type === 'folder') {
          await loadFolderContents(pwd || password);
        }
      } else {
        setError('Invalid share data received');
      }

      setLoading(false);
    } catch (err: unknown) {
      console.error('Failed to load share info:', getErrorMessage(err));
      setError('Failed to connect to server');
      setLoading(false);
    }
  };

  const loadFolderContents = async (pwd: string | null = null): Promise<void> => {
    try {
      const url = new URL(`${API_URL}/api/v1/share/${token}/folder/contents`, window.location.origin);
      const folderHeaders: Record<string, string> = {};
      if (pwd || password) {
        folderHeaders['X-Share-Password'] = pwd || password;
      }

      const response = await fetch(url.toString(), { headers: folderHeaders });

      if (response.ok) {
        const data: unknown = await response.json();
        if (isFolderContents(data)) {
          setFolderContents(data);
        }
      }
    } catch (err: unknown) {
      console.error('Failed to load folder contents:', getErrorMessage(err));
    }
  };

  const handlePasswordSubmit = (): void => {
    void loadShareInfo(password);
  };

  const handleDownload = async (fileId: string | null = null): Promise<void> => {
    try {
      const downloadUrl = fileId
        ? `${API_URL}/api/v1/share/${token}/file/${fileId}/download`
        : `${API_URL}/api/v1/share/${token}`;

      const url = new URL(downloadUrl, window.location.origin);
      if (password) {
        url.searchParams.set('password', password);
      }

      const a = document.createElement('a');
      a.href = url.toString();
      a.download = shareInfo?.item_name || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Download failed');
    }
  };

  const canDownload =
    shareInfo?.share_type === 'download' || shareInfo?.share_type === 'edit';

  // ---------- Loading ----------
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <Spinner size="lg" className="mx-auto mb-3" />
          <p className="text-body-sm text-fg-muted">Loading shared content…</p>
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
            <h2 className="text-h3 font-semibold text-fg mb-2">Oops!</h2>
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
  if (requiresPassword && !shareInfo) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
        <Card variant="elevated" className="max-w-md w-full">
          <CardContent className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <div
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"
              >
                <Lock className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-h3 font-semibold text-fg">Password required</h1>
                <p className="text-body-sm text-fg-muted">This content is protected</p>
              </div>
            </div>

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
                Unlock
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------- Share-type badge ----------
  const shareTypeBadge = (() => {
    const t = shareInfo?.share_type;
    if (t === 'view') {
      return (
        <Badge variant="info" size="md">
          <Eye className="h-3 w-3" /> View only
        </Badge>
      );
    }
    if (t === 'download') {
      return (
        <Badge variant="success" size="md">
          <Download className="h-3 w-3" /> Can download
        </Badge>
      );
    }
    return (
      <Badge variant="accent" size="md">
        <Edit3 className="h-3 w-3" /> Can edit
      </Badge>
    );
  })();

  // ---------- Main viewer ----------
  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Branded header */}
      <header className="bg-surface border-b border-border sticky top-0 z-10 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent text-white shadow-sm"
              >
                <Cloud className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-h3 font-semibold text-fg truncate">
                  {shareInfo?.item_name || 'Shared content'}
                </h1>
                <p className="text-body-sm text-fg-muted">
                  {shareInfo?.item_type === 'folder' ? 'Shared folder' : 'Shared file'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {shareTypeBadge}

              {canDownload && shareInfo?.item_type === 'file' && (
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Download className="h-4 w-4" />}
                  onClick={() => void handleDownload()}
                >
                  Download
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {shareInfo?.item_type === 'file' ? (
          // ---------- Single file ----------
          <Card variant="elevated">
            <CardContent className="p-8">
              <div className="flex items-center gap-4 mb-6">
                <div
                  aria-hidden
                  className="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-muted"
                >
                  {getFileIcon(shareInfo.item_name, 40)}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-h3 font-semibold text-fg mb-1 truncate">
                    {shareInfo.item_name}
                  </h2>
                  <p className="text-body-sm text-fg-muted">
                    {shareInfo.file_size ? formatBytes(shareInfo.file_size) : 'Unknown size'}
                    {' · '}
                    {shareInfo.mime_type || 'Unknown type'}
                  </p>
                </div>
              </div>

              {shareInfo.allow_preview && (
                <div className="relative rounded-lg border border-border bg-surface-muted p-4">
                  {shareInfo.watermark_text && (
                    <div
                      className="absolute inset-0 z-10 pointer-events-none overflow-hidden select-none"
                      aria-hidden="true"
                    >
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
                          {shareInfo.watermark_text}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Video */}
                  {isVideoFile(shareInfo) ? (
                    <div className="relative">
                      <video
                        ref={videoRef}
                        controls
                        className="w-full max-h-[70vh] rounded-lg bg-black"
                        src={getStreamUrl()}
                        preload="metadata"
                        onError={(e: React.SyntheticEvent<HTMLVideoElement>) => {
                          console.error('Video error:', e);
                          setVideoError(
                            'Unable to play video. The format may not be supported by your browser.'
                          );
                        }}
                        onLoadedData={() => {
                          setVideoError(null);
                        }}
                      >
                        Your browser does not support the video tag.
                      </video>
                      {videoError && (
                        <Banner
                          variant="warning"
                          className="mt-4"
                          {...(canDownload
                            ? {
                                action: (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={() => void handleDownload()}
                                  >
                                    Download to watch locally
                                  </Button>
                                ),
                              }
                            : {})}
                        >
                          {videoError}
                        </Banner>
                      )}
                    </div>
                  ) : /* Audio */
                  isAudioFile(shareInfo) ? (
                    <div className="flex flex-col items-center py-8">
                      <Music className="text-accent mb-4 h-16 w-16" />
                      <audio
                        controls
                        className="w-full max-w-md"
                        src={getStreamUrl()}
                        preload="metadata"
                      >
                        Your browser does not support the audio tag.
                      </audio>
                    </div>
                  ) : /* PDF */
                  isPdfFile(shareInfo) ? (
                    <div className="w-full h-full min-h-[70vh]">
                      <iframe
                        src={getStreamUrl()}
                        className="w-full h-full rounded-lg border-0"
                        style={{ minHeight: '70vh' }}
                        title={shareInfo.item_name}
                      />
                    </div>
                  ) : /* Image */
                  isImageFile(shareInfo) ? (
                    <img
                      src={getStreamUrl()}
                      alt={shareInfo.item_name}
                      className="max-w-full max-h-[70vh] mx-auto rounded object-contain"
                      onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                        const target = e.currentTarget;
                        target.style.display = 'none';
                      }}
                    />
                  ) : (
                    /* Unknown */
                    <div className="text-center py-12">
                      <File className="mx-auto mb-4 h-16 w-16 text-fg-subtle" />
                      <p className="text-body-sm text-fg-muted mb-3">
                        Preview not available for this file type
                      </p>
                      {canDownload && (
                        <Button
                          variant="primary"
                          size="sm"
                          leftIcon={<Download className="h-4 w-4" />}
                          onClick={() => void handleDownload()}
                        >
                          Download file
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          // ---------- Folder browser ----------
          <Card variant="elevated" className="relative">
            <CardContent className="p-6">
              {folderContents?.watermark_text && (
                <div
                  className="absolute inset-0 z-10 pointer-events-none overflow-hidden select-none rounded-xl"
                  aria-hidden="true"
                >
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
                      {folderContents.watermark_text}
                    </div>
                  ))}
                </div>
              )}

              <h2 className="text-h3 font-semibold text-fg mb-4 flex items-center gap-2">
                <Folder className="text-primary h-6 w-6" />
                {folderContents?.folder_name}
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {folderContents?.files?.map((file) => (
                  <div
                    key={file.id}
                    className="rounded-lg border border-border bg-surface p-4 transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      {getFileIcon(file.name, 32)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-fg truncate">{file.name}</p>
                        <p className="text-body-sm text-fg-muted">{formatBytes(file.size)}</p>
                      </div>
                      {canDownload && (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={`Download ${file.name}`}
                          title="Download"
                          onClick={() => void handleDownload(file.id)}
                        >
                          <Download className="h-4 w-4 text-primary" />
                        </IconButton>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {folderContents?.files?.length === 0 && (
                <div className="text-center py-12 text-fg-muted">
                  <Folder className="mx-auto mb-3 h-12 w-12 opacity-50" />
                  <p className="text-body-sm">
                    {folderContents.notice || 'This folder is empty'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-surface border-t border-border mt-12 py-6">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-body-sm text-fg-muted mb-2">
            Powered by <span className="font-semibold text-fg">Edge Cloud Storage</span>
          </p>
          <button
            type="button"
            onClick={() => navigate('/auth')}
            className="text-body-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Sign in to your account →
          </button>
        </div>
      </footer>
    </div>
  );
};

export default ShareViewer;
