import React from 'react';
import { CheckCircle, AlertCircle, Clock, Lock, Shield, RefreshCw } from 'lucide-react';
import { formatDuration, formatBytes } from '../../utils/helpers';
import type { UploadProgressProps, UploadItem } from './types';
import { Badge, Button, Card, CardContent } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * UploadProgress — stacked upload-progress rows shown above the file grid
 * during active uploads. Each row reports chunk progress, elapsed time, ZK
 * encryption state, and cancel/retry affordances.
 */
const UploadProgress: React.FC<UploadProgressProps> = ({ uploads, onCancel, onRetry }) => {
  return (
    <Card variant="bordered" className="mb-6">
      <CardContent className="p-4">
        <h3 className="mb-3 text-h3 font-semibold text-fg">Uploads</h3>
        {Object.entries(uploads).map(([id, upload]: [string, UploadItem]) => (
          <div key={id} className="mb-3 last:mb-0">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-body-sm text-fg">{upload.name}</span>
                {upload.zkEnabled && (
                  <Badge variant="success" size="sm" className="flex items-center gap-1">
                    <Lock className="h-3 w-3" />
                    <span className="hidden sm:inline">Encrypting</span>
                  </Badge>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {upload.elapsedTime !== undefined && (
                  <div className="flex items-center gap-1 text-caption text-fg-muted">
                    <Clock className="h-3 w-3" />
                    {formatDuration(upload.elapsedTime)}
                  </div>
                )}
                <span className="text-caption text-fg-muted">
                  {upload.totalChunks != null && upload.totalChunks > 0
                    ? `${upload.chunksUploaded ?? 0}/${upload.totalChunks} chunks`
                    : `${formatBytes(upload.bytesUploaded)} / ${formatBytes(upload.totalBytes)}`}
                </span>
                {upload.status === 'uploading' && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => onCancel(id)}
                    className="text-danger hover:text-danger/80"
                  >
                    Cancel
                  </Button>
                )}
                {upload.status === 'complete' && (
                  <CheckCircle className="h-4 w-4 text-success" />
                )}
                {upload.status === 'error' && (
                  <AlertCircle className="h-4 w-4 text-danger" />
                )}
                {upload.status === 'error' && onRetry && upload.canRetry && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => onRetry(id)}
                    leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                  >
                    Retry
                  </Button>
                )}
              </div>
            </div>
            <div className="h-2 w-full rounded-full bg-surface-muted">
              <div
                className={cn(
                  'h-2 rounded-full transition-all duration-normal',
                  upload.status === 'error'
                    ? 'bg-danger'
                    : upload.zkEnabled
                      ? 'bg-gradient-to-r from-success to-accent'
                      : 'bg-gradient-to-r from-primary to-accent'
                )}
                style={{ width: `${upload.progress}%` }}
              />
            </div>
            {upload.error && (
              <p className="mt-1 text-caption text-danger">{upload.error}</p>
            )}
            {upload.zkEnabled && upload.status === 'uploading' && (
              <p className="mt-1 flex items-center gap-1 text-caption text-success">
                <Shield className="h-3 w-3" />
                Client-side encryption active
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
};

export default UploadProgress;
