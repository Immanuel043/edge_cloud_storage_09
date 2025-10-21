import React from 'react';
import { Star, Loader, AlertCircle } from 'lucide-react';
import FileGrid from './FileGrid';
import FileList from './FileList';
import { useFavorites } from '../../hooks/useFavorites';

export default function FavoritesView({
  viewMode,
  darkMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
}) {
  const { favorites, loading, error, refresh, toggleFavorite } = useFavorites(true);

  const handleUnfavorite = async (fileId) => {
    try {
      await toggleFavorite(fileId);
    } catch (err) {
      console.error('Failed to unfavorite:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="animate-spin text-blue-500" size={48} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={`p-6 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center gap-3 text-red-500">
          <AlertCircle size={24} />
          <div>
            <h3 className="font-semibold">Failed to load favorites</h3>
            <p className="text-sm mt-1">{error}</p>
            <button
              onClick={refresh}
              className="mt-3 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (favorites.length === 0) {
    return (
      <div className={`p-12 rounded-lg text-center ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <Star className={`mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={64} />
        <h3 className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          No favorite files yet
        </h3>
        <p className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
          Star your important files to access them quickly from here
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Star size={24} className="text-yellow-500 fill-yellow-500" />
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Favorite Files
          </h1>
        </div>
        <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {favorites.length} {favorites.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      {viewMode === 'grid' ? (
        <FileGrid
          folders={[]}
          files={favorites}
          selectedFiles={selectedFiles}
          onFolderClick={() => {}}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          onFileDownload={onFileDownload}
          onFileShare={onFileShare}
          onFileDelete={onFileDelete}
          onVersionHistory={onVersionHistory}
          darkMode={darkMode}
          showFavoriteButton
          onUnfavorite={handleUnfavorite}
        />
      ) : (
        <FileList
          folders={[]}
          files={favorites}
          selectedFiles={selectedFiles}
          onFolderClick={() => {}}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          onFileDownload={onFileDownload}
          onFileShare={onFileShare}
          onFileDelete={onFileDelete}
          onVersionHistory={onVersionHistory}
          darkMode={darkMode}
          showFavoriteButton
          onUnfavorite={handleUnfavorite}
        />
      )}
    </div>
  );
}
