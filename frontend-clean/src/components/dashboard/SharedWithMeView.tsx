import React, { useMemo, useState } from 'react';
import { Users, AlertCircle, Check, X, Mail, FileIcon, FolderIcon } from 'lucide-react';
import { useSharedWithMe } from '../../hooks/useSharedWithMe';
import FileGrid from './FileGrid';
import FileList from './FileList';
import type { SharedWithMeViewProps, FileItem, FolderItem } from './types';
import { getErrorMessage } from './types';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  Spinner,
} from '@/components/ui';

interface SharedItem {
  id: string;
  file_id?: string;
  folder_id?: string;
  item_type: 'file' | 'folder';
  item_name: string;
  shared_at: string;
  owner_email: string;
  permission: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * SharedWithMeView — files and folders shared with the current user, plus
 * pending invitations. Card shell with Banner primitives for invite rows and
 * error states, EmptyState for zero-shares. Delegates file rendering to
 * FileGrid / FileList.
 */
const SharedWithMeView: React.FC<SharedWithMeViewProps> = ({
  viewMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete: _onFileDelete,
  onVersionHistory,
  darkMode,
}) => {
  const {
    sharedFiles,
    pendingInvitations,
    loading,
    error,
    refresh,
    removeSharedAccess,
    acceptInvitation,
    declineInvitation,
  } = useSharedWithMe();
  const [processingTokens, setProcessingTokens] = useState<Set<string>>(new Set());

  const handleRemoveSharedFile = async (fileId: string): Promise<void> => {
    const file = (sharedFiles as unknown as SharedItem[]).find(
      (item) => item.file_id === fileId || item.folder_id === fileId
    );
    if (file) {
      try {
        await removeSharedAccess(file.id);
      } catch (err: unknown) {
        console.error('Failed to remove shared access:', getErrorMessage(err));
        alert('Failed to remove from Shared with me');
      }
    }
  };

  const handleAccept = async (token: string): Promise<void> => {
    setProcessingTokens((prev) => new Set(prev).add(token));
    try {
      await acceptInvitation(token);
    } catch (err: unknown) {
      console.error('Failed to accept invitation:', getErrorMessage(err));
    } finally {
      setProcessingTokens((prev) => {
        const next = new Set(prev);
        next.delete(token);
        return next;
      });
    }
  };

  const handleDecline = async (token: string): Promise<void> => {
    setProcessingTokens((prev) => new Set(prev).add(token));
    try {
      await declineInvitation(token);
    } catch (err: unknown) {
      console.error('Failed to decline invitation:', getErrorMessage(err));
    } finally {
      setProcessingTokens((prev) => {
        const next = new Set(prev);
        next.delete(token);
        return next;
      });
    }
  };

  const transformedFiles = useMemo<FileItem[]>(() => {
    return (sharedFiles as unknown as SharedItem[])
      .filter((item) => item.item_type === 'file' && item.file_id)
      .map((item) => ({
        id: item.file_id as string,
        name: item.item_name,
        size: item.file_size || 0,
        ...(item.mime_type ? { mime_type: item.mime_type } : {}),
        created_at: item.shared_at,
        last_accessed: item.shared_at,
        is_favorite: false,
      }));
  }, [sharedFiles]);

  const transformedFolders = useMemo<FolderItem[]>(() => {
    return (sharedFiles as unknown as SharedItem[])
      .filter((item) => item.item_type === 'folder' && item.folder_id)
      .map((item) => ({
        id: item.folder_id as string,
        name: item.item_name,
        created_at: item.shared_at,
      }));
  }, [sharedFiles]);

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
        title="Failed to load shared files"
        action={
          <Button variant="primary" size="sm" onClick={refresh}>
            Try again
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  const hasContent =
    transformedFiles.length > 0 ||
    transformedFolders.length > 0 ||
    pendingInvitations.length > 0;

  if (!hasContent) {
    return (
      <Card variant="bordered">
        <CardContent className="p-6">
          <EmptyState
            icon={<Users />}
            title="No shared files yet"
            description="Files that others share with you will appear here. When someone shares a file or folder with you, you'll be able to access it from this section."
            size="lg"
          />
        </CardContent>
      </Card>
    );
  }

  const totalItems = transformedFiles.length + transformedFolders.length;

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-h2 font-bold text-fg">Shared with me</h1>
              <p className="mt-1 text-body-sm text-fg-muted">
                {totalItems} {totalItems === 1 ? 'item' : 'items'} shared by others
              </p>
            </div>
          </div>
          {totalItems > 0 && (
            <Badge variant="neutral" size="sm">
              {totalItems} {totalItems === 1 ? 'item' : 'items'}
            </Badge>
          )}
        </div>

        {/* Pending Invitations */}
        {pendingInvitations.length > 0 && (
          <div className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Mail className="h-5 w-5 text-warning" />
              <h3 className="text-body-sm font-semibold text-fg">
                Pending invitations ({pendingInvitations.length})
              </h3>
            </div>
            <div className="space-y-2">
              {pendingInvitations.map((inv) => {
                const isProcessing = processingTokens.has(inv.invitation_token);
                return (
                  <div
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-center gap-3">
                      {inv.item_type === 'folder' ? (
                        <FolderIcon className="h-5 w-5 text-primary" />
                      ) : (
                        <FileIcon className="h-5 w-5 text-fg-muted" />
                      )}
                      <div>
                        <p className="text-body-sm font-medium text-fg">{inv.item_name}</p>
                        <p className="text-caption text-fg-muted">
                          From {inv.owner_email} &middot; {inv.permission} access
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        leftIcon={<Check className="h-3.5 w-3.5" />}
                        loading={isProcessing}
                        disabled={isProcessing}
                        onClick={() => void handleAccept(inv.invitation_token)}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<X className="h-3.5 w-3.5" />}
                        disabled={isProcessing}
                        onClick={() => void handleDecline(inv.invitation_token)}
                      >
                        Decline
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Files */}
        {totalItems > 0 &&
          (viewMode === 'grid' ? (
            <FileGrid
              folders={transformedFolders}
              files={transformedFiles}
              selectedFiles={selectedFiles}
              onFolderClick={() => {}}
              onFileClick={onFileClick}
              onFilePreview={onFilePreview}
              onFileDownload={onFileDownload}
              onFileShare={onFileShare}
              onFileDelete={handleRemoveSharedFile}
              onVersionHistory={onVersionHistory}
              onToggleFavorite={undefined}
              onRename={undefined}
              darkMode={darkMode}
            />
          ) : (
            <FileList
              folders={transformedFolders}
              files={transformedFiles}
              selectedFiles={selectedFiles}
              onFolderClick={() => {}}
              onFileClick={onFileClick}
              onFilePreview={onFilePreview}
              onFileDownload={onFileDownload}
              onFileShare={onFileShare}
              onFileDelete={handleRemoveSharedFile}
              onVersionHistory={onVersionHistory}
              onToggleFavorite={undefined}
              onRename={undefined}
              darkMode={darkMode}
            />
          ))}
      </CardContent>
    </Card>
  );
};

export default SharedWithMeView;
