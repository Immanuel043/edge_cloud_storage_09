import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download,
  Lock,
  AlertCircle,
  Cloud,
  Loader,
  Folder,
  Music,
  File,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes, getFileIcon, VIDEO_EXTENSIONS } from '../../utils/helpers';
import type { ShareInfo, FolderContents } from './types';
import { isShareInfo, isFolderContents, getErrorMessage } from './types';

/**
 * ShareViewer Component
 *
 * Displays shared files or folders with preview capabilities.
 * Supports password-protected shares and different share types (view/download/edit).
 *
 * Features:
 * - Single file preview (video, audio, PDF, images)
 * - Folder browsing
 * - Password protection
 * - Download support (if allowed)
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

  /**
   * Check if file is a video
   */
  const isVideoFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    const extension = info.item_name?.split('.').pop()?.toLowerCase() || '';
    return (
      mimeType.startsWith('video/') ||
      (VIDEO_EXTENSIONS as readonly string[]).includes(extension)
    );
  };

  /**
   * Check if file is an audio file
   */
  const isAudioFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    return mimeType.startsWith('audio/');
  };

  /**
   * Check if file is an image
   */
  const isImageFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    return mimeType.startsWith('image/');
  };

  /**
   * Check if file is a PDF
   */
  const isPdfFile = (info: ShareInfo | null): boolean => {
    if (!info) return false;
    const mimeType = (info.mime_type || '').toLowerCase();
    const extension = info.item_name?.split('.').pop()?.toLowerCase() || '';
    return mimeType === 'application/pdf' || extension === 'pdf';
  };

  /**
   * Build streaming URL for shared content
   */
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
      const url = new URL(`${API_URL}/api/v1/share/${token}/info`);
      if (pwd || password) {
        url.searchParams.append('password', pwd || password);
      }

      const response = await fetch(url.toString());

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

      // Validate and set share info
      if (isShareInfo(data)) {
        setShareInfo(data);

        // If it's a folder, load contents
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
      const url = new URL(`${API_URL}/api/v1/share/${token}/folder/contents`);
      if (pwd || password) {
        url.searchParams.append('password', pwd || password);
      }

      const response = await fetch(url.toString());

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
        ? `${API_URL}/api/v1/files/${fileId}/download`
        : `${API_URL}/api/v1/share/${token}`;

      const url = new URL(downloadUrl);
      if (password) {
        url.searchParams.append('password', password);
      }

      const response = await fetch(url.toString(), {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Download failed');
      }

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = shareInfo?.item_name || 'download';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?(.+)"?/i);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      const blob = await response.blob();
      const downloadUrl2 = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl2;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl2);
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Download failed');
    }
  };

  const canDownload =
    shareInfo?.share_type === 'download' || shareInfo?.share_type === 'edit';

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center">
        <div className="text-center">
          <Loader className="animate-spin text-blue-500 mx-auto mb-3" size={48} />
          <p className="text-gray-600">Loading shared content...</p>
        </div>
      </div>
    );
  }

  if (error && !requiresPassword) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center">
          <AlertCircle className="text-red-500 mx-auto mb-4" size={64} />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Oops!</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => navigate('/auth')}
            className="px-6 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  if (requiresPassword && !shareInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
              <Lock className="text-white" size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Password Required</h1>
              <p className="text-sm text-gray-500">This content is protected</p>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded bg-red-100 text-red-700 text-sm">{error}</div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Enter Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setPassword(e.target.value)
                }
                onKeyPress={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter' && password) {
                    handlePasswordSubmit();
                  }
                }}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Password"
                autoFocus
              />
            </div>

            <button
              onClick={handlePasswordSubmit}
              disabled={!password}
              className={`w-full py-3 rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg ${
                !password
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white'
              }`}
            >
              <Lock size={20} />
              Unlock
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main viewer for files/folders
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
                <Cloud className="text-white" size={24} />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">
                  {shareInfo?.item_name || 'Shared Content'}
                </h1>
                <p className="text-sm text-gray-500">
                  {shareInfo?.item_type === 'folder' ? 'Shared Folder' : 'Shared File'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  shareInfo?.share_type === 'view'
                    ? 'bg-blue-100 text-blue-700'
                    : shareInfo?.share_type === 'download'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-purple-100 text-purple-700'
                }`}
              >
                {shareInfo?.share_type === 'view'
                  ? '👁️ View Only'
                  : shareInfo?.share_type === 'download'
                    ? '⬇️ Can Download'
                    : '✏️ Can Edit'}
              </span>

              {canDownload && shareInfo?.item_type === 'file' && (
                <button
                  onClick={() => void handleDownload()}
                  className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 flex items-center gap-2"
                >
                  <Download size={16} />
                  Download
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {shareInfo?.item_type === 'file' ? (
          // Single file viewer
          <div className="bg-white rounded-xl shadow-lg p-8">
            <div className="flex items-center gap-4 mb-6">
              <div className="p-4 rounded-xl bg-gray-100">
                {getFileIcon(shareInfo.mime_type || shareInfo.item_name, 48)}
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-gray-900 mb-1">
                  {shareInfo.item_name}
                </h2>
                <p className="text-gray-600">
                  {shareInfo.file_size ? formatBytes(shareInfo.file_size) : 'Unknown size'} •{' '}
                  {shareInfo.mime_type || 'Unknown type'}
                </p>
              </div>
            </div>

            {shareInfo.allow_preview && (
              <div className="border rounded-lg p-4 bg-gray-50">
                {/* Video Preview */}
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
                      <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                        <p className="text-yellow-700 text-sm">{videoError}</p>
                        {canDownload && (
                          <button
                            onClick={() => void handleDownload()}
                            className="mt-2 px-4 py-2 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600"
                          >
                            Download to watch locally
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : /* Audio Preview */
                isAudioFile(shareInfo) ? (
                  <div className="flex flex-col items-center py-8">
                    <Music className="text-purple-500 mb-4" size={64} />
                    <audio
                      controls
                      className="w-full max-w-md"
                      src={getStreamUrl()}
                      preload="metadata"
                    >
                      Your browser does not support the audio tag.
                    </audio>
                  </div>
                ) : /* PDF Preview */
                isPdfFile(shareInfo) ? (
                  <div className="w-full h-full min-h-[70vh]">
                    <iframe
                      src={getStreamUrl()}
                      className="w-full h-full rounded-lg border-0"
                      style={{ minHeight: '70vh' }}
                      title={shareInfo.item_name}
                    />
                  </div>
                ) : /* Image Preview */
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
                  <div className="text-center py-12">
                    <File className="mx-auto mb-4 text-gray-400" size={64} />
                    <p className="text-gray-500 mb-2">Preview not available for this file type</p>
                    {canDownload && (
                      <button
                        onClick={() => void handleDownload()}
                        className="px-4 py-2 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600"
                      >
                        Download file
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          // Folder browser
          <div className="bg-white rounded-xl shadow-lg p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              <Folder className="text-blue-500" size={24} />
              {folderContents?.folder_name}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {folderContents?.files?.map((file) => (
                <div
                  key={file.id}
                  className="border rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    {getFileIcon(file.mime_type || file.name, 32)}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{file.name}</p>
                      <p className="text-sm text-gray-500">{formatBytes(file.size)}</p>
                    </div>
                    {canDownload && (
                      <button
                        onClick={() => void handleDownload(file.id)}
                        className="p-2 rounded hover:bg-gray-100"
                        title="Download"
                      >
                        <Download size={18} className="text-blue-500" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {folderContents?.files?.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                <Folder size={48} className="mx-auto mb-3 opacity-50" />
                <p>This folder is empty</p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t mt-12 py-6">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-gray-600 text-sm mb-2">
            Powered by <span className="font-semibold">Edge Cloud Storage</span>
          </p>
          <button
            onClick={() => navigate('/auth')}
            className="text-blue-500 hover:text-blue-600 text-sm font-medium"
          >
            Sign in to your account →
          </button>
        </div>
      </footer>
    </div>
  );
};

export default ShareViewer;
