import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download, Lock, AlertCircle, Cloud, FileText, Loader, Eye, Package,
  Image as ImageIcon, Video, Music, File, Archive, Code, X, Play,
  ChevronLeft, ExternalLink, Clock, Shield, Folder, ChevronRight,
  Grid, List, Table, FileCode
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes, VIDEO_EXTENSIONS } from '../../utils/helpers';

// Image extensions for fallback detection
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const EXCEL_EXTENSIONS = ['xlsx', 'xls', 'csv'];
const XML_EXTENSIONS = ['xml', 'xsl', 'xslt'];
const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'yaml', 'yml', 'ini', 'conf', 'log'];

export default function ShareBundleViewer() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [bundleInfo, setBundleInfo] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'list'
  const videoRef = useRef(null);

  // Group files by folder path
  const groupedFiles = useMemo(() => {
    if (!bundleInfo?.files) return { rootFiles: [], folders: {} };

    const rootFiles = [];
    const folders = {};

    bundleInfo.files.forEach(file => {
      if (!file.folder_path) {
        rootFiles.push(file);
      } else {
        // Get the top-level folder name
        const pathParts = file.folder_path.split('/').filter(Boolean);
        const topFolder = pathParts[0];

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

  const toggleFolder = (folderName) => {
    setExpandedFolders(prev => {
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
      const folderNames = new Set();
      bundleInfo.files.forEach(file => {
        if (file.folder_path) {
          const topFolder = file.folder_path.split('/').filter(Boolean)[0];
          folderNames.add(topFolder);
        }
      });
      setExpandedFolders(folderNames);
    }
  }, [bundleInfo?.files]);

  // Helper functions for media detection
  const getFileExtension = (filename) => {
    return filename?.split('.').pop()?.toLowerCase() || '';
  };

  const isVideoFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType.startsWith('video/') || VIDEO_EXTENSIONS.includes(extension);
  };

  const isAudioFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(extension);
  };

  const isImageFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType.startsWith('image/') || IMAGE_EXTENSIONS.includes(extension);
  };

  const isPdfFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType === 'application/pdf' || extension === 'pdf';
  };

  const isExcelFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType.includes('spreadsheet') || mimeType.includes('excel') || EXCEL_EXTENSIONS.includes(extension);
  };

  const isXmlFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType.includes('xml') || XML_EXTENSIONS.includes(extension);
  };

  const isTextFile = (file) => {
    if (!file) return false;
    const mimeType = (file.mime_type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return mimeType.startsWith('text/') || TEXT_EXTENSIONS.includes(extension) || isXmlFile(file);
  };

  const getFileIcon = (file) => {
    if (isImageFile(file)) return <ImageIcon size={24} className="text-purple-500" />;
    if (isVideoFile(file)) return <Video size={24} className="text-red-500" />;
    if (isAudioFile(file)) return <Music size={24} className="text-pink-500" />;
    if (isPdfFile(file)) return <FileText size={24} className="text-red-600" />;
    if (isExcelFile(file)) return <Table size={24} className="text-green-600" />;
    if (isXmlFile(file)) return <FileCode size={24} className="text-orange-500" />;
    const ext = getFileExtension(file?.name);
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <Archive size={24} className="text-yellow-600" />;
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'go', 'rs'].includes(ext)) return <Code size={24} className="text-green-500" />;
    if (TEXT_EXTENSIONS.includes(ext)) return <FileText size={24} className="text-blue-500" />;
    return <File size={24} className="text-gray-500" />;
  };

  // Build streaming URL for a file in the bundle
  const getStreamUrl = (fileId) => {
    let url = `${API_URL}/share/bundle/${token}/file/${fileId}/stream`;
    if (password) url += `?password=${encodeURIComponent(password)}`;
    return url;
  };

  useEffect(() => {
    loadBundleInfo();
  }, [token]);

  const loadBundleInfo = async (pwd = null) => {
    setLoading(true);
    setError('');

    try {
      const url = new URL(`${API_URL}/share/bundle/${token}/info`);
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
        setError('Share bundle not found');
        setLoading(false);
        return;
      } else if (response.status === 410) {
        setError('This share link has expired');
        setLoading(false);
        return;
      } else if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        setError(errData.detail || 'Failed to load shared content');
        setLoading(false);
        return;
      }

      const data = await response.json();
      setBundleInfo(data);
      setLoading(false);
    } catch (err) {
      console.error('Failed to load bundle info:', err);
      setError('Failed to connect to server');
      setLoading(false);
    }
  };

  const handlePasswordSubmit = () => {
    loadBundleInfo(password);
  };

  const handleDownloadFile = async (file) => {
    try {
      const url = new URL(`${API_URL}/share/bundle/${token}/file/${file.id}/stream`);
      if (password) url.searchParams.append('password', password);

      const response = await fetch(url.toString());
      if (!response.ok) throw new Error('Download failed');

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error('Download failed:', err);
      setError('Download failed');
    }
  };

  const handleDownloadAll = async () => {
    if (!bundleInfo?.allow_zip_download) return;
    setDownloading(true);

    try {
      const url = new URL(`${API_URL}/share/bundle/${token}/download`);
      if (password) url.searchParams.append('password', password);

      const response = await fetch(url.toString());
      if (!response.ok) throw new Error('Download failed');

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${bundleInfo.name || 'bundle'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error('Download all failed:', err);
      setError('Failed to download bundle');
    } finally {
      setDownloading(false);
    }
  };

  const canDownload = bundleInfo?.share_type === 'download';

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 flex items-center justify-center">
        <div className="text-center">
          <Loader className="animate-spin text-purple-500 mx-auto mb-3" size={48} />
          <p className="text-gray-600">Loading shared bundle...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !requiresPassword) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center">
          <AlertCircle className="text-red-500 mx-auto mb-4" size={64} />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Unable to Access</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => navigate('/auth')}
            className="px-6 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  // Password required state
  if (requiresPassword && !bundleInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600">
              <Lock className="text-white" size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Password Required</h1>
              <p className="text-sm text-gray-500">This bundle is protected</p>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-100 text-red-700 text-sm flex items-center gap-2">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Enter Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && password && handlePasswordSubmit()}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="Password"
                autoFocus
              />
            </div>

            <button
              onClick={handlePasswordSubmit}
              disabled={!password}
              className={`w-full py-3 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg font-medium ${
                !password
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white'
              }`}
            >
              <Lock size={20} />
              Unlock Bundle
            </button>
          </div>
        </div>
      </div>
    );
  }

  // File preview modal
  const renderPreviewModal = () => {
    if (!previewFile) return null;

    const streamUrl = getStreamUrl(previewFile.id);

    return (
      <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
        <div className="relative w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl overflow-hidden">
          {/* Modal Header */}
          <div className="flex items-center justify-between p-4 border-b">
            <div className="flex items-center gap-3">
              {getFileIcon(previewFile)}
              <div>
                <h3 className="font-semibold text-gray-900">{previewFile.name}</h3>
                <p className="text-sm text-gray-500">{formatBytes(previewFile.size)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canDownload && (
                <button
                  onClick={() => handleDownloadFile(previewFile)}
                  className="px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600 flex items-center gap-2"
                >
                  <Download size={16} />
                  Download
                </button>
              )}
              <button
                onClick={() => setPreviewFile(null)}
                className="p-2 rounded-lg hover:bg-gray-100"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Modal Content */}
          <div className="p-4 overflow-auto max-h-[calc(90vh-80px)]">
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
                <Music className="text-purple-500 mb-6" size={80} />
                <audio controls className="w-full max-w-md" src={streamUrl} preload="metadata">
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
                <Table className="mx-auto mb-4 text-green-600" size={64} />
                <h4 className="text-lg font-semibold text-gray-900 mb-2">{previewFile.name}</h4>
                <p className="text-gray-500 mb-6">Excel files can be viewed after downloading</p>
                {canDownload && (
                  <button
                    onClick={() => handleDownloadFile(previewFile)}
                    className="px-6 py-3 bg-green-500 text-white rounded-xl hover:bg-green-600 flex items-center gap-2 mx-auto"
                  >
                    <Download size={18} />
                    Download Excel File
                  </button>
                )}
              </div>
            ) : isTextFile(previewFile) ? (
              <div className="bg-gray-900 rounded-lg p-4 overflow-auto" style={{ minHeight: '50vh' }}>
                <iframe
                  src={streamUrl}
                  className="w-full bg-transparent text-gray-100 font-mono text-sm"
                  style={{ minHeight: '50vh', border: 'none' }}
                  title={previewFile.name}
                />
              </div>
            ) : (
              <div className="text-center py-16">
                <File className="mx-auto mb-4 text-gray-400" size={64} />
                <p className="text-gray-500 mb-4">Preview not available for this file type</p>
                {canDownload && (
                  <button
                    onClick={() => handleDownloadFile(previewFile)}
                    className="px-6 py-3 bg-purple-500 text-white rounded-xl hover:bg-purple-600 flex items-center gap-2 mx-auto"
                  >
                    <Download size={18} />
                    Download to View
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Main bundle viewer
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600">
                <Package className="text-white" size={28} />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">
                  {bundleInfo?.name || 'Shared Bundle'}
                </h1>
                <p className="text-sm text-gray-500">
                  {bundleInfo?.file_count} files • {formatBytes(bundleInfo?.total_size || 0)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* View Toggle */}
              <div className="flex items-center bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 rounded-md transition-all ${
                    viewMode === 'grid'
                      ? 'bg-white shadow text-purple-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                  title="Grid view"
                >
                  <Grid size={18} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 rounded-md transition-all ${
                    viewMode === 'list'
                      ? 'bg-white shadow text-purple-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                  title="List view"
                >
                  <List size={18} />
                </button>
              </div>

              <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                bundleInfo?.share_type === 'view'
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-green-100 text-green-700'
              }`}>
                {bundleInfo?.share_type === 'view' ? '👁️ View Only' : '⬇️ Can Download'}
              </span>

              {canDownload && bundleInfo?.allow_zip_download && (
                <button
                  onClick={handleDownloadAll}
                  disabled={downloading}
                  className="px-4 py-2 rounded-xl bg-purple-500 text-white hover:bg-purple-600 flex items-center gap-2 font-medium disabled:opacity-50"
                >
                  {downloading ? (
                    <>
                      <Loader size={18} className="animate-spin" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Download size={18} />
                      Download All (ZIP)
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Bundle Info Card */}
        <div className="bg-gradient-to-r from-purple-500 to-pink-600 rounded-2xl p-6 mb-8 text-white">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold mb-1">{bundleInfo?.name}</h2>
              <p className="text-white/80">
                {bundleInfo?.file_count} files ready to {bundleInfo?.share_type === 'download' ? 'download' : 'view'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-3xl font-bold">{formatBytes(bundleInfo?.total_size || 0)}</p>
              <p className="text-white/80 text-sm">Total size</p>
            </div>
          </div>
        </div>

        {/* Files Section */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50">
            <h3 className="font-semibold text-gray-900">Files in this Bundle</h3>
          </div>

          {viewMode === 'grid' ? (
            /* Grid View */
            <div className="p-6">
              {/* Folders in Grid */}
              {Object.keys(groupedFiles.folders).length > 0 && (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-gray-500 mb-3">Folders</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {Object.entries(groupedFiles.folders).map(([folderName, files]) => (
                      <div
                        key={folderName}
                        onClick={() => toggleFolder(folderName)}
                        className={`group p-4 rounded-xl border-2 cursor-pointer transition-all hover:shadow-lg ${
                          expandedFolders.has(folderName)
                            ? 'border-purple-300 bg-purple-50'
                            : 'border-gray-200 hover:border-purple-200 bg-white'
                        }`}
                      >
                        <div className="flex flex-col items-center text-center">
                          <div className={`p-3 rounded-xl mb-3 transition-colors ${
                            expandedFolders.has(folderName)
                              ? 'bg-purple-100'
                              : 'bg-blue-50 group-hover:bg-blue-100'
                          }`}>
                            <Folder size={32} className="text-blue-500" />
                          </div>
                          <p className="font-medium text-gray-900 truncate w-full text-sm">{folderName}</p>
                          <p className="text-xs text-gray-500 mt-1">{files.length} files</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Expanded folder contents in grid */}
              {Object.entries(groupedFiles.folders).map(([folderName, files]) => (
                expandedFolders.has(folderName) && (
                  <div key={`expanded-${folderName}`} className="mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Folder size={16} className="text-blue-500" />
                      <h4 className="text-sm font-medium text-gray-700">{folderName}</h4>
                      <span className="text-xs text-gray-400">({files.length} files)</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {files.map((file) => (
                        <div
                          key={file.id}
                          className="group p-4 rounded-xl border border-gray-200 hover:border-purple-300 hover:shadow-lg transition-all bg-white cursor-pointer"
                          onClick={() => bundleInfo?.allow_preview && setPreviewFile(file)}
                        >
                          <div className="flex flex-col items-center text-center">
                            {/* Thumbnail or Icon */}
                            <div className="w-full aspect-square flex items-center justify-center mb-3 rounded-lg bg-gray-50 overflow-hidden relative">
                              {isImageFile(file) && (
                                <img
                                  src={getStreamUrl(file.id)}
                                  alt={file.name}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                  onError={(e) => {
                                    e.target.style.display = 'none';
                                    const fallback = e.target.parentElement.querySelector('.fallback-icon');
                                    if (fallback) fallback.style.display = 'flex';
                                  }}
                                />
                              )}
                              <div className={`fallback-icon ${isImageFile(file) ? 'hidden' : 'flex'} items-center justify-center w-full h-full absolute inset-0`}>
                                {getFileIcon(file)}
                              </div>
                            </div>
                            <p className="font-medium text-gray-900 truncate w-full text-sm" title={file.name}>
                              {file.name}
                            </p>
                            <p className="text-xs text-gray-500 mt-1">{formatBytes(file.size)}</p>
                            {/* Action buttons on hover */}
                            <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              {bundleInfo?.allow_preview && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }}
                                  className="p-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600"
                                  title="Preview"
                                >
                                  <Eye size={14} />
                                </button>
                              )}
                              {canDownload && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDownloadFile(file); }}
                                  className="p-1.5 rounded-lg bg-purple-100 hover:bg-purple-200 text-purple-600"
                                  title="Download"
                                >
                                  <Download size={14} />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              ))}

              {/* Root files in Grid */}
              {groupedFiles.rootFiles.length > 0 && (
                <div>
                  {Object.keys(groupedFiles.folders).length > 0 && (
                    <h4 className="text-sm font-medium text-gray-500 mb-3">Files</h4>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {groupedFiles.rootFiles.map((file) => (
                      <div
                        key={file.id}
                        className="group p-4 rounded-xl border border-gray-200 hover:border-purple-300 hover:shadow-lg transition-all bg-white cursor-pointer"
                        onClick={() => bundleInfo?.allow_preview && setPreviewFile(file)}
                      >
                        <div className="flex flex-col items-center text-center">
                          {/* Thumbnail or Icon */}
                          <div className="w-full aspect-square flex items-center justify-center mb-3 rounded-lg bg-gray-50 overflow-hidden relative">
                            {isImageFile(file) && (
                              <img
                                src={getStreamUrl(file.id)}
                                alt={file.name}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                  e.target.style.display = 'none';
                                  const fallback = e.target.parentElement.querySelector('.fallback-icon');
                                  if (fallback) fallback.style.display = 'flex';
                                }}
                              />
                            )}
                            <div className={`fallback-icon ${isImageFile(file) ? 'hidden' : 'flex'} items-center justify-center w-full h-full absolute inset-0`}>
                              {getFileIcon(file)}
                            </div>
                          </div>
                          <p className="font-medium text-gray-900 truncate w-full text-sm" title={file.name}>
                            {file.name}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">{formatBytes(file.size)}</p>
                          {/* Action buttons on hover */}
                          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            {bundleInfo?.allow_preview && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }}
                                className="p-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600"
                                title="Preview"
                              >
                                <Eye size={14} />
                              </button>
                            )}
                            {canDownload && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDownloadFile(file); }}
                                className="p-1.5 rounded-lg bg-purple-100 hover:bg-purple-200 text-purple-600"
                                title="Download"
                              >
                                <Download size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* List View */
            <div className="divide-y">
              {/* Folders first */}
              {Object.entries(groupedFiles.folders).map(([folderName, files]) => (
                <div key={folderName}>
                  {/* Folder header */}
                  <div
                    onClick={() => toggleFolder(folderName)}
                    className="px-6 py-3 flex items-center gap-3 bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors"
                  >
                    <ChevronRight
                      size={18}
                      className={`text-gray-400 transition-transform ${expandedFolders.has(folderName) ? 'rotate-90' : ''}`}
                    />
                    <Folder size={20} className="text-blue-500" />
                    <span className="font-medium text-gray-900">{folderName}</span>
                    <span className="text-sm text-gray-500">({files.length} files)</span>
                  </div>

                  {/* Folder contents */}
                  {expandedFolders.has(folderName) && (
                    <div className="bg-gray-50/50">
                      {files.map((file) => (
                        <div
                          key={file.id}
                          className="px-6 pl-14 py-3 flex items-center gap-4 hover:bg-gray-100 transition-colors border-t border-gray-100"
                        >
                          <div className="flex-shrink-0">
                            {getFileIcon(file)}
                          </div>

                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 truncate">{file.name}</p>
                            <p className="text-sm text-gray-500">
                              {file.relativePath && <span className="text-gray-400">{file.relativePath}/</span>}
                              {formatBytes(file.size)}
                            </p>
                          </div>

                          <div className="flex items-center gap-2">
                            {bundleInfo?.allow_preview && (
                              <button
                                onClick={() => setPreviewFile(file)}
                                className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 flex items-center gap-1.5 text-sm"
                              >
                                <Eye size={16} />
                                Preview
                              </button>
                            )}

                            {canDownload && (
                              <button
                                onClick={() => handleDownloadFile(file)}
                                className="px-3 py-1.5 rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200 flex items-center gap-1.5 text-sm"
                              >
                                <Download size={16} />
                                Download
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Root files (not in any folder) */}
              {groupedFiles.rootFiles.map((file) => (
                <div
                  key={file.id}
                  className="px-6 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex-shrink-0">
                    {getFileIcon(file)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{file.name}</p>
                    <p className="text-sm text-gray-500">{formatBytes(file.size)}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    {bundleInfo?.allow_preview && (
                      <button
                        onClick={() => setPreviewFile(file)}
                        className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 flex items-center gap-1.5 text-sm"
                      >
                        <Eye size={16} />
                        Preview
                      </button>
                    )}

                    {canDownload && (
                      <button
                        onClick={() => handleDownloadFile(file)}
                        className="px-3 py-1.5 rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200 flex items-center gap-1.5 text-sm"
                      >
                        <Download size={16} />
                        Download
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(!bundleInfo?.files || bundleInfo.files.length === 0) && (
            <div className="px-6 py-12 text-center text-gray-500">
              <Package size={48} className="mx-auto mb-3 opacity-50" />
              <p>This bundle is empty</p>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t mt-12 py-6">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <p className="text-gray-600 text-sm mb-2">
            Powered by <span className="font-semibold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">Edge Cloud Storage</span>
          </p>
          <button
            onClick={() => navigate('/auth')}
            className="text-purple-500 hover:text-purple-600 text-sm font-medium"
          >
            Create your own share bundles →
          </button>
        </div>
      </footer>

      {/* Preview Modal */}
      {renderPreviewModal()}
    </div>
  );
}
