import React, { useState, useRef, useEffect } from 'react';
import { X, Link as LinkIcon, Download, AlertCircle, CheckCircle, Loader } from 'lucide-react';
import { API_URL } from '../../config/constants';
import type { URLUploadModalProps, URLUploadProgress } from './types';
import { getErrorMessage } from './types';

/**
 * URLUploadModal Component
 *
 * Modal for uploading files from a URL.
 */
const URLUploadModal: React.FC<URLUploadModalProps> = ({
  isOpen,
  onClose,
  darkMode,
  onUploadComplete,
}) => {
  const [url, setUrl] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<boolean>(false);
  const [progress, setProgress] = useState<URLUploadProgress | null>(null);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    };
  }, []);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');
    setSuccess(false);
    setLoading(true);

    try {
      // Validate URL - SSRF protection
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error('Invalid URL format');
      }

      // Only allow http and https protocols
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Only HTTP and HTTPS URLs are supported');
      }

      // Block localhost and private IP ranges
      const hostname = parsedUrl.hostname.toLowerCase();
      const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'metadata.google.internal', '169.254.169.254'];
      if (blockedHosts.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        throw new Error('URLs pointing to internal or local addresses are not allowed');
      }

      // Block private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
      const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipMatch) {
        const a = Number(ipMatch[1]);
        const b = Number(ipMatch[2]);
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
          throw new Error('URLs pointing to private network addresses are not allowed');
        }
      }

      const response = await fetch(`${API_URL}/api/v1/upload/from-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { detail?: string };
        throw new Error(errorData.detail || 'Failed to upload from URL');
      }

      const result = (await response.json()) as URLUploadProgress;
      setSuccess(true);
      setProgress(result);

      // Wait 2 seconds then close
      autoCloseTimerRef.current = setTimeout(() => {
        if (onUploadComplete) onUploadComplete();
        handleClose();
      }, 2000);
    } catch (err: unknown) {
      console.error('[URLUpload] Error:', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (): void => {
    setUrl('');
    setError('');
    setSuccess(false);
    setProgress(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`w-full max-w-md rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} p-6`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Download className="text-blue-500" size={24} />
            <h2 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Upload from URL
            </h2>
          </div>
          <button
            onClick={handleClose}
            className={`p-1 rounded-lg ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'} transition-colors`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
            >
              File URL
            </label>
            <div className="relative">
              <LinkIcon
                className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}
                size={18}
              />
              <input
                type="url"
                value={url}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
                placeholder="https://example.com/file.pdf"
                required
                disabled={loading || success}
                className={`w-full pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400'
                    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500'
                } ${loading || success ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
            </div>
            <p className={`mt-1 text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Enter a direct link to a file (images, documents, videos, etc.)
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div
              className={`p-3 rounded-lg flex items-start gap-2 ${
                darkMode ? 'bg-red-900/20 border border-red-800' : 'bg-red-50 border border-red-200'
              }`}
            >
              <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className={`text-sm ${darkMode ? 'text-red-200' : 'text-red-700'}`}>{error}</p>
            </div>
          )}

          {/* Success Message */}
          {success && progress && (
            <div
              className={`p-3 rounded-lg flex items-start gap-2 ${
                darkMode
                  ? 'bg-green-900/20 border border-green-800'
                  : 'bg-green-50 border border-green-200'
              }`}
            >
              <CheckCircle size={18} className="text-green-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p
                  className={`text-sm font-medium ${darkMode ? 'text-green-200' : 'text-green-700'}`}
                >
                  Upload started successfully!
                </p>
                {progress.file_name && (
                  <p className={`text-xs mt-1 ${darkMode ? 'text-green-300' : 'text-green-600'}`}>
                    {progress.file_name} (
                    {progress.file_size
                      ? `${(progress.file_size / 1024 / 1024).toFixed(2)} MB`
                      : 'Unknown size'}
                    )
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                darkMode
                  ? 'bg-gray-700 hover:bg-gray-600 text-white'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-900'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || success || !url}
              className={`flex-1 px-4 py-2 rounded-lg font-medium text-white transition-colors flex items-center justify-center gap-2 ${
                loading || success || !url
                  ? 'bg-blue-400 cursor-not-allowed'
                  : 'bg-blue-500 hover:bg-blue-600'
              }`}
            >
              {loading ? (
                <>
                  <Loader size={18} className="animate-spin" />
                  Uploading...
                </>
              ) : success ? (
                <>
                  <CheckCircle size={18} />
                  Success!
                </>
              ) : (
                <>
                  <Download size={18} />
                  Upload
                </>
              )}
            </button>
          </div>
        </form>

        {/* Info */}
        <div
          className={`mt-4 p-3 rounded-lg ${
            darkMode ? 'bg-blue-900/20 border border-blue-800' : 'bg-blue-50 border border-blue-200'
          }`}
        >
          <p className={`text-xs ${darkMode ? 'text-blue-200' : 'text-blue-700'}`}>
            <strong>Supported sources:</strong> Direct download links from any publicly accessible
            URL
          </p>
          <p className={`text-xs mt-1 ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}>
            <strong>Note:</strong> The file will be downloaded to the server and stored in your
            account
          </p>
        </div>
      </div>
    </div>
  );
};

export default URLUploadModal;
