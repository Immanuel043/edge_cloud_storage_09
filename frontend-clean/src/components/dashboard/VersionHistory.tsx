import React, { useState, useEffect } from 'react';
import {
  Download,
  RotateCcw,
  Clock,
  User,
  FileText,
  Trash2,
  MessageSquare,
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes, formatDate } from '../../utils/helpers';
import type { VersionHistoryProps, FileVersion } from './types';
import { getErrorMessage } from './types';
import {
  Badge,
  Banner,
  EmptyState,
  IconButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/cn';

interface VersionsResponse {
  versions?: FileVersion[];
}

/**
 * VersionHistory — modal listing prior versions of a file. Supports
 * restore (creates a new version from an older one), per-version download,
 * and destructive delete (non-current only).
 */
const VersionHistory: React.FC<VersionHistoryProps> = ({ file, onClose, onRestore }) => {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    void loadVersions();
  }, [file.id]);

  const loadVersions = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/v1/files/${file.id}/versions`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to load versions');
      const data = (await response.json()) as VersionsResponse;
      const mapped = (data.versions || []).map((v) => ({
        ...v,
        version: v.version_number ?? v.version,
        size: v.file_size ?? v.size,
      }));
      setVersions(mapped);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (versionNumber: number): Promise<void> => {
    if (
      !window.confirm(`Restore to version ${versionNumber}? Your current version will be saved.`)
    ) {
      return;
    }
    setRestoring(versionNumber);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/v1/files/${file.id}/versions/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ version_number: versionNumber }),
      });
      if (!response.ok) throw new Error('Failed to restore version');
      await loadVersions();
      if (onRestore) await onRestore(String(versionNumber));
      setError('');
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setRestoring(null);
    }
  };

  const handleDownload = async (versionNumber: number): Promise<void> => {
    try {
      const response = await fetch(
        `${API_URL}/api/v1/files/${file.id}/versions/${versionNumber}/download`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error('Download failed');
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `${file.name}_v${versionNumber}`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?(.+)"?/i);
        if (match && match[1]) filename = match[1];
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  };

  const handleDelete = async (versionNumber: number): Promise<void> => {
    if (!window.confirm(`Delete version ${versionNumber}? This cannot be undone.`)) return;
    try {
      const response = await fetch(
        `${API_URL}/api/v1/files/${file.id}/versions/${versionNumber}`,
        { method: 'DELETE', credentials: 'include' }
      );
      if (!response.ok) throw new Error('Failed to delete version');
      await loadVersions();
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Clock className="h-5 w-5" />
          </div>
          <div>
            <p className="text-h3 font-semibold text-fg">Version history</p>
            <p className="text-body-sm text-fg-muted">{file.name}</p>
          </div>
        </div>
      </ModalHeader>
      <ModalBody>
        {error && (
          <div className="mb-4">
            <Banner variant="danger" onDismiss={() => setError('')}>
              {error}
            </Banner>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Spinner size="lg" />
            <p className="mt-3 text-body-sm text-fg-muted">Loading version history...</p>
          </div>
        ) : versions.length === 0 ? (
          <EmptyState
            icon={<Clock />}
            title="No version history"
            description="Versions are created automatically when you replace a file."
          />
        ) : (
          <div className="space-y-3">
            {versions.map((version) => {
              const isCurrent = version.version === versions[0]?.version;
              return (
                <div
                  key={version.id}
                  className={cn(
                    'rounded-lg border-2 p-4 transition-all',
                    isCurrent
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface hover:border-border-strong'
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span
                          className={cn(
                            'font-semibold',
                            isCurrent ? 'text-primary' : 'text-fg'
                          )}
                        >
                          Version {version.version}
                        </span>
                        {isCurrent && (
                          <Badge variant="info" size="sm">
                            Current
                          </Badge>
                        )}
                      </div>

                      <div className="space-y-1 text-body-sm text-fg-muted">
                        {version.created_by && (
                          <div className="flex items-center gap-2">
                            <User className="h-3.5 w-3.5" />
                            <span>{version.created_by}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Clock className="h-3.5 w-3.5" />
                          <span>{formatDate(version.created_at)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FileText className="h-3.5 w-3.5" />
                          <span>{formatBytes(version.size)}</span>
                        </div>
                        {version.change_description && (
                          <div className="mt-2 flex items-start gap-2">
                            <MessageSquare className="mt-0.5 h-3.5 w-3.5" />
                            <span className="italic">{version.change_description}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-1">
                      {!isCurrent && (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label="Restore this version"
                          onClick={() => void handleRestore(version.version)}
                          disabled={restoring === version.version}
                        >
                          {restoring === version.version ? (
                            <Spinner size="sm" />
                          ) : (
                            <RotateCcw className="h-4 w-4 text-primary" />
                          )}
                        </IconButton>
                      )}

                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Download this version"
                        onClick={() => void handleDownload(version.version)}
                      >
                        <Download className="h-4 w-4 text-success" />
                      </IconButton>

                      {!isCurrent && (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label="Delete this version"
                          onClick={() => void handleDelete(version.version)}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </IconButton>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <p className="flex-1 text-caption text-fg-muted">
          Versions are created automatically when you replace a file. Restore any version to bring
          back previous changes.
        </p>
      </ModalFooter>
    </Modal>
  );
};

export default VersionHistory;
