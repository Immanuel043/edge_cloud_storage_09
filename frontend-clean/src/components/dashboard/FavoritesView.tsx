import React from 'react';
import { Star, AlertCircle } from 'lucide-react';
import FileGrid from './FileGrid';
import FileList from './FileList';
import { useFavorites } from '../../hooks/useFavorites';
import type { FavoritesViewProps } from './types';
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

/**
 * FavoritesView — starred files in grid or list view. Delegates to FileGrid /
 * FileList and wires up the un-star action so toggling a star removes the
 * file from this list immediately.
 */
const FavoritesView: React.FC<FavoritesViewProps> = ({
  viewMode,
  darkMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
}) => {
  const { favorites, loading, error, refresh, toggleFavorite } = useFavorites(true);

  const handleUnfavorite = async (fileId: string): Promise<void> => {
    try {
      await toggleFavorite(fileId);
    } catch (err: unknown) {
      console.error('Failed to unfavorite:', getErrorMessage(err));
    }
  };

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
        title="Failed to load favorites"
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

  if (favorites.length === 0) {
    return (
      <Card variant="bordered">
        <CardContent className="p-6">
          <EmptyState
            icon={<Star />}
            title="No favorite files yet"
            description="Star your important files to access them quickly from here."
            size="lg"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Star className="h-6 w-6 fill-warning text-warning" />
            <h1 className="text-h2 font-bold text-fg">Favorite files</h1>
          </div>
          <Badge variant="neutral" size="sm">
            {favorites.length} {favorites.length === 1 ? 'file' : 'files'}
          </Badge>
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
            onToggleFavorite={handleUnfavorite}
            darkMode={darkMode}
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
            onToggleFavorite={handleUnfavorite}
            darkMode={darkMode}
          />
        )}
      </CardContent>
    </Card>
  );
};

export default FavoritesView;
