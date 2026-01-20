import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download,
  Lock,
  AlertCircle,
  Shield,
  Cloud,
  FileText,
  Loader,
  CheckCircle,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';
import {
  deriveKeyFromPassword,
  decryptFileKey,
  decryptChunk,
} from '../../utils/zkCrypto';
import type { ShareInfo, ZKShareInfo } from './types';
import { isShareInfo, isZKShareInfo, getErrorMessage } from './types';

/**
 * SharePage Component
 *
 * Single file share page with support for:
 * - Legacy (non-ZK) file downloads
 * - ZK-encrypted file downloads with client-side decryption
 * - Password protection
 * - Download progress tracking
 *
 * Features:
 * - Detects ZK vs legacy shares automatically
 * - Client-side decryption for ZK files
 * - Progress indicator for chunked downloads
 * - Password validation
 */
const SharePage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [requiresPassword, setRequiresPassword] = useState<boolean>(false);
  const [password, setPassword] = useState<string>('');
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [shareInfo, setShareInfo] = useState<ShareInfo | ZKShareInfo | null>(null);
  const [isZKEncrypted, setIsZKEncrypted] = useState<boolean>(false);

  useEffect(() => {
    void fetchShareInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const fetchShareInfo = async (): Promise<void> => {
    try {
      // Try to get ZK share info from dedicated ZK endpoint
      const response = await fetch(`${API_URL}/api/v1/share/${token}/zk-info`);

      if (response.ok) {
        const data: unknown = await response.json();
        if (isZKShareInfo(data)) {
          setShareInfo(data);
          setIsZKEncrypted(true);
          setRequiresPassword(data.password_required || false);
          setLoading(false);
          return;
        } else if (isShareInfo(data)) {
          setShareInfo(data);
          setIsZKEncrypted(false);
          setRequiresPassword(data.password_required || false);
          setLoading(false);
          return;
        }
      }

      // If info endpoint fails, it might be a legacy share
      if (response.status === 404) {
        setError('Share link not found or has expired');
      } else if (response.status === 410) {
        setError('Share link has expired');
      } else if (response.status === 403) {
        setError('Download limit exceeded for this share link');
      }
    } catch (err: unknown) {
      console.error('Failed to fetch share info:', getErrorMessage(err));
    }

    setLoading(false);
  };

  const handleDownload = async (): Promise<void> => {
    if (isZKEncrypted) {
      await handleZKDownload();
    } else {
      await handleLegacyDownload();
    }
  };

  /**
   * Handle ZK-encrypted file download with client-side decryption
   */
  const handleZKDownload = async (): Promise<void> => {
    if (!password) {
      setError('Password required for encrypted files');
      setRequiresPassword(true);
      return;
    }

    if (!isZKShareInfo(shareInfo)) {
      setError('Invalid share information');
      return;
    }

    setDownloading(true);
    setError('');
    setDownloadProgress(0);

    try {
      // 1. Derive key from password
      // Note: For ZK shares, we need a salt. The share should include one.
      // Using a fixed salt for share links (derived from token)
      const encoder = new TextEncoder();
      const tokenHash = await crypto.subtle.digest('SHA-256', encoder.encode(token || ''));
      const salt = new Uint8Array(tokenHash).slice(0, 32);

      const derivedKey = deriveKeyFromPassword(password, salt, 600000);

      // 2. Decrypt the file key
      let fileKey: Uint8Array;
      try {
        fileKey = decryptFileKey(
          shareInfo.encrypted_file_key,
          derivedKey,
          shareInfo.file_key_iv
        );
      } catch (e: unknown) {
        setError('Invalid password. Unable to decrypt file.');
        setDownloading(false);
        return;
      }

      // 3. Download and decrypt chunks
      const chunks = shareInfo.chunks || [];
      const decryptedChunks: Uint8Array[] = [];
      let totalBytes = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const url = new URL(`${API_URL}${chunk.url}`);
        if (password) {
          url.searchParams.append('password', password);
        }

        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error(`Failed to download chunk ${i}`);
        }

        const encryptedChunk = new Uint8Array(await response.arrayBuffer());

        // Decrypt chunk
        const decryptedChunk = decryptChunk(encryptedChunk, fileKey, i);
        decryptedChunks.push(decryptedChunk);
        totalBytes += decryptedChunk.length;

        // Update progress
        setDownloadProgress(Math.round(((i + 1) / chunks.length) * 100));
      }

      // 4. Combine chunks and create download
      const fileData = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of decryptedChunks) {
        fileData.set(chunk, offset);
        offset += chunk.length;
      }

      // Create download
      const blob = new Blob([fileData]);
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `shared_file_${(token || '').slice(0, 8)}`; // Default filename
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);

      setDownloading(false);
      setDownloadProgress(100);
    } catch (err: unknown) {
      console.error('ZK download failed:', getErrorMessage(err));
      setError(getErrorMessage(err) || 'Download failed');
      setDownloading(false);
    }
  };

  /**
   * Handle legacy (non-ZK) file download
   */
  const handleLegacyDownload = async (): Promise<void> => {
    setDownloading(true);
    setError('');

    try {
      const url = new URL(`${API_URL}/api/v1/share/${token}`);
      if (password) {
        url.searchParams.append('password', password);
      }

      const response = await fetch(url.toString());

      if (response.status === 400) {
        // This is a ZK file - switch to ZK mode
        const data: unknown = await response.json();
        if (
          typeof data === 'object' &&
          data !== null &&
          'detail' in data &&
          typeof (data as { detail: unknown }).detail === 'string' &&
          (data as { detail: string }).detail.includes('zero-knowledge')
        ) {
          setIsZKEncrypted(true);
          setRequiresPassword(true);
          setError('This file is encrypted. Please enter the password to decrypt.');
          setDownloading(false);
          return;
        }
      }

      if (response.status === 401) {
        setError('Password required or invalid');
        setRequiresPassword(true);
        setDownloading(false);
        return;
      } else if (response.status === 404) {
        setError('Share link not found or has expired');
        setDownloading(false);
        return;
      } else if (response.status === 410) {
        setError('Share link has expired');
        setDownloading(false);
        return;
      } else if (response.status === 403) {
        setError('Download limit exceeded for this share link');
        setDownloading(false);
        return;
      } else if (!response.ok) {
        setError('Failed to download file');
        setDownloading(false);
        return;
      }

      // Extract filename from Content-Disposition header
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = 'download';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
        }
      }

      // Download the file
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);

      setDownloading(false);
    } catch (err: unknown) {
      console.error('Download failed:', getErrorMessage(err));
      setError(getErrorMessage(err) || 'Download failed');
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
            <Cloud className="text-white" size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Edge Cloud Storage</h1>
            <p className="text-sm text-gray-500">Shared File</p>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader className="animate-spin text-blue-500 mb-3" size={32} />
            <p className="text-gray-600">Checking share link...</p>
          </div>
        ) : error && !requiresPassword ? (
          <div className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="text-red-500 mb-3" size={48} />
            <p className="text-red-600 text-center mb-4">{error}</p>
            <button
              onClick={() => navigate('/auth')}
              className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              Go to Login
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* ZK Encryption Badge */}
            {isZKEncrypted && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center gap-2 text-green-700">
                  <Shield size={20} />
                  <span className="font-medium">Zero-Knowledge Encrypted</span>
                </div>
                <p className="text-sm text-green-600 mt-1">
                  This file is encrypted. Decryption happens in your browser - the server never
                  sees your data.
                </p>
              </div>
            )}

            {/* Info Box */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center gap-3 mb-2">
                <FileText className="text-gray-600" size={20} />
                <span className="font-medium text-gray-900">Shared File</span>
              </div>
              {shareInfo && 'file_size' in shareInfo && shareInfo.file_size && (
                <p className="text-sm text-gray-500 ml-8">
                  Size: {formatBytes(shareInfo.file_size)}
                </p>
              )}
            </div>

            {/* Error Message */}
            {error && requiresPassword && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            {/* Password Input */}
            {requiresPassword && (
              <div>
                <label className="flex items-center gap-2 mb-2 text-sm font-medium text-gray-700">
                  <Lock size={16} />
                  {isZKEncrypted ? 'Decryption Password' : 'Password Required'}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setPassword(e.target.value)
                  }
                  onKeyPress={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (
                      e.key === 'Enter' &&
                      !downloading &&
                      password &&
                      handleDownload
                    ) {
                      void handleDownload();
                    }
                  }}
                  className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={isZKEncrypted ? 'Enter decryption password' : 'Enter password'}
                  disabled={downloading}
                  autoFocus
                />
                {isZKEncrypted && (
                  <p className="text-xs text-gray-500 mt-1">
                    Your password is used locally to decrypt the file.
                  </p>
                )}
              </div>
            )}

            {/* Optional Password Field - Show button if not yet required */}
            {!requiresPassword && (
              <div>
                <button
                  onClick={() => setRequiresPassword(true)}
                  className="text-sm text-blue-500 hover:text-blue-600 flex items-center gap-1"
                >
                  <Lock size={14} />
                  This file is password protected? Click here
                </button>
              </div>
            )}

            {/* Download Progress */}
            {downloading && downloadProgress > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>{isZKEncrypted ? 'Decrypting...' : 'Downloading...'}</span>
                  <span>{downloadProgress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-gradient-to-r from-blue-500 to-purple-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Download Button */}
            <button
              onClick={() => void handleDownload()}
              disabled={downloading || (requiresPassword && !password)}
              className={`w-full py-3 rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg ${
                downloading || (requiresPassword && !password)
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white'
              }`}
            >
              {downloading ? (
                <>
                  <Loader className="animate-spin" size={20} />
                  {isZKEncrypted ? 'Decrypting & Downloading...' : 'Downloading...'}
                </>
              ) : downloadProgress === 100 ? (
                <>
                  <CheckCircle size={20} />
                  Download Complete
                </>
              ) : (
                <>
                  <Download size={20} />
                  {isZKEncrypted ? 'Decrypt & Download' : 'Download File'}
                </>
              )}
            </button>

            {/* Footer */}
            <div className="text-center pt-4 border-t">
              <p className="text-sm text-gray-500">Powered by Edge Cloud Storage</p>
              <button
                onClick={() => navigate('/auth')}
                className="text-sm text-blue-500 hover:text-blue-600 mt-2"
              >
                Sign in to your account
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SharePage;
