import React from 'react';
import { Users, Loader, AlertCircle, Star } from 'lucide-react';
import { useSharedWithMe } from '../../hooks/useSharedWithMe';
import FileGrid from './FileGrid';
import FileList from './FileList';

export default function SharedWithMeView({
  viewMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
  onToggleFavorite,
  onRename,
  darkMode
}) {
  const { sharedFiles, loading, error, refresh } = useSharedWithMe();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader className={`animate-spin mb-4 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={48} />
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
        <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {error}
        </p>
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

  if (sharedFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className={`p-6 rounded-2xl mb-4 ${
          darkMode ? 'bg-blue-500/10' : 'bg-blue-50'
        }`}>
          <Users className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={48} />
        </div>
        <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          No shared files yet
        </p>
        <p className={`text-sm text-center max-w-md ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Files that others share with you will appear here. When someone shares a file or folder with you,
          you'll be able to access it from this section.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${
            darkMode ? 'bg-blue-500/10' : 'bg-blue-50'
          }`}>
            <Users className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={24} />
          </div>
          <div>
            <h2 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Shared with me
            </h2>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {sharedFiles.length} {sharedFiles.length === 1 ? 'file' : 'files'} shared by others
            </p>
          </div>
        </div>
      </div>

      {/* Files */}
      {viewMode === 'grid' ? (
        <FileGrid
          folders={[]}
          files={sharedFiles}
          selectedFiles={selectedFiles}
          onFolderClick={() => {}}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          onFileDownload={onFileDownload}
          onFileShare={onFileShare}
          onFileDelete={onFileDelete}
          onVersionHistory={onVersionHistory}
          onToggleFavorite={onToggleFavorite}
          onRename={onRename}
          darkMode={darkMode}
        />
      ) : (
        <FileList
          folders={[]}
          files={sharedFiles}
          selectedFiles={selectedFiles}
          onFolderClick={() => {}}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          onFileDownload={onFileDownload}
          onFileShare={onFileShare}
          onFileDelete={onFileDelete}
          onVersionHistory={onVersionHistory}
          onToggleFavorite={onToggleFavorite}
          onRename={onRename}
          darkMode={darkMode}
        />
      )}
    </div>
  );
}
