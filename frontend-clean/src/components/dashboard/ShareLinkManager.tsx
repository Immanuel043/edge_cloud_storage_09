import React, { useState, useEffect, useCallback } from 'react';
import {
  Link2,
  AlertCircle,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  Eye,
  Download,
  Edit,
  Lock,
  Clock,
  FolderIcon,
  Settings,
  XCircle,
  CheckCircle,
  Bell,
  Shield,
} from 'lucide-react';
import { storageService } from '../../services/storageService';
import { getFileIcon } from '../../utils/helpers';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Select,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/cn';

interface ShareLinkItem {
  id: string;
  share_token: string;
  share_type: string;
  item_name: string;
  item_type: string;
  file_id?: string;
  folder_id?: string;
  password_protected: boolean;
  expires_at?: string;
  max_downloads?: number;
  download_count: number;
  view_count: number;
  is_active: boolean;
  allow_preview: boolean;
  notify_on_access: boolean;
  allowed_ips?: string[];
  watermark_text?: string;
  created_at: string;
  last_accessed?: string;
}

interface ShareLinksResponse {
  items: ShareLinkItem[];
  total: number;
  limit: number;
  offset: number;
}

interface ShareLinkManagerProps {
  darkMode?: boolean;
}

/**
 * ShareLinkManager — manage user's outgoing share links. Lists each link
 * with permission, IP/password/expiry state, view/download counts, and
 * action icons: copy URL, regenerate token, revoke, or expand for edit
 * panel (permission / max downloads / preview / notify / IP whitelist /
 * watermark). Empty + error states via Signal primitives.
 */
const ShareLinkManager: React.FC<ShareLinkManagerProps> = () => {
  const [links, setLinks] = useState<ShareLinkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState<
    { id: string; text: string; type: 'success' | 'error' } | null
  >(null);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = (await storageService.getShareLinks(activeOnly)) as ShareLinksResponse;
      setLinks(response.items || []);
      setTotal(response.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load share links');
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    void fetchLinks();
  }, [fetchLinks]);

  const showAction = (id: string, text: string, type: 'success' | 'error') => {
    setActionMessage({ id, text, type });
    setTimeout(() => setActionMessage(null), 3000);
  };

  const handleCopy = async (token: string, id: string) => {
    const url = `${window.location.origin}/share/${token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRevoke = async (id: string) => {
    try {
      await storageService.revokeShareLink(id);
      setLinks((prev) => prev.map((l) => (l.id === id ? { ...l, is_active: false } : l)));
      showAction(id, 'Link revoked', 'success');
    } catch (err) {
      showAction(id, err instanceof Error ? err.message : 'Failed to revoke', 'error');
    }
  };

  const handleRegenerate = async (id: string) => {
    try {
      const updated = (await storageService.regenerateShareLink(id)) as ShareLinkItem;
      setLinks((prev) => prev.map((l) => (l.id === id ? updated : l)));
      showAction(id, 'New token generated', 'success');
    } catch (err) {
      showAction(id, err instanceof Error ? err.message : 'Failed to regenerate', 'error');
    }
  };

  const startEdit = (link: ShareLinkItem) => {
    setEditingId(link.id);
    setEditForm({
      share_type: link.share_type,
      allow_preview: link.allow_preview,
      max_downloads: link.max_downloads ?? -1,
      notify_on_access: link.notify_on_access,
      allowed_ips: (link.allowed_ips || []).join(', '),
      watermark_text: link.watermark_text || '',
    });
  };

  const handleSaveEdit = async (id: string) => {
    setSaving(true);
    try {
      const payload = { ...editForm };
      const ipStr = (payload.allowed_ips as string) || '';
      payload.allowed_ips = ipStr.trim()
        ? ipStr
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [];
      const updated = (await storageService.updateShareLink(id, payload)) as ShareLinkItem;
      setLinks((prev) => prev.map((l) => (l.id === id ? updated : l)));
      setEditingId(null);
      showAction(id, 'Updated', 'success');
    } catch (err) {
      showAction(id, err instanceof Error ? err.message : 'Failed to update', 'error');
    } finally {
      setSaving(false);
    }
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case 'download':
        return <Download className="h-3.5 w-3.5" />;
      case 'edit':
        return <Edit className="h-3.5 w-3.5" />;
      default:
        return <Eye className="h-3.5 w-3.5" />;
    }
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <Banner
        variant="danger"
        icon={<AlertCircle />}
        title="Failed to load share links"
        action={
          <Button variant="primary" size="sm" onClick={() => void fetchLinks()}>
            Try again
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Link2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-h2 font-bold text-fg">My share links</h2>
              <p className="text-body-sm text-fg-muted">
                {total} {total === 1 ? 'link' : 'links'} total
              </p>
            </div>
          </div>
          <Checkbox
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            label="Active only"
          />
        </div>

        {links.length === 0 ? (
          <EmptyState
            icon={<Link2 />}
            title="No share links yet"
            description="When you share files or folders via link, they'll appear here for management."
            size="lg"
          />
        ) : (
          <div className="space-y-3">
            {links.map((link) => {
              const isExpired = link.expires_at && new Date(link.expires_at) < new Date();
              const isEditing = editingId === link.id;
              const msg = actionMessage?.id === link.id ? actionMessage : null;
              const disabled = !link.is_active || isExpired;

              return (
                <div
                  key={link.id}
                  className={cn(
                    'rounded-lg border border-border bg-surface p-4 transition-colors',
                    disabled && 'opacity-60'
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      {link.item_type === 'folder' ? (
                        <FolderIcon className="mt-0.5 h-5 w-5 text-primary" />
                      ) : (
                        <span className="mt-0.5">{getFileIcon(link.item_name, 20)}</span>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-body-sm font-medium text-fg">
                          {link.item_name}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-fg-muted">
                          <span className="flex items-center gap-1">
                            {typeIcon(link.share_type)} {link.share_type}
                          </span>
                          {link.password_protected && (
                            <span className="flex items-center gap-1">
                              <Lock className="h-3 w-3" /> password
                            </span>
                          )}
                          {link.notify_on_access && (
                            <span className="flex items-center gap-1">
                              <Bell className="h-3 w-3" /> notify
                            </span>
                          )}
                          {link.allowed_ips && link.allowed_ips.length > 0 && (
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3" /> IP restricted
                            </span>
                          )}
                          {link.expires_at && (
                            <span
                              className={cn(
                                'flex items-center gap-1',
                                isExpired && 'text-danger'
                              )}
                            >
                              <Clock className="h-3 w-3" />{' '}
                              {isExpired
                                ? 'expired'
                                : `expires ${formatDate(link.expires_at)}`}
                            </span>
                          )}
                          {!link.is_active && (
                            <Badge variant="danger" size="sm">
                              revoked
                            </Badge>
                          )}
                          <span>{link.view_count} views</span>
                          <span>
                            {link.download_count}
                            {link.max_downloads != null ? `/${link.max_downloads}` : ''}{' '}
                            downloads
                          </span>
                          <span>created {formatDate(link.created_at)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Copy link"
                        onClick={() => void handleCopy(link.share_token, link.id)}
                      >
                        {copiedId === link.id ? (
                          <Check className="h-4 w-4 text-success" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Edit settings"
                        onClick={() => (isEditing ? setEditingId(null) : startEdit(link))}
                      >
                        <Settings
                          className={cn('h-4 w-4', isEditing && 'text-primary')}
                        />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Generate new URL"
                        onClick={() => void handleRegenerate(link.id)}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </IconButton>
                      {link.is_active && (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label="Revoke link"
                          onClick={() => void handleRevoke(link.id)}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </IconButton>
                      )}
                    </div>
                  </div>

                  {msg && (
                    <div
                      className={cn(
                        'mt-2 flex items-center gap-1.5 text-caption',
                        msg.type === 'success' ? 'text-success' : 'text-danger'
                      )}
                    >
                      {msg.type === 'success' ? (
                        <CheckCircle className="h-3.5 w-3.5" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      {msg.text}
                    </div>
                  )}

                  {isEditing && (
                    <div className="mt-3 space-y-3 border-t border-border pt-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <FormField label="Permission">
                          <Select
                            value={editForm.share_type as string}
                            onChange={(e) =>
                              setEditForm({ ...editForm, share_type: e.target.value })
                            }
                          >
                            <option value="view">View only</option>
                            <option value="download">Download</option>
                            <option value="edit">Edit</option>
                          </Select>
                        </FormField>
                        <FormField label="Max downloads">
                          <Input
                            type="number"
                            value={editForm.max_downloads as number}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                max_downloads: parseInt(e.target.value) || -1,
                              })
                            }
                            placeholder="-1 for unlimited"
                          />
                        </FormField>
                        <div className="flex items-end">
                          <Checkbox
                            checked={editForm.allow_preview as boolean}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                allow_preview: e.target.checked,
                              })
                            }
                            label="Allow preview"
                          />
                        </div>
                        <div className="flex items-end">
                          <Checkbox
                            checked={editForm.notify_on_access as boolean}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                notify_on_access: e.target.checked,
                              })
                            }
                            label="Notify on access"
                          />
                        </div>
                      </div>
                      <FormField label="IP whitelist (comma-separated, empty = unrestricted)">
                        <Input
                          type="text"
                          value={editForm.allowed_ips as string}
                          onChange={(e) =>
                            setEditForm({ ...editForm, allowed_ips: e.target.value })
                          }
                          placeholder="e.g. 192.168.1.0/24, 10.0.0.5"
                        />
                      </FormField>
                      <FormField label="Watermark text (overlaid on previews)">
                        <Input
                          type="text"
                          value={(editForm.watermark_text as string) || ''}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              watermark_text: e.target.value,
                            })
                          }
                          placeholder="e.g. Confidential"
                          maxLength={100}
                        />
                      </FormField>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void handleSaveEdit(link.id)}
                          disabled={saving}
                          loading={saving}
                        >
                          {saving ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ShareLinkManager;
