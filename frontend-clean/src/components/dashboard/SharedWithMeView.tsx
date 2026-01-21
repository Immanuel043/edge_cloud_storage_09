import React, { useMemo } from 'react';
import { Users, Loader, AlertCircle } from 'lucide-react';
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
  const { sharedFiles, loading, error, refresh, removeSharedAccess } = useSharedWithMe();

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
        alert('Failed to remove from Shared with me');
      }
    }
  };

  // Transform shared items to file-like objects for FileGrid/FileList compatibility
  const transformedFiles = useMemo<FileItem[]>(() => {
    return (sharedFiles as unknown as SharedItem[])
      .filter((item) => item.item_type === 'file' && item.file_id)
      .map((item) => ({
        id: item.file_id as string,
        name: item.item_name,
        size: 0,
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

  if (transformedFiles.length === 0 && transformedFolders.length === 0) {
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
