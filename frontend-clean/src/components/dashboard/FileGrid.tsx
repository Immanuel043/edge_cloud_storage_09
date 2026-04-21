import React from 'react';
import { Folder, Star, Lock, Lightbulb, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, EmptyState, IconButton } from '@/components/ui';
import { formatBytes, formatDate, sanitizeInput } from '../../utils/helpers';
import FileThumbnail from './FileThumbnail';
import { FileActionsMenu } from './shared/FileActionsMenu';
import type { FileGridProps, FileItem } from './types';

/**
 * FileGrid — card grid of folders + files. Each card is a Signal `Card`-ish
 * surface with a hover-revealed action menu; wired through to the shared
 * `FileActionsMenu` for consistency with the list view.
 */
const FileGrid: React.FC<FileGridProps> = ({
  folders,
  files,
  selectedFiles,
  onFolderClick,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
  onToggleFavorite,
  onRename,
  onFileInfo,
  onFileCopy,
  trashedView = false,
  onRestore,
  nameSuggestions,
  onAcceptNameSuggestion,
  onDismissNameSuggestion: _onDismissNameSuggestion,
}) => {
  void _onDismissNameSuggestion;

  const safeFolders = Array.isArray(folders) ? folders : [];
  const safeFiles = Array.isArray(files) ? files : [];

  if (safeFolders.length === 0 && safeFiles.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen />}
        title="No files yet"
        description="Upload files or create a folder to get started."
      />
    );
  }

  const cardBase =
    'group relative aspect-square min-h-[180px] p-4 rounded-xl cursor-pointer border ' +
    'bg-surface hover:bg-surface-elevated border-border hover:border-border-strong ' +
    'transition-all duration-fast ease-out-expo hover:shadow-md';

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
      {/* Folders */}
      {safeFolders.map((folder, folderIndex) => {
        const isSelected = selectedFiles.has(folder.id);
        return (
          <div
            key={folder.id || `folder-${folderIndex}`}
            data-file-card="true"
            onClick={(e) =>
              onFileClick(folder.id, folderIndex, e.ctrlKey || e.metaKey, e.shiftKey)
            }
            onDoubleClick={(e) => {
              e.stopPropagation();
              onFolderClick(folder.id, folder.name);
            }}
            className={cn(
              cardBase,
              isSelected && 'ring-2 ring-primary ring-offset-2 ring-offset-bg'
            )}
          >
            <div className="flex h-full flex-col items-center justify-center">
              <div className="rounded-xl bg-primary/10 p-3 transition-colors group-hover:bg-primary/15">
                <Folder className="h-8 w-8 text-primary" />
              </div>
              <p
                className="mt-2 w-full truncate text-center text-body-sm font-medium text-fg"
                title={folder.name}
              >
                {sanitizeInput(folder.name) as string}
              </p>
              <p className="mt-0.5 text-caption text-fg-subtle">
                {formatDate(folder.created_at)}
              </p>
            </div>
          </div>
        );
      })}

      {/* Files */}
      {safeFiles.map((file: FileItem, fileIndex) => {
        const isSelected = selectedFiles.has(file.id);
        const suggestion = nameSuggestions?.[file.id];
        return (
          <div
            key={file.id || `file-${fileIndex}`}
            data-file-card="true"
            onClick={(e) =>
              onFileClick(
                file.id,
                safeFolders.length + fileIndex,
                e.ctrlKey || e.metaKey,
                e.shiftKey
              )
            }
            onDoubleClick={(e) => {
              e.stopPropagation();
              onFilePreview(file);
            }}
            className={cn(
              cardBase,
              'flex flex-col',
              isSelected && 'ring-2 ring-primary ring-offset-2 ring-offset-bg'
            )}
          >
            {/* Favorite star */}
            {onToggleFavorite && (
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={file.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(file.id);
                }}
                className="absolute top-2 left-2 z-10"
              >
                <Star
                  className={cn(
                    'transition-colors',
                    file.is_favorite ? 'fill-warning text-warning' : 'text-fg-subtle'
                  )}
                />
              </IconButton>
            )}

            {/* Actions menu */}
            <div
              className="absolute top-2 right-2 z-10"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <FileActionsMenu
                file={file}
                onFilePreview={onFilePreview}
                onFileDownload={onFileDownload}
                onFileShare={onFileShare}
                onFileCopy={onFileCopy}
                onRename={onRename}
                onVersionHistory={onVersionHistory}
                onFileInfo={onFileInfo}
                onFileDelete={onFileDelete}
                trashedView={trashedView}
                onRestore={onRestore}
              />
            </div>

            <div className="file-preview-area mt-6 flex min-h-0 flex-1 flex-col items-center justify-center">
              <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
                <FileThumbnail file={file} size="large" darkMode={false} />
              </div>
              <div className="mt-1 w-full flex-shrink-0 px-1 text-center">
                <div className="flex items-center justify-center gap-1">
                  <p
                    className="truncate text-caption font-medium leading-tight text-fg"
                    title={file.name}
                  >
                    {sanitizeInput(file.name) as string}
                  </p>
                  {file.is_encrypted && (
                    <Badge
                      variant="success"
                      size="sm"
                      className="flex-shrink-0"
                      title="Zero-knowledge encrypted"
                    >
                      <Lock className="h-2.5 w-2.5" />
                    </Badge>
                  )}
                  {suggestion && onAcceptNameSuggestion && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={`Apply name suggestion: ${suggestion.suggested_name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAcceptNameSuggestion(file.id);
                      }}
                      className="h-6 w-6 text-warning"
                      title={`Rename suggestion: ${suggestion.suggested_name}`}
                    >
                      <Lightbulb />
                    </IconButton>
                  )}
                </div>
                <div className="mt-0.5 flex items-center justify-center gap-1 text-caption text-fg-subtle">
                  <span>{formatBytes(file.size)}</span>
                  <span>•</span>
                  <span>{formatDate(file.last_accessed ?? file.created_at)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default FileGrid;
