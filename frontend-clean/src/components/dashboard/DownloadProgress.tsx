import React from 'react';
import { Download, Lock, Shield, CheckCircle, AlertCircle } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import type { DownloadProgressProps, DownloadItem } from './types';
import { Badge, Card, CardContent, IconButton } from '@/components/ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * DownloadProgress — per-file download cards rendered while downloads are in
 * flight. Shows chunk/byte progress; for ZK files, adds a secondary bar for
 * client-side decryption progress.
 */
const DownloadProgress: React.FC<DownloadProgressProps> = ({ downloads, onCancel }) => {
  if (!downloads || Object.keys(downloads).length === 0) return null;

  return (
    <Card variant="bordered" className="mb-6">
      <CardContent className="p-4">
        <h3 className="mb-3 text-h3 font-semibold text-fg">Downloads</h3>
        {Object.entries(downloads).map(([id, download]: [string, DownloadItem]) => (
          <div key={id} className="mb-4 last:mb-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Download className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate text-body-sm font-medium text-fg">
                  {download.fileName}
                </span>
                {download.isZK && (
                  <Badge variant="success" size="sm" className="flex items-center gap-1">
                    <Lock className="h-3 w-3" />
                    <span className="hidden sm:inline">ZK</span>
                  </Badge>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {download.status === 'downloading' && onCancel && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Cancel download"
                    onClick={() => onCancel(id)}
                  >
                    <X className="h-4 w-4 text-danger" />
                  </IconButton>
                )}
                {download.status === 'complete' && (
                  <CheckCircle className="h-4 w-4 text-success" />
                )}
                {download.status === 'error' && (
                  <AlertCircle className="h-4 w-4 text-danger" />
                )}
              </div>
            </div>

            <div className="mb-1 flex items-center justify-between">
              <span className="text-caption text-fg-muted">
                {download.isZK && download.status === 'decrypting'
                  ? 'Decrypting...'
                  : download.chunksDownloaded !== undefined &&
                      download.totalChunks !== undefined
                    ? `${download.chunksDownloaded}/${download.totalChunks} chunks`
                    : `${download.progress}%`}
              </span>
              {download.bytesDownloaded !== undefined && download.totalBytes !== undefined && (
                <span className="text-caption text-fg-muted">
                  {formatBytes(download.bytesDownloaded)} / {formatBytes(download.totalBytes)}
                </span>
              )}
            </div>

            <div className="h-2 w-full rounded-full bg-surface-muted">
              <div
                className={cn(
                  'h-2 rounded-full transition-all duration-normal',
                  download.status === 'error'
                    ? 'bg-danger'
                    : download.isZK
                      ? 'bg-gradient-to-r from-success to-accent'
                      : 'bg-gradient-to-r from-primary to-accent'
                )}
                style={{ width: `${download.progress}%` }}
              />
            </div>

            {download.isZK &&
              download.status === 'decrypting' &&
              download.decryptionProgress !== undefined && (
                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1 text-caption text-success">
                      <Shield className="h-2.5 w-2.5" />
                      Client-side decryption
                    </span>
                    <span className="text-caption text-success">
                      {download.decryptionProgress}%
                    </span>
                  </div>
                  <div className="h-1 w-full rounded-full bg-surface-muted">
                    <div
                      className="h-1 rounded-full bg-success transition-all duration-normal"
                      style={{ width: `${download.decryptionProgress}%` }}
                    />
                  </div>
                </div>
              )}

            {download.error && (
              <p className="mt-1 text-caption text-danger">{download.error}</p>
            )}

            {download.isZK && download.status === 'complete' && (
              <p className="mt-1 flex items-center gap-1 text-caption text-success">
                <Shield className="h-2.5 w-2.5" />
                Securely decrypted on your device
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
};

export default DownloadProgress;
