import React, { useState, useEffect } from 'react';
import {
  Upload,
  Edit,
  Download,
  Share2,
  Eye,
  Clock,
  CheckCircle,
  AlertCircle,
  Edit2,
  Trash2,
} from 'lucide-react';
import { formatDate } from '../../utils/helpers';
import { storageService } from '../../services/storageService';
import type { FileActivityTabProps, FileActivity, FileActivityAction } from './types';
import { getErrorMessage } from './types';
import type { LucideIcon } from 'lucide-react';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * Mask an IP address for privacy by hiding the last segments.
 * IPv4: 192.168.1.5 -> 192.168.*.*
 * IPv6 or other formats: mask last segment
 */
function maskIpAddress(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  return ip.replace(/:[^:]+$/, ':****');
}

type ActionTone = 'primary' | 'warning' | 'success' | 'accent' | 'danger' | 'neutral';

const TONE_TEXT: Record<ActionTone, string> = {
  primary: 'text-primary',
  warning: 'text-warning',
  success: 'text-success',
  accent: 'text-accent',
  danger: 'text-danger',
  neutral: 'text-fg-subtle',
};

const TONE_BG: Record<ActionTone, string> = {
  primary: 'bg-primary/10',
  warning: 'bg-warning/10',
  success: 'bg-success/10',
  accent: 'bg-accent/10',
  danger: 'bg-danger/10',
  neutral: 'bg-surface-muted',
};

/**
 * FileActivityTab — audit timeline of actions taken on a file (upload,
 * view, share, etc.), pulled from the activity service. Each entry shows
 * the action, timestamp, and a masked IP when available.
 */
const FileActivityTab: React.FC<FileActivityTabProps> = ({ file }) => {
  const [activities, setActivities] = useState<FileActivity[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActivity();
  }, [file.id]);

  const fetchActivity = async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);
      const data = await storageService.getFileActivity(file.id);
      setActivities(data as FileActivity[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to fetch activity:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const getActionIcon = (action: FileActivityAction): LucideIcon => {
    const iconMap: Record<FileActivityAction, LucideIcon> = {
      file_uploaded: Upload,
      file_modified: Edit,
      file_downloaded: Download,
      file_shared: Share2,
      file_viewed: Eye,
      file_renamed: Edit2,
      file_deleted: Trash2,
      upload: Upload,
      download: Download,
    };
    return iconMap[action] || Upload;
  };

  const getActionTone = (action: FileActivityAction): ActionTone => {
    const toneMap: Record<string, ActionTone> = {
      file_uploaded: 'primary',
      file_modified: 'warning',
      file_downloaded: 'success',
      file_shared: 'accent',
      file_viewed: 'primary',
      file_renamed: 'warning',
      file_deleted: 'danger',
      upload: 'primary',
      download: 'success',
    };
    return toneMap[action] || 'neutral';
  };

  const getActionText = (activity: FileActivity): string => {
    const action = activity.action;
    const metadata = activity.metadata || {};

    switch (action) {
      case 'file_uploaded':
      case 'upload':
        return 'Uploaded this file';
      case 'file_modified':
        return 'Modified this file';
      case 'file_downloaded':
      case 'download':
        return 'Downloaded this file';
      case 'file_shared':
        return 'Shared this file';
      case 'file_viewed':
        return 'Viewed this file';
      case 'file_renamed':
        return `Renamed from "${metadata.old_name || 'unknown'}" to "${metadata.new_name || 'unknown'}"`;
      case 'file_deleted':
        return 'Deleted this file';
      default:
        return String(action).replace(/_/g, ' ');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Spinner size="lg" />
        <p className="mt-3 text-body-sm text-fg-muted">Loading activity...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="mb-4 h-12 w-12 text-danger" />
        <p className="mb-2 text-body-sm font-medium text-fg">Failed to load activity</p>
        <p className="mb-4 text-caption text-fg-muted">{error}</p>
        <Button variant="primary" size="sm" onClick={fetchActivity}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        {activities.length > 0 ? (
          activities.map((activity, index) => {
            const Icon = getActionIcon(activity.action);
            const tone = getActionTone(activity.action);

            return (
              <div key={activity.id} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={cn('rounded-lg p-2', TONE_BG[tone])}>
                    <Icon size={16} className={TONE_TEXT[tone]} />
                  </div>
                  {index < activities.length - 1 && (
                    <div
                      className="my-1 w-0.5 flex-1 bg-border"
                      style={{ minHeight: '20px' }}
                    />
                  )}
                </div>

                <div className="flex-1 pb-4">
                  <p className="mb-1 text-body-sm font-medium text-fg">
                    {getActionText(activity)}
                  </p>
                  <div className="flex items-center gap-2 text-caption text-fg-muted">
                    <Clock size={12} />
                    <span>{formatDate(activity.created_at)}</span>
                    {activity.ip_address && (
                      <>
                        <span>•</span>
                        <span>{maskIpAddress(activity.ip_address)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <EmptyState
            icon={<Clock />}
            title="No activity recorded yet"
            description="Actions taken on this file will appear here."
            size="sm"
          />
        )}
      </div>

      {activities.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle size={16} className="text-success" />
            <h4 className="text-body-sm font-semibold text-fg">Activity summary</h4>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="mb-1 text-caption text-fg-muted">Total activities</p>
              <p className="text-h3 font-semibold text-fg">{activities.length}</p>
            </div>
            <div>
              <p className="mb-1 text-caption text-fg-muted">Last activity</p>
              <p className="text-caption font-medium text-fg">
                {formatDate(activities[0]?.created_at)}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FileActivityTab;
