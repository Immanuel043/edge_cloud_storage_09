import React, { useState, useRef, useEffect } from 'react';
import {
  Lock, Clock, Download, Link as LinkIcon, Copy, Check, Eye, Edit,
  Users, ShieldCheck,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import type { ShareOptionsModalProps } from './types';
import { getErrorMessage } from './types';
import {
  Modal, ModalBody, ModalFooter, Button, IconButton, Input, Checkbox,
  Badge, Banner, Tabs, TabsList, TabsTrigger,
} from '@/components/ui';
import { cn } from '@/lib/cn';

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
  zk_files_hidden?: number;
  warning?: string;
}

/**
 * ShareOptionsModal — create a share link or invite collaborators.
 *
 * Rebuilt on the `Modal` / `Tabs` / `Checkbox` / `Input` / `Banner` / `Badge`
 * primitives; all business logic (share POST, collaborative invite, clipboard)
 * is preserved unchanged. ZK-encrypted files short-circuit to the "Sharing Not
 * Available" state using the same `Modal` so focus/scroll-lock behavior is
 * consistent with the main form.
 */
const ShareOptionsModal: React.FC<ShareOptionsModalProps> = ({
  file, folder, onClose, darkMode: _darkMode, onShareComplete,
}) => {
  void _darkMode; // retained in prop contract; Signal tokens handle theming

  // Check if file is ZK encrypted — block sharing
  const isZKEncrypted = file?.is_encrypted || file?.encryption_mode === 'client_zk';

  const [shareUrl, setShareUrl] = useState<string>('');
  const [shareWarning, setShareWarning] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

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
  const [watermarkText, setWatermarkText] = useState<string>('');

  // Collaborative sharing
  const [emails, setEmails] = useState<string>('');
  const [permission, setPermission] = useState<Permission>('view');

  const itemName = folder ? folder.name : file?.name || 'Unknown';

  // ZK encrypted short-circuit — still uses Modal primitive so focus/scroll
  // behavior matches the main share flow.
  if (isZKEncrypted) {
    return (
      <Modal open={true} onClose={onClose} size="md" hideCloseButton>
        <ModalBody className="text-center px-8 py-8">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-success/15">
            <ShieldCheck className="h-10 w-10 text-success" />
          </div>

          <h3 className="text-h3 text-fg mb-3">Sharing Not Available</h3>

          <p className="text-fg-muted mb-6">
            <span className="font-medium text-fg">&ldquo;{file?.name}&rdquo;</span> is protected
            with Zero-Knowledge encryption.
          </p>

          <div className="rounded-xl border border-border bg-surface-muted p-4 text-left mb-6">
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 h-[18px] w-[18px] shrink-0 text-success" />
              <div>
                <p className="text-body-sm font-medium text-fg mb-1">End-to-End Encrypted</p>
                <p className="text-body-sm text-fg-muted">
                  Only you can decrypt this file with your password. Sharing would require sharing
                  your encryption keys, which defeats the purpose of zero-knowledge security.
                </p>
              </div>
            </div>
          </div>

          <p className="text-body-sm text-fg-subtle mb-6">
            To share this file, download it first and send it through a secure channel.
          </p>

          <Button variant="secondary" fullWidth onClick={onClose}>
            I Understand
          </Button>
        </ModalBody>
      </Modal>
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
        watermark_text: watermarkText.trim() || null,
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

        if (errorData.detail && Array.isArray(errorData.detail)) {
          const errors = errorData.detail.map(e => `${e.loc.join('.')}: ${e.msg}`).join(', ');
          throw new Error(errors);
        }

        throw new Error(
          typeof errorData.detail === 'string' ? errorData.detail : 'Failed to create share link'
        );
      }

      const data = await response.json() as ShareResponse;
      setShareUrl(data.share_url);
      if (data.warning) setShareWarning(data.warning);

      if (onShareComplete) {
        onShareComplete({
          share_url: data.share_url,
          expires_at: expirationEnabled
            ? new Date(Date.now() + expirationHours * 3600000).toISOString()
            : undefined,
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
        throw new Error(
          typeof errorData.detail === 'string' ? errorData.detail : 'Failed to share'
        );
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
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
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
        copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
      } catch {
        alert('Copy failed. Please select and copy the link manually.');
      }
    }
  };

  const currentAccess: ShareType | Permission =
    sharingMode === 'people' ? permission : shareType;
  const setCurrentAccess = (next: ShareType | Permission): void => {
    if (sharingMode === 'people') setPermission(next as Permission);
    else setShareType(next as ShareType);
  };

  // Permission tile — radio-style picker for View / Download / Edit.
  const accessTile = (
    value: ShareType | Permission,
    icon: React.ReactNode,
    label: string,
  ) => {
    const active = currentAccess === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => setCurrentAccess(value)}
        className={cn(
          'flex flex-col items-center gap-1 rounded-lg border-2 px-3 py-2 transition-colors',
          'focus-visible:outline-none focus-visible:shadow-focus',
          active
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
        )}
      >
        <span className="[&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
        <span className="text-caption font-medium">{label}</span>
      </button>
    );
  };

  const accessHint = sharingMode === 'people'
    ? (
      permission === 'view' ? 'Can view files only' :
      permission === 'download' ? 'Can view and download files' :
      'Can view, download, upload, and delete files'
    )
    : (
      shareType === 'view' ? 'Can only view files' :
      shareType === 'download' ? 'Can view and download files' :
      'Can view, download, and upload files'
    );

  const canSubmit = !loading
    && !(sharingMode === 'link' && passwordEnabled && (!password || password.length < 8))
    && !(sharingMode === 'people' && !emails.trim());

  return (
    <Modal open={true} onClose={onClose} size="md" title={`Share "${itemName}"`}>
      <ModalBody className="space-y-4">
        {/* Sharing mode toggle — pill tabs */}
        {!shareUrl && (
          <Tabs
            value={sharingMode}
            onChange={(v) => setSharingMode(v as SharingMode)}
            variant="pill"
          >
            <TabsList className="w-full">
              <TabsTrigger value="link" className="flex-1 justify-center">
                <LinkIcon className="h-4 w-4" />
                Share Link
              </TabsTrigger>
              <TabsTrigger value="people" className="flex-1 justify-center">
                <Users className="h-4 w-4" />
                Share with People
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {shareUrl ? (
          // Share created — show URL + summary
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface-muted p-3">
              <p className="text-caption text-fg-subtle mb-1">Share URL:</p>
              <div className="flex items-center gap-2">
                <p className="text-body-sm text-fg break-all flex-1">{shareUrl}</p>
                <IconButton
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  aria-label={copied ? 'Copied' : 'Copy link'}
                  title={copied ? 'Copied!' : 'Copy link'}
                >
                  {copied ? <Check className="text-success" /> : <Copy />}
                </IconButton>
              </div>
            </div>

            {shareWarning && (
              <Banner variant="warning">{shareWarning}</Banner>
            )}

            <div className="space-y-1">
              <SummaryRow
                icon={<Clock className="h-4 w-4" />}
                label="Expires"
                value={expirationEnabled ? `${expirationHours}h` : 'Never'}
              />
              <SummaryRow
                icon={<Lock className="h-4 w-4" />}
                label="Password"
                value={passwordEnabled ? 'Protected' : 'None'}
              />
              <SummaryRow
                icon={<Download className="h-4 w-4" />}
                label="Download Limit"
                value={downloadLimitEnabled ? String(maxDownloads) : 'Unlimited'}
              />
            </div>
          </div>
        ) : (
          // Share creation form
          <div className="space-y-4">
            {error && <Banner variant="danger">{error}</Banner>}

            {/* Email input for collaborative sharing */}
            {sharingMode === 'people' && (
              <div>
                <label className="mb-2 flex items-center gap-2 text-body-sm font-medium text-fg">
                  <Users className="h-4 w-4" />
                  Share with (comma-separated emails)
                </label>
                <Input
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="john@example.com, jane@example.com"
                />
              </div>
            )}

            {/* Permission selector */}
            <div>
              <label className="mb-2 block text-body-sm font-medium text-fg">
                {sharingMode === 'people' ? 'Permission Level' : 'Access Type'}
              </label>
              <div role="radiogroup" className="grid grid-cols-3 gap-2">
                {accessTile('view', <Eye />, 'View')}
                {accessTile('download', <Download />, 'Download')}
                {accessTile('edit', <Edit />, 'Edit')}
              </div>
              <p className="mt-2 text-caption text-fg-subtle">{accessHint}</p>
            </div>

            {/* Link-specific options (only for share link mode) */}
            {sharingMode === 'link' && (
              <>
                {/* Expiration Option */}
                <div>
                  <label className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={expirationEnabled}
                      onChange={(e) => setExpirationEnabled(e.target.checked)}
                    />
                    <Clock className="h-4 w-4 text-fg-subtle" />
                    <span className="text-body-sm text-fg">Set expiration time</span>
                  </label>
                  {expirationEnabled && (
                    <div className="ml-6 mt-2">
                      <Input
                        type="number"
                        min={1}
                        max={8760}
                        value={expirationHours}
                        onChange={(e) => setExpirationHours(parseInt(e.target.value) || 24)}
                        placeholder="Hours until expiration"
                      />
                      <p className="mt-1 text-caption text-fg-subtle">
                        {expirationHours < 24
                          ? `${expirationHours} hours`
                          : `${Math.floor(expirationHours / 24)} days`}
                      </p>
                    </div>
                  )}
                </div>

                {/* Password Option */}
                <div>
                  <label className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={passwordEnabled}
                      onChange={(e) => setPasswordEnabled(e.target.checked)}
                    />
                    <Lock className="h-4 w-4 text-fg-subtle" />
                    <span className="text-body-sm text-fg">Require password</span>
                  </label>
                  {passwordEnabled && (
                    <div className="ml-6 mt-2">
                      <Input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        minLength={8}
                        placeholder="Enter password (min 8 characters)"
                        invalid={!!password && password.length < 8}
                      />
                      {password && password.length < 8 && (
                        <p className="mt-1 text-caption text-danger">
                          Password must be at least 8 characters long.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Download Limit Option */}
                <div>
                  <label className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={downloadLimitEnabled}
                      onChange={(e) => setDownloadLimitEnabled(e.target.checked)}
                    />
                    <Download className="h-4 w-4 text-fg-subtle" />
                    <span className="text-body-sm text-fg">Limit downloads</span>
                  </label>
                  {downloadLimitEnabled && (
                    <div className="ml-6 mt-2">
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        value={maxDownloads}
                        onChange={(e) => setMaxDownloads(parseInt(e.target.value) || 10)}
                        placeholder="Max downloads"
                      />
                    </div>
                  )}
                </div>

                {/* Watermark */}
                <div>
                  <label className="mb-1 block text-body-sm text-fg-muted">
                    Watermark text (overlaid on previews):
                  </label>
                  <Input
                    value={watermarkText}
                    onChange={(e) => setWatermarkText(e.target.value)}
                    placeholder="e.g. Confidential"
                    maxLength={100}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        {shareUrl ? (
          <Button variant="primary" fullWidth onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateShare}
              disabled={!canSubmit}
              loading={loading}
              leftIcon={
                sharingMode === 'people' ? <Users className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />
              }
            >
              {sharingMode === 'people' ? 'Share with People' : 'Create Link'}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};

/** Summary row used in the "share created" success view. */
const SummaryRow: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon, label, value,
}) => (
  <div className="flex items-center justify-between py-1.5">
    <span className="flex items-center gap-2 text-body-sm text-fg-muted">
      <span className="text-fg-subtle">{icon}</span>
      {label}
    </span>
    <Badge variant="neutral" size="md">
      {value}
    </Badge>
  </div>
);

export default ShareOptionsModal;
