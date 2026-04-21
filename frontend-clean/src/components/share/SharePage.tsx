import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download,
  Lock,
  AlertCircle,
  Shield,
  Cloud,
  FileText,
  CheckCircle,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';
import { deriveKeyFromPassword, decryptFileKey, decryptChunk } from '../../utils/zkCrypto';
import type { ShareInfo, ZKShareInfo } from './types';
import { isShareInfo, isZKShareInfo, getErrorMessage } from './types';
import {
  Banner,
  Button,
  Card,
  CardContent,
  FormField,
  Input,
  Progress,
  Spinner,
} from '@/components/ui';

/**
 * SharePage — public landing page for a single shared file. Detects ZK vs
 * legacy shares via `/share/:token/zk-info`, handles password entry, and
 * performs client-side chunked decryption for ZK files.
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
      // TODO: Weak salt pattern — deriving salt from the share token is predictable.
      // The backend should store and return a random salt per share link.
      const encoder = new TextEncoder();
      const tokenHash = await crypto.subtle.digest('SHA-256', encoder.encode(token || ''));
      const salt = new Uint8Array(tokenHash).slice(0, 32);

      const derivedKey = deriveKeyFromPassword(password, salt, 600000);

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

      const chunks = shareInfo.chunks || [];
      const decryptedChunks: Uint8Array[] = [];
      let totalBytes = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const url = new URL(`${API_URL}${chunk.url}`);
        const chunkHeaders: Record<string, string> = {};
        if (password) {
          chunkHeaders['X-Share-Password'] = password;
        }

        const response = await fetch(url.toString(), { headers: chunkHeaders });
        if (!response.ok) {
          throw new Error(`Failed to download chunk ${i}`);
        }

        const encryptedChunk = new Uint8Array(await response.arrayBuffer());
        const decryptedChunk = decryptChunk(encryptedChunk, fileKey, i);
        decryptedChunks.push(decryptedChunk);
        totalBytes += decryptedChunk.length;

        setDownloadProgress(Math.round(((i + 1) / chunks.length) * 100));
      }

      const fileData = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of decryptedChunks) {
        fileData.set(chunk, offset);
        offset += chunk.length;
      }

      const blob = new Blob([fileData]);
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `shared_file_${(token || '').slice(0, 8)}`;
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

  const handleLegacyDownload = async (): Promise<void> => {
    setDownloading(true);
    setError('');

    try {
      const url = new URL(`${API_URL}/api/v1/share/${token}`);
      const headers: Record<string, string> = {};
      if (password) {
        headers['X-Share-Password'] = password;
      }

      const response = await fetch(url.toString(), { headers });

      if (response.status === 400) {
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

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = 'download';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
        }
      }

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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary/10 via-accent/10 to-accent/5 p-4">
      <Card variant="elevated" className="w-full max-w-md">
        <CardContent className="p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent">
              <Cloud className="text-white" size={24} />
            </div>
            <div>
              <h1 className="text-h2 font-bold text-fg">Edge Cloud Storage</h1>
              <p className="text-body-sm text-fg-muted">Shared file</p>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Spinner size="lg" className="mb-3" />
              <p className="text-body-sm text-fg-muted">Checking share link...</p>
            </div>
          ) : error && !requiresPassword ? (
            <div className="flex flex-col items-center justify-center py-12">
              <AlertCircle className="mb-3 text-danger" size={48} />
              <p className="mb-4 text-center text-body-sm text-danger">{error}</p>
              <Button variant="primary" onClick={() => navigate('/auth')}>
                Go to login
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {isZKEncrypted && (
                <Banner
                  variant="success"
                  icon={<Shield />}
                  title="Zero-knowledge encrypted"
                >
                  This file is encrypted. Decryption happens in your browser — the server never
                  sees your data.
                </Banner>
              )}

              <div className="rounded-lg bg-surface-muted p-4">
                <div className="mb-2 flex items-center gap-3">
                  <FileText className="text-fg-muted" size={20} />
                  <span className="font-medium text-fg">Shared file</span>
                </div>
                {shareInfo && 'file_size' in shareInfo && shareInfo.file_size && (
                  <p className="ml-8 text-body-sm text-fg-muted">
                    Size: {formatBytes(shareInfo.file_size)}
                  </p>
                )}
              </div>

              {error && requiresPassword && (
                <Banner variant="danger" icon={<AlertCircle />}>
                  {error}
                </Banner>
              )}

              {requiresPassword && (
                <FormField
                  label={
                    <span className="flex items-center gap-2">
                      <Lock size={16} />
                      {isZKEncrypted ? 'Decryption password' : 'Password required'}
                    </span>
                  }
                  hint={isZKEncrypted ? 'Your password is used locally to decrypt the file.' : undefined}
                >
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !downloading && password) {
                        void handleDownload();
                      }
                    }}
                    placeholder={isZKEncrypted ? 'Enter decryption password' : 'Enter password'}
                    disabled={downloading}
                    autoFocus
                  />
                </FormField>
              )}

              {!requiresPassword && (
                <Button
                  variant="link"
                  size="sm"
                  leftIcon={<Lock size={14} />}
                  onClick={() => setRequiresPassword(true)}
                >
                  This file is password protected? Click here
                </Button>
              )}

              {downloading && downloadProgress > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-body-sm text-fg-muted">
                    <span>{isZKEncrypted ? 'Decrypting...' : 'Downloading...'}</span>
                    <span>{downloadProgress}%</span>
                  </div>
                  <Progress value={downloadProgress} tone="primary" />
                </div>
              )}

              <Button
                variant="primary"
                fullWidth
                loading={downloading}
                disabled={downloading || (requiresPassword && !password)}
                onClick={() => void handleDownload()}
                leftIcon={
                  downloadProgress === 100 && !downloading ? (
                    <CheckCircle size={20} />
                  ) : !downloading ? (
                    <Download size={20} />
                  ) : undefined
                }
              >
                {downloading
                  ? isZKEncrypted
                    ? 'Decrypting & downloading...'
                    : 'Downloading...'
                  : downloadProgress === 100
                    ? 'Download complete'
                    : isZKEncrypted
                      ? 'Decrypt & download'
                      : 'Download file'}
              </Button>

              <div className="border-t border-border pt-4 text-center">
                <p className="text-body-sm text-fg-muted">Powered by Edge Cloud Storage</p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => navigate('/auth')}
                  className="mt-2"
                >
                  Sign in to your account
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default SharePage;
