import React, { useState } from 'react';
import { X, Lock, Clock, Download, Link as LinkIcon, Copy, Check, Eye, Edit, Users, ShieldCheck } from 'lucide-react';
import { API_URL } from '../../config/constants';
import type { ShareOptionsModalProps } from './types';
import { getErrorMessage } from './types';

type SharingMode = 'link' | 'people';
type ShareType = 'view' | 'download' | 'edit';
type Permission = 'view' | 'download' | 'edit';

interface ErrorDetail {
  loc: string[];
  msg: string;
  type: string;
}

interface ErrorResponse {
  detail?: string | ErrorDetail[];
}

interface ShareResponse {
  share_url: string;
}

/**
 * ShareOptionsModal - Modal for creating share links or collaborative shares
 */
const ShareOptionsModal: React.FC<ShareOptionsModalProps> = ({ file, folder, onClose, darkMode, onShareComplete }) => {
  // Check if file is ZK encrypted - block sharing
  const isZKEncrypted = file?.is_encrypted || file?.encryption_mode === 'client_zk';

  const [shareUrl, setShareUrl] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // Sharing mode
  const [sharingMode, setSharingMode] = useState<SharingMode>('link');

  // Form state
  const [shareType, setShareType] = useState<ShareType>('view');
  const [expirationEnabled, setExpirationEnabled] = useState<boolean>(false);
  const [expirationHours, setExpirationHours] = useState<number>(24);
  const [passwordEnabled, setPasswordEnabled] = useState<boolean>(false);
  const [password, setPassword] = useState<string>('');
  const [downloadLimitEnabled, setDownloadLimitEnabled] = useState<boolean>(false);
  const [maxDownloads, setMaxDownloads] = useState<number>(10);

  // Collaborative sharing
  const [emails, setEmails] = useState<string>('');
  const [permission, setPermission] = useState<Permission>('view');

  // If ZK encrypted, show blocked message
  if (isZKEncrypted) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className={`p-6 rounded-2xl max-w-md w-full shadow-2xl ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="text-center">
            {/* Icon */}
            <div className={`mx-auto w-20 h-20 rounded-full flex items-center justify-center mb-6 ${
              darkMode ? 'bg-green-900/30' : 'bg-green-100'
            }`}>
              <ShieldCheck className={darkMode ? 'text-green-400' : 'text-green-600'} size={40} />
            </div>

            {/* Title */}
            <h3 className={`text-xl font-bold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Sharing Not Available
            </h3>

            {/* Message */}
            <p className={`mb-6 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              <span className="font-medium">"{file?.name}"</span> is protected with Zero-Knowledge encryption.
            </p>

            {/* Explanation Box */}
            <div className={`p-4 rounded-xl text-left mb-6 ${
              darkMode ? 'bg-gray-900 border border-gray-700' : 'bg-gray-50 border border-gray-200'
            }`}>
              <div className="flex items-start gap-3">
                <Lock className={`flex-shrink-0 mt-0.5 ${darkMode ? 'text-green-400' : 'text-green-600'}`} size={18} />
                <div>
                  <p className={`text-sm font-medium mb-1 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    End-to-End Encrypted
                  </p>
                  <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    Only you can decrypt this file with your password. Sharing would require sharing your encryption keys, which defeats the purpose of zero-knowledge security.
                  </p>
                </div>
              </div>
            </div>

            {/* Alternative suggestion */}
            <p className={`text-sm mb-6 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              To share this file, download it first and send it through a secure channel.
            </p>

            {/* Close Button */}
            <button
              onClick={onClose}
              className={`w-full py-3 rounded-xl font-semibold transition-all ${
                darkMode
                  ? 'bg-gray-700 hover:bg-gray-600 text-white'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
              }`}
              type="button"
            >
              I Understand
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleCreateShare = async (): Promise<void> => {
    setLoading(true);
    setError('');

    // Validate password minimum length
    if (sharingMode === 'link' && passwordEnabled && password && password.length < 8) {
      setError('Password must be at least 8 characters long.');
      setLoading(false);
      return;
    }

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
      const itemId = folder ? folder.id : file?.id;

      if (!itemId) {
        throw new Error('No file or folder selected');
      }

      const response = await fetch(`${API_URL}/api/v1/${itemType}/${itemId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(shareData),
      });

      if (!response.ok) {
        const errorData = await response.json() as ErrorResponse;
        console.error('Share creation error:', errorData);

        // Handle validation errors
        if (errorData.detail && Array.isArray(errorData.detail)) {
          const errors = errorData.detail.map(e => `${e.loc.join('.')}: ${e.msg}`).join(', ');
          throw new Error(errors);
        }

        throw new Error(typeof errorData.detail === 'string' ? errorData.detail : 'Failed to create share link');
      }

      const data = await response.json() as ShareResponse;
      setShareUrl(data.share_url);
      
      if (onShareComplete) {
        onShareComplete({
          share_url: data.share_url,
          expires_at: expirationEnabled ? new Date(Date.now() + expirationHours * 3600000).toISOString() : undefined,
          password_protected: passwordEnabled,
          max_downloads: downloadLimitEnabled ? maxDownloads : undefined,
        } as Parameters<typeof onShareComplete>[0]);
      }
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to create share link:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleCollaborativeShare = async (): Promise<void> => {
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
    const itemId = folder ? folder.id : file?.id;

    if (!itemId) {
      setError('No file or folder selected');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/v1/${itemType}/${itemId}/collaborate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(shareData),
      });

      if (!response.ok) {
        const errorData = await response.json() as ErrorResponse;
        throw new Error(typeof errorData.detail === 'string' ? errorData.detail : 'Failed to share');
      }

      const data = await response.json() as { message?: string };
      setShareUrl(`Shared with ${emailList.length} user(s)`);
      
      if (onShareComplete) {
        onShareComplete({
          share_url: data.message || `Shared with ${emailList.length} user(s)`,
        } as Parameters<typeof onShareComplete>[0]);
      }
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: attempt using a temporary textarea
      try {
        const textarea = document.createElement('textarea');
        textarea.value = shareUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        alert('Copy failed. Please select and copy the link manually.');
      }
    }
  };

  const itemName = folder ? folder.name : file?.name || 'Unknown';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className={`p-6 rounded-lg max-w-md w-full ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex justify-between items-center mb-4">
          <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Share "{itemName}"
          </h3>
          <button
            onClick={onClose}
            className={`p-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            type="button"
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
              type="button"
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
              type="button"
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
                  type="button"
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
              type="button"
            >
              Done
            </button>
          </div>
        ) : (
          // Share creation form
          <div className="space-y-4">
            {error && (
              <div className={`p-3 rounded ${darkMode ? 'bg-red-900/30 text-red-300' : 'bg-red-100 text-red-700'} text-sm`}>
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
                    onChange={(e) => setExpirationHours(parseInt(e.target.value) || 24)}
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
                    minLength={8}
                    className={`w-full px-3 py-2 rounded border ${
                      darkMode
                        ? 'bg-gray-700 border-gray-600 text-white'
                        : 'bg-white border-gray-300 text-gray-900'
                    } ${password && password.length < 8 ? 'border-red-500' : ''}`}
                    placeholder="Enter password (min 8 characters)"
                  />
                  {password && password.length < 8 && (
                    <p className="text-xs text-red-500 mt-1">
                      Password must be at least 8 characters long.
                    </p>
                  )}
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
                    onChange={(e) => setMaxDownloads(parseInt(e.target.value) || 10)}
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
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateShare}
                disabled={loading || (sharingMode === 'link' && passwordEnabled && (!password || password.length < 8)) || (sharingMode === 'people' && !emails)}
                className={`flex-1 py-2 rounded flex items-center justify-center gap-2 transition-colors ${
                  loading || (sharingMode === 'link' && passwordEnabled && (!password || password.length < 8)) || (sharingMode === 'people' && !emails)
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-blue-500 hover:bg-blue-600'
                } text-white`}
                type="button"
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
};

export default ShareOptionsModal;
