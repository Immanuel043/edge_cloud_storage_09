import React, { useMemo, useState } from 'react';
import { Users, Loader, AlertCircle, Check, X, Mail, FileIcon, FolderIcon } from 'lucide-react';
import { useSharedWithMe } from '../../hooks/useSharedWithMe';
import FileGrid from './FileGrid';
import FileList from './FileList';
import type { SharedWithMeViewProps, FileItem, FolderItem } from './types';
import { getErrorMessage } from './types';

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
 * SharedWithMeView Component
 *
 * Displays files and folders shared by other users.
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
    sharedFiles, pendingInvitations, loading, error, refresh,
    removeSharedAccess, acceptInvitation, declineInvitation,
  } = useSharedWithMe();
  const [processingTokens, setProcessingTokens] = useState<Set<string>>(new Set());

  // Custom delete handler for shared files - removes access, not the original file
  const handleRemoveSharedFile = async (fileId: string): Promise<void> => {
    const file = (sharedFiles as unknown as SharedItem[]).find(
      (item) => item.file_id === fileId || item.folder_id === fileId
    );
    if (file) {
      try {
        await removeSharedAccess(file.id);
      } catch (err: unknown) {
        console.error('Failed to remove shared access:', getErrorMessage(err));
        // TODO: Replace alert() with toast notification
        alert('Failed to remove from Shared with me');
      }
    }
  };

  const handleAccept = async (token: string) => {
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

  const handleDecline = async (token: string) => {
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

  // Transform shared items to file-like objects for FileGrid/FileList compatibility
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
      <div className="flex flex-col items-center justify-center py-20">
        <Loader
          className={`animate-spin mb-4 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`}
          size={48}
        />
        <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Loading shared files...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertCircle className="text-red-500 mb-4" size={48} />
        <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          Failed to load shared files
        </p>
        <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{error}</p>
        <button
          onClick={refresh}
          className={`px-4 py-2 rounded-lg transition-colors ${
            darkMode
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-blue-500 hover:bg-blue-600 text-white'
          }`}
        >
          Try Again
        </button>
      </div>
    );
  }

  if (transformedFiles.length === 0 && transformedFolders.length === 0 && pendingInvitations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className={`p-6 rounded-2xl mb-4 ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
          <Users className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={48} />
        </div>
        <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          No shared files yet
        </p>
        <p
          className={`text-sm text-center max-w-md ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}
        >
          Files that others share with you will appear here. When someone shares a file or folder
          with you, you'll be able to access it from this section.
        </p>
      </div>
    );
  }

  const totalItems = transformedFiles.length + transformedFolders.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
            <Users className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={24} />
          </div>
          <div>
            <h2 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Shared with me
            </h2>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {totalItems} {totalItems === 1 ? 'item' : 'items'} shared by others
            </p>
          </div>
        </div>
      </div>

      {/* Pending Invitations */}
      {pendingInvitations.length > 0 && (
        <div className={`rounded-lg border p-4 ${
          darkMode ? 'bg-yellow-900/20 border-yellow-700/50' : 'bg-yellow-50 border-yellow-200'
        }`}>
          <div className="flex items-center gap-2 mb-3">
            <Mail className={darkMode ? 'text-yellow-400' : 'text-yellow-600'} size={18} />
            <h3 className={`font-medium ${darkMode ? 'text-yellow-300' : 'text-yellow-800'}`}>
              Pending Invitations ({pendingInvitations.length})
            </h3>
          </div>
          <div className="space-y-2">
            {pendingInvitations.map((inv) => {
              const isProcessing = processingTokens.has(inv.invitation_token);
              return (
                <div key={inv.id} className={`flex items-center justify-between p-3 rounded-lg ${
                  darkMode ? 'bg-gray-800' : 'bg-white'
                }`}>
                  <div className="flex items-center gap-3">
                    {inv.item_type === 'folder' ? (
                      <FolderIcon className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={20} />
                    ) : (
                      <FileIcon className={darkMode ? 'text-gray-400' : 'text-gray-500'} size={20} />
                    )}
                    <div>
                      <p className={`font-medium text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {inv.item_name}
                      </p>
                      <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        From {inv.owner_email} &middot; {inv.permission} access
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleAccept(inv.invitation_token)}
                      disabled={isProcessing}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                        darkMode
                          ? 'bg-green-600 hover:bg-green-700 text-white disabled:opacity-50'
                          : 'bg-green-500 hover:bg-green-600 text-white disabled:opacity-50'
                      }`}
                    >
                      <Check size={14} /> Accept
                    </button>
                    <button
                      onClick={() => handleDecline(inv.invitation_token)}
                      disabled={isProcessing}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                        darkMode
                          ? 'bg-gray-600 hover:bg-gray-700 text-gray-200 disabled:opacity-50'
                          : 'bg-gray-200 hover:bg-gray-300 text-gray-700 disabled:opacity-50'
                      }`}
                    >
                      <X size={14} /> Decline
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Files */}
      {viewMode === 'grid' ? (
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
      )}
    </div>
  );
};

export default SharedWithMeView;
