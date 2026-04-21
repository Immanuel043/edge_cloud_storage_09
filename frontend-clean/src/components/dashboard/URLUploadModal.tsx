import React, { useState, useRef, useEffect } from 'react';
import { Link as LinkIcon, Download, AlertCircle, CheckCircle } from 'lucide-react';
import { API_URL } from '../../config/constants';
import type { URLUploadModalProps, URLUploadProgress } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  FormField,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';

/**
 * URLUploadModal — prompts for a URL, validates it client-side against SSRF
 * targets (localhost / private IP ranges / .local), and kicks off a
 * server-side URL-to-storage upload. Success auto-closes after a short delay.
 */
const URLUploadModal: React.FC<URLUploadModalProps> = ({
  isOpen,
  onClose,
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
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error('Invalid URL format');
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Only HTTP and HTTPS URLs are supported');
      }

      const hostname = parsedUrl.hostname.toLowerCase();
      const blockedHosts = [
        'localhost',
        '127.0.0.1',
        '0.0.0.0',
        '[::1]',
        'metadata.google.internal',
        '169.254.169.254',
      ];
      if (
        blockedHosts.includes(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal')
      ) {
        throw new Error('URLs pointing to internal or local addresses are not allowed');
      }

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
        headers: { 'Content-Type': 'application/json' },
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
    <Modal open={isOpen} onClose={handleClose} size="md">
      <ModalHeader>
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5 text-primary" />
          <span>Upload from URL</span>
        </div>
      </ModalHeader>
      <form onSubmit={handleSubmit}>
        <ModalBody>
          <div className="space-y-4">
            <FormField label="File URL" hint="Enter a direct link to a file (images, documents, videos, etc.)">
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/file.pdf"
                required
                disabled={loading || success}
                leftAddon={<LinkIcon className="h-4 w-4" />}
              />
            </FormField>

            {error && (
              <Banner variant="danger" icon={<AlertCircle />}>
                {error}
              </Banner>
            )}

            {success && progress && (
              <Banner variant="success" icon={<CheckCircle />} title="Upload started successfully">
                {progress.file_name && (
                  <span>
                    {progress.file_name} (
                    {progress.file_size
                      ? `${(progress.file_size / 1024 / 1024).toFixed(2)} MB`
                      : 'Unknown size'}
                    )
                  </span>
                )}
              </Banner>
            )}

            <Banner variant="info">
              <p className="text-body-sm">
                <strong>Supported sources:</strong> Direct download links from any publicly
                accessible URL
              </p>
              <p className="mt-1 text-caption">
                <strong>Note:</strong> The file will be downloaded to the server and stored in
                your account
              </p>
            </Banner>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={handleClose} disabled={loading} type="button">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={loading || success || !url}
            loading={loading}
            leftIcon={!loading && !success ? <Download className="h-4 w-4" /> : undefined}
          >
            {loading ? 'Uploading...' : success ? 'Success!' : 'Upload'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
};

export default URLUploadModal;
