import React, { useState, useEffect, useCallback } from 'react';
import {
  Link2, Loader, AlertCircle, Copy, Check, RefreshCw, Trash2,
  Eye, Download, Edit, Lock, Clock, FileIcon, FolderIcon, Settings,
  XCircle, CheckCircle, Bell, Shield,
} from 'lucide-react';
import { storageService } from '../../services/storageService';

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
  darkMode: boolean;
}

const ShareLinkManager: React.FC<ShareLinkManagerProps> = ({ darkMode }) => {
  const [links, setLinks] = useState<ShareLinkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ id: string; text: string; type: 'success' | 'error' } | null>(null);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await storageService.getShareLinks(activeOnly) as ShareLinksResponse;
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
      setLinks((prev) => prev.map((l) => l.id === id ? { ...l, is_active: false } : l));
      showAction(id, 'Link revoked', 'success');
    } catch (err) {
      showAction(id, err instanceof Error ? err.message : 'Failed to revoke', 'error');
    }
  };

  const handleRegenerate = async (id: string) => {
    try {
      const updated = await storageService.regenerateShareLink(id) as ShareLinkItem;
      setLinks((prev) => prev.map((l) => l.id === id ? updated : l));
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
      // Parse comma-separated IP string to array
      const ipStr = (payload.allowed_ips as string) || '';
      payload.allowed_ips = ipStr.trim()
        ? ipStr.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      const updated = await storageService.updateShareLink(id, payload) as ShareLinkItem;
      setLinks((prev) => prev.map((l) => l.id === id ? updated : l));
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
      case 'download': return <Download size={14} />;
      case 'edit': return <Edit size={14} />;
      default: return <Eye size={14} />;
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader className={`animate-spin mb-4 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={48} />
        <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Loading share links...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertCircle className="text-red-500 mb-4" size={48} />
        <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Failed to load share links</p>
        <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{error}</p>
        <button onClick={fetchLinks} className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${darkMode ? 'bg-purple-500/10' : 'bg-purple-50'}`}>
            <Link2 className={darkMode ? 'text-purple-400' : 'text-purple-500'} size={24} />
          </div>
          <div>
            <h2 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              My Share Links
            </h2>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {total} {total === 1 ? 'link' : 'links'} total
            </p>
          </div>
        </div>
        <label className={`flex items-center gap-2 text-sm cursor-pointer ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="rounded"
          />
          Active only
        </label>
      </div>

      {links.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className={`p-6 rounded-2xl mb-4 ${darkMode ? 'bg-purple-500/10' : 'bg-purple-50'}`}>
            <Link2 className={darkMode ? 'text-purple-400' : 'text-purple-500'} size={48} />
          </div>
          <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            No share links yet
          </p>
          <p className={`text-sm text-center max-w-md ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            When you share files or folders via link, they'll appear here for management.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {links.map((link) => {
            const isExpired = link.expires_at && new Date(link.expires_at) < new Date();
            const isEditing = editingId === link.id;
            const msg = actionMessage?.id === link.id ? actionMessage : null;

            return (
              <div
                key={link.id}
                className={`rounded-lg border p-4 transition-colors ${
                  !link.is_active || isExpired
                    ? darkMode ? 'bg-gray-800/50 border-gray-700 opacity-60' : 'bg-gray-50 border-gray-200 opacity-60'
                    : darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left: Item info */}
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    {link.item_type === 'folder' ? (
                      <FolderIcon className={darkMode ? 'text-blue-400 mt-0.5' : 'text-blue-500 mt-0.5'} size={20} />
                    ) : (
                      <FileIcon className={darkMode ? 'text-gray-400 mt-0.5' : 'text-gray-500 mt-0.5'} size={20} />
                    )}
                    <div className="min-w-0">
                      <p className={`font-medium text-sm truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {link.item_name}
                      </p>
                      <div className={`flex flex-wrap items-center gap-2 mt-1 text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        <span className="flex items-center gap-1">{typeIcon(link.share_type)} {link.share_type}</span>
                        {link.password_protected && <span className="flex items-center gap-1"><Lock size={12} /> password</span>}
                        {link.notify_on_access && <span className="flex items-center gap-1"><Bell size={12} /> notify</span>}
                        {link.allowed_ips && link.allowed_ips.length > 0 && <span className="flex items-center gap-1"><Shield size={12} /> IP restricted</span>}
                        {link.expires_at && (
                          <span className={`flex items-center gap-1 ${isExpired ? 'text-red-400' : ''}`}>
                            <Clock size={12} /> {isExpired ? 'expired' : `expires ${formatDate(link.expires_at)}`}
                          </span>
                        )}
                        {!link.is_active && <span className="text-red-400">revoked</span>}
                        <span>{link.view_count} views</span>
                        <span>{link.download_count}{link.max_downloads != null ? `/${link.max_downloads}` : ''} downloads</span>
                        <span>created {formatDate(link.created_at)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleCopy(link.share_token, link.id)}
                      className={`p-1.5 rounded transition-colors ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                      title="Copy link"
                    >
                      {copiedId === link.id ? <Check size={16} className="text-green-500" /> : <Copy size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />}
                    </button>
                    <button
                      onClick={() => isEditing ? setEditingId(null) : startEdit(link)}
                      className={`p-1.5 rounded transition-colors ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                      title="Edit settings"
                    >
                      <Settings size={16} className={isEditing ? 'text-blue-500' : darkMode ? 'text-gray-400' : 'text-gray-500'} />
                    </button>
                    <button
                      onClick={() => handleRegenerate(link.id)}
                      className={`p-1.5 rounded transition-colors ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                      title="Generate new URL (old link stops working)"
                    >
                      <RefreshCw size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
                    </button>
                    {link.is_active && (
                      <button
                        onClick={() => handleRevoke(link.id)}
                        className={`p-1.5 rounded transition-colors ${darkMode ? 'hover:bg-red-900/30' : 'hover:bg-red-50'}`}
                        title="Revoke link"
                      >
                        <Trash2 size={16} className="text-red-400" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Action feedback */}
                {msg && (
                  <div className={`mt-2 flex items-center gap-1.5 text-xs ${msg.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                    {msg.type === 'success' ? <CheckCircle size={14} /> : <XCircle size={14} />}
                    {msg.text}
                  </div>
                )}

                {/* Edit panel */}
                {isEditing && (
                  <div className={`mt-3 pt-3 border-t space-y-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      <div>
                        <label className={`block text-xs font-medium mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Permission</label>
                        <select
                          value={editForm.share_type as string}
                          onChange={(e) => setEditForm({ ...editForm, share_type: e.target.value })}
                          className={`w-full px-2 py-1.5 rounded text-sm border ${
                            darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                          }`}
                        >
                          <option value="view">View only</option>
                          <option value="download">Download</option>
                          <option value="edit">Edit</option>
                        </select>
                      </div>
                      <div>
                        <label className={`block text-xs font-medium mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Max downloads</label>
                        <input
                          type="number"
                          value={editForm.max_downloads as number}
                          onChange={(e) => setEditForm({ ...editForm, max_downloads: parseInt(e.target.value) || -1 })}
                          className={`w-full px-2 py-1.5 rounded text-sm border ${
                            darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                          }`}
                          placeholder="-1 for unlimited"
                        />
                      </div>
                      <div className="flex items-end">
                        <label className={`flex items-center gap-2 text-sm cursor-pointer ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                          <input
                            type="checkbox"
                            checked={editForm.allow_preview as boolean}
                            onChange={(e) => setEditForm({ ...editForm, allow_preview: e.target.checked })}
                            className="rounded"
                          />
                          Allow preview
                        </label>
                      </div>
                      <div className="flex items-end">
                        <label className={`flex items-center gap-2 text-sm cursor-pointer ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                          <input
                            type="checkbox"
                            checked={editForm.notify_on_access as boolean}
                            onChange={(e) => setEditForm({ ...editForm, notify_on_access: e.target.checked })}
                            className="rounded"
                          />
                          Notify on access
                        </label>
                      </div>
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>IP whitelist (comma-separated, empty = unrestricted)</label>
                      <input
                        type="text"
                        value={editForm.allowed_ips as string}
                        onChange={(e) => setEditForm({ ...editForm, allowed_ips: e.target.value })}
                        className={`w-full px-2 py-1.5 rounded text-sm border ${
                          darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                        }`}
                        placeholder="e.g. 192.168.1.0/24, 10.0.0.5"
                      />
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Watermark text (overlaid on previews)</label>
                      <input
                        type="text"
                        value={(editForm.watermark_text as string) || ''}
                        onChange={(e) => setEditForm({ ...editForm, watermark_text: e.target.value })}
                        className={`w-full px-2 py-1.5 rounded text-sm border ${
                          darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                        }`}
                        placeholder="e.g. Confidential"
                        maxLength={100}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className={`px-3 py-1.5 rounded text-sm ${
                          darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                        }`}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleSaveEdit(link.id)}
                        disabled={saving}
                        className="px-3 py-1.5 rounded text-sm bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50"
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ShareLinkManager;
