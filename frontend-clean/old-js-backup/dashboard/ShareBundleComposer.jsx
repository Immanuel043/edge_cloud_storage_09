import React, { useState, useMemo } from 'react';
import {
  X, Share2, Link2, Copy, Check, Lock, Clock, Download,
  Eye, AlertCircle, FileText, Image, Video, Music,
  Archive, Code, Zap, Loader2, Package, Folder
} from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { API_URL } from '../../config/constants';

// Quick share presets
const QUICK_PRESETS = [
  { label: 'View 24h', shareType: 'view', expiresHours: 24, icon: Eye },
  { label: 'Download 7d', shareType: 'download', expiresHours: 168, icon: Download },
  { label: 'Permanent Link', shareType: 'view', expiresHours: null, icon: Link2 },
];

export default function ShareBundleComposer({ selectedFiles = [], selectedFolders = [], onClose, onSuccess, darkMode }) {
  const [bundleName, setBundleName] = useState('');
  const [shareType, setShareType] = useState('view');
  const [expiresHours, setExpiresHours] = useState(null);
  const [password, setPassword] = useState('');
  const [maxDownloads, setMaxDownloads] = useState(null);
  const [allowPreview, setAllowPreview] = useState(true);
  const [allowZipDownload, setAllowZipDownload] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState(null);
  const [shareResult, setShareResult] = useState(null);
  const [copied, setCopied] = useState(false);

  // Calculate total size (files only - folder sizes will be calculated on backend)
  const totalSize = useMemo(() => {
    return selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  }, [selectedFiles]);

  // Total item count
  const totalItems = selectedFiles.length + selectedFolders.length;

  // Generate default bundle name
  const defaultBundleName = useMemo(() => {
    if (selectedFolders.length === 1 && selectedFiles.length === 0) {
      return selectedFolders[0].name;
    }
    if (selectedFiles.length === 1 && selectedFolders.length === 0) {
      return selectedFiles[0].name;
    }
    const parts = [];
    if (selectedFolders.length > 0) {
      parts.push(`${selectedFolders.length} folder${selectedFolders.length > 1 ? 's' : ''}`);
    }
    if (selectedFiles.length > 0) {
      parts.push(`${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`);
    }
    return parts.join(' + ') + ' shared';
  }, [selectedFiles, selectedFolders]);

  const handleQuickPreset = (preset) => {
    setShareType(preset.shareType);
    setExpiresHours(preset.expiresHours);
  };

  const handleCreateBundle = async () => {
    if (selectedFiles.length === 0 && selectedFolders.length === 0) {
      setError('Please select at least one file or folder');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/v1/share-bundles`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          file_ids: selectedFiles.map(f => f.id),
          folder_ids: selectedFolders.map(f => f.id),
          name: bundleName || defaultBundleName,
          share_type: shareType,
          expires_hours: expiresHours,
          password: password || null,
          max_downloads: maxDownloads,
          allow_preview: allowPreview,
          allow_zip_download: allowZipDownload
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to create share bundle');
      }

      const result = await response.json();
      setShareResult(result);

    } catch (err) {
      console.error('Failed to create share bundle:', err);
      setError(err.message || 'Failed to create share bundle');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyLink = async () => {
    if (shareResult?.share_url) {
      try {
        await navigator.clipboard.writeText(shareResult.share_url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  };

  const getFileIcon = (mimeType) => {
    if (!mimeType) return FileText;
    if (mimeType.startsWith('image/')) return Image;
    if (mimeType.startsWith('video/')) return Video;
    if (mimeType.startsWith('audio/')) return Music;
    if (mimeType.includes('zip') || mimeType.includes('archive')) return Archive;
    if (mimeType.includes('code') || mimeType.includes('javascript') || mimeType.includes('json')) return Code;
    return FileText;
  };

  // Success state - show the share link
  if (shareResult) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className={`w-full max-w-lg mx-4 rounded-2xl shadow-2xl ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          {/* Header */}
          <div className={`px-6 py-4 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-green-500/10">
                  <Check className="text-green-500" size={24} />
                </div>
                <div>
                  <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Share Bundle Created!
                  </h2>
                  <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {shareResult.file_count} files • {formatBytes(shareResult.total_size)}
                  </p>
                </div>
              </div>
              <button
                onClick={onSuccess}
                className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
              >
                <X size={20} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4">
            {/* Share Link */}
            <div>
              <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Share Link
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={shareResult.share_url}
                  readOnly
                  className={`flex-1 px-4 py-3 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-gray-700 border-gray-600 text-white'
                      : 'bg-gray-50 border-gray-200 text-gray-900'
                  }`}
                />
                <button
                  onClick={handleCopyLink}
                  className={`px-4 py-3 rounded-xl font-medium transition-all ${
                    copied
                      ? 'bg-green-500 text-white'
                      : 'bg-blue-500 text-white hover:bg-blue-600'
                  }`}
                >
                  {copied ? <Check size={20} /> : <Copy size={20} />}
                </button>
              </div>
            </div>

            {/* Bundle Info */}
            <div className={`p-4 rounded-xl ${darkMode ? 'bg-gray-700/50' : 'bg-gray-50'}`}>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Access:</span>
                  <span className={`ml-2 font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {shareResult.share_type === 'download' ? 'Download' : 'View Only'}
                  </span>
                </div>
                <div>
                  <span className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Expires:</span>
                  <span className={`ml-2 font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {shareResult.expires_at
                      ? new Date(shareResult.expires_at).toLocaleDateString()
                      : 'Never'}
                  </span>
                </div>
                {shareResult.password_protected && (
                  <div className="col-span-2">
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium ${
                      darkMode ? 'bg-purple-900/30 text-purple-400' : 'bg-purple-100 text-purple-700'
                    }`}>
                      <Lock size={12} /> Password Protected
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className={`px-6 py-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <button
              onClick={onSuccess}
              className="w-full py-3 px-4 bg-blue-500 text-white rounded-xl font-medium hover:bg-blue-600 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main composer UI
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={`w-full max-w-2xl mx-4 rounded-2xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        {/* Header */}
        <div className={`px-6 py-4 border-b flex-shrink-0 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-purple-500/10">
                <Package className="text-purple-500" size={24} />
              </div>
              <div>
                <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Create Share Bundle
                </h2>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Share {totalItems} {totalItems === 1 ? 'item' : 'items'} with a single link
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
            >
              <X size={20} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {/* Quick Presets */}
          <div>
            <label className={`block text-sm font-medium mb-3 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <Zap size={14} className="inline mr-1" /> Quick Presets
            </label>
            <div className="flex gap-2">
              {QUICK_PRESETS.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => handleQuickPreset(preset)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                    shareType === preset.shareType && expiresHours === preset.expiresHours
                      ? 'bg-purple-500 text-white'
                      : darkMode
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <preset.icon size={16} />
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Selected Items Preview */}
          <div>
            <label className={`block text-sm font-medium mb-3 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Selected Items ({totalItems})
              {totalSize > 0 && ` • ${formatBytes(totalSize)}`}
              {selectedFolders.length > 0 && ' + folder contents'}
            </label>
            <div className={`rounded-xl border max-h-40 overflow-y-auto ${darkMode ? 'bg-gray-700/50 border-gray-600' : 'bg-gray-50 border-gray-200'}`}>
              {/* Folders first */}
              {selectedFolders.map((folder, idx) => (
                <div
                  key={folder.id}
                  className={`flex items-center gap-3 px-4 py-2.5 ${
                    (idx !== selectedFolders.length - 1 || selectedFiles.length > 0)
                      ? (darkMode ? 'border-b border-gray-600' : 'border-b border-gray-200')
                      : ''
                  }`}
                >
                  <Folder size={18} className="text-blue-500" />
                  <span className={`flex-1 truncate text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {folder.name}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${darkMode ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>
                    Folder
                  </span>
                </div>
              ))}
              {/* Then files */}
              {selectedFiles.map((file, idx) => {
                const IconComponent = getFileIcon(file.mime_type);
                return (
                  <div
                    key={file.id}
                    className={`flex items-center gap-3 px-4 py-2.5 ${
                      idx !== selectedFiles.length - 1
                        ? (darkMode ? 'border-b border-gray-600' : 'border-b border-gray-200')
                        : ''
                    }`}
                  >
                    <IconComponent size={18} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
                    <span className={`flex-1 truncate text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {file.name}
                    </span>
                    <span className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      {formatBytes(file.size)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bundle Name */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Bundle Name
            </label>
            <input
              type="text"
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              placeholder={defaultBundleName}
              className={`w-full px-4 py-3 rounded-xl border text-sm ${
                darkMode
                  ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500'
                  : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400'
              } focus:outline-none focus:ring-2 focus:ring-purple-500`}
            />
          </div>

          {/* Share Type */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Access Type
            </label>
            <div className="flex gap-3">
              <button
                onClick={() => setShareType('view')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  shareType === 'view'
                    ? 'bg-blue-500 text-white'
                    : darkMode
                      ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Eye size={18} />
                View Only
              </button>
              <button
                onClick={() => setShareType('download')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  shareType === 'download'
                    ? 'bg-green-500 text-white'
                    : darkMode
                      ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Download size={18} />
                Download
              </button>
            </div>
          </div>

          {/* Expiration */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <Clock size={14} className="inline mr-1" /> Expiration
            </label>
            <select
              value={expiresHours || 'never'}
              onChange={(e) => setExpiresHours(e.target.value === 'never' ? null : parseInt(e.target.value))}
              className={`w-full px-4 py-3 rounded-xl border text-sm ${
                darkMode
                  ? 'bg-gray-700 border-gray-600 text-white'
                  : 'bg-white border-gray-200 text-gray-900'
              } focus:outline-none focus:ring-2 focus:ring-purple-500`}
            >
              <option value="1">1 hour</option>
              <option value="24">24 hours</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
              <option value="never">Never expires</option>
            </select>
          </div>

          {/* Password Protection */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <Lock size={14} className="inline mr-1" /> Password Protection (optional)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave empty for no password"
              className={`w-full px-4 py-3 rounded-xl border text-sm ${
                darkMode
                  ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500'
                  : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400'
              } focus:outline-none focus:ring-2 focus:ring-purple-500`}
            />
          </div>

          {/* Advanced Options */}
          <div className={`p-4 rounded-xl ${darkMode ? 'bg-gray-700/50' : 'bg-gray-50'}`}>
            <label className={`block text-sm font-medium mb-3 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Advanced Options
            </label>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowPreview}
                  onChange={(e) => setAllowPreview(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-purple-500 focus:ring-purple-500"
                />
                <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Allow file preview
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowZipDownload}
                  onChange={(e) => setAllowZipDownload(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-purple-500 focus:ring-purple-500"
                />
                <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Allow ZIP download (all files)
                </span>
              </label>
              <div className="flex items-center gap-3">
                <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Max downloads:
                </span>
                <input
                  type="number"
                  min="1"
                  value={maxDownloads || ''}
                  onChange={(e) => setMaxDownloads(e.target.value ? parseInt(e.target.value) : null)}
                  placeholder="Unlimited"
                  className={`w-24 px-3 py-1.5 rounded-lg border text-sm ${
                    darkMode
                      ? 'bg-gray-600 border-gray-500 text-white placeholder-gray-400'
                      : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400'
                  } focus:outline-none focus:ring-2 focus:ring-purple-500`}
                />
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertCircle size={20} className="text-red-500" />
              <span className="text-red-500 text-sm">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 border-t flex-shrink-0 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className={`flex-1 py-3 px-4 rounded-xl font-medium transition-colors ${
                darkMode
                  ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Cancel
            </button>
            <button
              onClick={handleCreateBundle}
              disabled={isCreating || (selectedFiles.length === 0 && selectedFolders.length === 0)}
              className="flex-1 py-3 px-4 bg-purple-500 text-white rounded-xl font-medium hover:bg-purple-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isCreating ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Share2 size={18} />
                  Create Share Link
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
