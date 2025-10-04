import React, { useState } from 'react';
import { X, Lock, Clock, Download, Link as LinkIcon, Copy, Check, Eye, Edit, Users } from 'lucide-react';
import { API_URL } from '../../config/constants';

export default function ShareOptionsModal({ file, folder, onClose, darkMode }) {
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Sharing mode
  const [sharingMode, setSharingMode] = useState('link'); // 'link' or 'people'

  // Form state
  const [shareType, setShareType] = useState('view'); // view, download, edit
  const [expirationEnabled, setExpirationEnabled] = useState(false);
  const [expirationHours, setExpirationHours] = useState(24);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [downloadLimitEnabled, setDownloadLimitEnabled] = useState(false);
  const [maxDownloads, setMaxDownloads] = useState(10);

  // Collaborative sharing
  const [emails, setEmails] = useState('');
  const [permission, setPermission] = useState('view');

  const handleCreateShare = async () => {
    setLoading(true);
    setError('');

    try {
      if (sharingMode === 'people') {
        // Collaborative sharing with specific users
        await handleCollaborativeShare();
        return;
      }

      // Link sharing (anyone with link)
      const shareData = {
        share_type: shareType,
        expires_hours: expirationEnabled ? expirationHours : null,
        password: passwordEnabled ? password : null,
        max_downloads: downloadLimitEnabled ? maxDownloads : null,
        allow_preview: true,
      };

      const itemType = folder ? 'folders' : 'files';
      const itemId = folder ? folder.id : file.id;

      const response = await fetch(`${API_URL}/${itemType}/${itemId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(shareData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Share creation error:', errorData);

        // Handle validation errors
        if (errorData.detail && Array.isArray(errorData.detail)) {
          const errors = errorData.detail.map(e => `${e.loc.join('.')}: ${e.msg}`).join(', ');
          throw new Error(errors);
        }

        throw new Error(errorData.detail || 'Failed to create share link');
      }

      const data = await response.json();
      setShareUrl(data.share_url);
    } catch (err) {
      console.error('Failed to create share link:', err);
      setError(err.message || 'Failed to create share link');
    } finally {
      setLoading(false);
    }
  };

  const handleCollaborativeShare = async () => {
    const emailList = emails.split(',').map(e => e.trim()).filter(e => e);

    if (emailList.length === 0) {
      setError('Please enter at least one email address');
      setLoading(false);
      return;
    }

    const shareData = {
      emails: emailList,
      permission: permission,
      expires_hours: expirationEnabled ? expirationHours : null,
    };

    const itemType = folder ? 'folders' : 'files';
    const itemId = folder ? folder.id : file.id;

    const response = await fetch(`${API_URL}/${itemType}/${itemId}/collaborate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(shareData),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.detail || 'Failed to share');
    }

    const data = await response.json();
    setShareUrl(`Shared with ${emailList.length} user(s)`);
    setLoading(false);
  };

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className={`p-6 rounded-lg max-w-md w-full ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex justify-between items-center mb-4">
          <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Share "{folder ? folder.name : file.name}"
          </h3>
          <button
            onClick={onClose}
            className={`p-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Sharing mode toggle */}
        {!shareUrl && (
          <div className={`flex gap-2 mb-4 p-1 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
            <button
              onClick={() => setSharingMode('link')}
              className={`flex-1 py-2 px-3 rounded-md flex items-center justify-center gap-2 transition-colors ${
                sharingMode === 'link'
                  ? darkMode ? 'bg-gray-600 text-white' : 'bg-white text-gray-900 shadow'
                  : darkMode ? 'text-gray-300' : 'text-gray-600'
              }`}
            >
              <LinkIcon size={16} />
              <span className="text-sm font-medium">Share Link</span>
            </button>
            <button
              onClick={() => setSharingMode('people')}
              className={`flex-1 py-2 px-3 rounded-md flex items-center justify-center gap-2 transition-colors ${
                sharingMode === 'people'
                  ? darkMode ? 'bg-gray-600 text-white' : 'bg-white text-gray-900 shadow'
                  : darkMode ? 'text-gray-300' : 'text-gray-600'
              }`}
            >
              <Users size={16} />
              <span className="text-sm font-medium">Share with People</span>
            </button>
          </div>
        )}

        {shareUrl ? (
          // Share created - show URL
          <div className="space-y-4">
            <div className={`p-3 rounded ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
              <p className="text-sm text-gray-500 mb-1">Share URL:</p>
              <div className="flex items-center gap-2">
                <p className={`text-sm break-all flex-1 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {shareUrl}
                </p>
                <button
                  onClick={handleCopy}
                  className={`p-2 rounded ${darkMode ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                  title="Copy link"
                >
                  {copied ? (
                    <Check size={16} className="text-green-500" />
                  ) : (
                    <Copy size={16} />
                  )}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center py-2">
                <span className="flex items-center gap-2">
                  <Clock size={16} className={darkMode ? 'text-gray-300' : 'text-gray-600'} />
                  <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                    Expires
                  </span>
                </span>
                <kbd className={`px-2 py-1 rounded text-sm font-mono ${
                  darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                }`}>
                  {expirationEnabled ? `${expirationHours}h` : 'Never'}
                </kbd>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="flex items-center gap-2">
                  <Lock size={16} className={darkMode ? 'text-gray-300' : 'text-gray-600'} />
                  <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                    Password
                  </span>
                </span>
                <kbd className={`px-2 py-1 rounded text-sm font-mono ${
                  darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                }`}>
                  {passwordEnabled ? 'Protected' : 'None'}
                </kbd>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="flex items-center gap-2">
                  <Download size={16} className={darkMode ? 'text-gray-300' : 'text-gray-600'} />
                  <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                    Download Limit
                  </span>
                </span>
                <kbd className={`px-2 py-1 rounded text-sm font-mono ${
                  darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                }`}>
                  {downloadLimitEnabled ? maxDownloads : 'Unlimited'}
                </kbd>
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-full py-2 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          // Share creation form
          <div className="space-y-4">
            {error && (
              <div className="p-3 rounded bg-red-100 text-red-700 text-sm">
                {error}
              </div>
            )}

            {/* Email input for collaborative sharing */}
            {sharingMode === 'people' && (
              <div>
                <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  <Users size={16} className="inline mr-1" />
                  Share with (comma-separated emails)
                </label>
                <input
                  type="text"
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="john@example.com, jane@example.com"
                  className={`w-full px-3 py-2 rounded border ${
                    darkMode
                      ? 'bg-gray-700 border-gray-600 text-white'
                      : 'bg-white border-gray-300 text-gray-900'
                  }`}
                />
              </div>
            )}

            {/* Permission selector */}
            <div>
              <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {sharingMode === 'people' ? 'Permission Level' : 'Access Type'}
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => sharingMode === 'people' ? setPermission('view') : setShareType('view')}
                  className={`py-2 px-3 rounded-lg border-2 transition-all ${
                    (sharingMode === 'people' ? permission : shareType) === 'view'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}
                >
                  <Eye size={18} className="mx-auto mb-1" />
                  <span className="text-xs block">View</span>
                </button>
                <button
                  type="button"
                  onClick={() => sharingMode === 'people' ? setPermission('download') : setShareType('download')}
                  className={`py-2 px-3 rounded-lg border-2 transition-all ${
                    (sharingMode === 'people' ? permission : shareType) === 'download'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}
                >
                  <Download size={18} className="mx-auto mb-1" />
                  <span className="text-xs block">Download</span>
                </button>
                <button
                  type="button"
                  onClick={() => sharingMode === 'people' ? setPermission('edit') : setShareType('edit')}
                  className={`py-2 px-3 rounded-lg border-2 transition-all ${
                    (sharingMode === 'people' ? permission : shareType) === 'edit'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}
                >
                  <Edit size={18} className="mx-auto mb-1" />
                  <span className="text-xs block">Edit</span>
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {sharingMode === 'people' ? (
                  permission === 'view' ? 'Can view files only' :
                  permission === 'download' ? 'Can view and download files' :
                  'Can view, download, upload, and delete files'
                ) : (
                  shareType === 'view' ? 'Can only view files' :
                  shareType === 'download' ? 'Can view and download files' :
                  'Can view, download, and upload files'
                )}
              </p>
            </div>

            {/* Link-specific options (only for share link mode) */}
            {sharingMode === 'link' && (
              <>
            {/* Expiration Option */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={expirationEnabled}
                  onChange={(e) => setExpirationEnabled(e.target.checked)}
                  className="rounded"
                />
                <Clock size={16} />
                <span className={`text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Set expiration time
                </span>
              </label>
              {expirationEnabled && (
                <div className="mt-2 ml-6">
                  <input
                    type="number"
                    min="1"
                    max="8760"
                    value={expirationHours}
                    onChange={(e) => setExpirationHours(parseInt(e.target.value))}
                    className={`w-full px-3 py-2 rounded border ${
                      darkMode
                        ? 'bg-gray-700 border-gray-600 text-white'
                        : 'bg-white border-gray-300 text-gray-900'
                    }`}
                    placeholder="Hours until expiration"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {expirationHours < 24
                      ? `${expirationHours} hours`
                      : `${Math.floor(expirationHours / 24)} days`}
                  </p>
                </div>
              )}
            </div>

            {/* Password Option */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={passwordEnabled}
                  onChange={(e) => setPasswordEnabled(e.target.checked)}
                  className="rounded"
                />
                <Lock size={16} />
                <span className={`text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Require password
                </span>
              </label>
              {passwordEnabled && (
                <div className="mt-2 ml-6">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`w-full px-3 py-2 rounded border ${
                      darkMode
                        ? 'bg-gray-700 border-gray-600 text-white'
                        : 'bg-white border-gray-300 text-gray-900'
                    }`}
                    placeholder="Enter password"
                  />
                </div>
              )}
            </div>

            {/* Download Limit Option */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={downloadLimitEnabled}
                  onChange={(e) => setDownloadLimitEnabled(e.target.checked)}
                  className="rounded"
                />
                <Download size={16} />
                <span className={`text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Limit downloads
                </span>
              </label>
              {downloadLimitEnabled && (
                <div className="mt-2 ml-6">
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={maxDownloads}
                    onChange={(e) => setMaxDownloads(parseInt(e.target.value))}
                    className={`w-full px-3 py-2 rounded border ${
                      darkMode
                        ? 'bg-gray-700 border-gray-600 text-white'
                        : 'bg-white border-gray-300 text-gray-900'
                    }`}
                    placeholder="Max downloads"
                  />
                </div>
              )}
            </div>
              </>
            )}

            <div className="flex gap-2 mt-6">
              <button
                onClick={onClose}
                className={`flex-1 py-2 rounded ${
                  darkMode
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-900'
                } transition-colors`}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateShare}
                disabled={loading || (sharingMode === 'link' && passwordEnabled && !password) || (sharingMode === 'people' && !emails)}
                className={`flex-1 py-2 rounded flex items-center justify-center gap-2 transition-colors ${
                  loading || (sharingMode === 'link' && passwordEnabled && !password) || (sharingMode === 'people' && !emails)
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-blue-500 hover:bg-blue-600'
                } text-white`}
              >
                {sharingMode === 'people' ? <Users size={16} /> : <LinkIcon size={16} />}
                {loading ? 'Sharing...' : (sharingMode === 'people' ? 'Share with People' : 'Create Link')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
