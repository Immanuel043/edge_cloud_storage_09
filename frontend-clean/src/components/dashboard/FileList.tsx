import React from 'react';
import { Folder, Star, Shield, Lightbulb, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Badge,
  IconButton,
  EmptyState,
} from '@/components/ui';
import { formatBytes, formatDate, sanitizeInput } from '../../utils/helpers';
import FileThumbnail from './FileThumbnail';
import { FileActionsMenu } from './shared/FileActionsMenu';
import type { FileListProps, FileItem } from './types';

// Boundary for introducing react-virtuoso/react-window later without changing
// the normal small-list rendering path.
const VIRTUALIZATION_RECOMMENDED_FILE_COUNT = 500;

/**
 * FileList — table view for folders + files. Uses the Signal `Table`
 * primitive; action menu is the shared `FileActionsMenu` so list and grid
 * stay in sync.
 */
const FileList: React.FC<FileListProps> = ({
  folders,
  files,
  emptyState,
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
  // isZKMode currently reserved for future badge tweaks
  isZKMode: _isZKMode = false,
  trashedView = false,
  onRestore,
  nameSuggestions,
  onAcceptNameSuggestion,
  onDismissNameSuggestion: _onDismissNameSuggestion,
}) => {
  void _onDismissNameSuggestion;
  void _isZKMode;

  const safeFolders = Array.isArray(folders) ? folders : [];
  const safeFiles = Array.isArray(files) ? files : [];
  const totalItems = safeFolders.length + safeFiles.length;

  if (totalItems === 0) {
    return (
      <>
        {emptyState ?? (
          <EmptyState
            icon={<FolderOpen />}
            title="No files yet"
            description="Upload files or create a folder to get started."
          />
        )}
      </>
    );
  }

  return (
    <Table
      data-virtualization-ready={
        totalItems >= VIRTUALIZATION_RECOMMENDED_FILE_COUNT ? 'true' : undefined
      }
    >
      <TableHeader>
        <TableRow hover={false} className="border-b border-border">
          <TableHead className="w-12 text-center">★</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-32">Size</TableHead>
          <TableHead className="w-40">Last opened</TableHead>
          <TableHead className="w-16 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {safeFolders.map((folder, folderIndex) => {
          const isSelected = selectedFiles.has(folder.id);
          return (
            <TableRow
              key={folder.id}
              selected={isSelected}
              data-file-card="true"
              onClick={(e) =>
                onFileClick(folder.id, folderIndex, e.ctrlKey || e.metaKey, e.shiftKey)
              }
              onDoubleClick={(e) => {
                e.stopPropagation();
                onFolderClick(folder.id, folder.name);
              }}
              className="cursor-pointer"
            >
              <TableCell className="text-center" />
              <TableCell>
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                    <Folder className="h-4 w-4 text-primary" />
                  </span>
                  <span className="truncate font-medium text-fg">
                    {sanitizeInput(folder.name) as string}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-fg-subtle">—</TableCell>
              <TableCell className="text-fg-subtle">
                {formatDate(folder.created_at)}
              </TableCell>
              <TableCell />
            </TableRow>
          );
        })}

        {safeFiles.map((file: FileItem, fileIndex: number) => {
          const isSelected = selectedFiles.has(file.id);
          const suggestion = nameSuggestions?.[file.id];
          const isZK =
            file.is_encrypted ||
            (file as FileItem & { encryption_mode?: string }).encryption_mode === 'client_zk';

          return (
            <TableRow
              key={file.id}
              selected={isSelected}
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
              className="group cursor-pointer"
            >
              <TableCell className="text-center">
                {onToggleFavorite && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={
                      file.is_favorite ? 'Remove from favorites' : 'Add to favorites'
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(file.id);
                    }}
                  >
                    <Star
                      className={cn(
                        file.is_favorite ? 'fill-warning text-warning' : 'text-fg-subtle'
                      )}
                    />
                  </IconButton>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-3 min-w-0">
                  <FileThumbnail file={file} size="small" darkMode={false} />
                  <span className="truncate font-medium text-fg">
                    {sanitizeInput(file.name) as string}
                  </span>
                  {isZK && (
                    <Badge variant="success" size="sm" className="flex-shrink-0">
                      <Shield className="h-3 w-3" />
                      ZK
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
              </TableCell>
              <TableCell className="text-fg-muted">{formatBytes(file.size)}</TableCell>
              <TableCell className="text-fg-muted">
                {formatDate(file.last_accessed ?? file.created_at)}
              </TableCell>
              <TableCell className="text-right">
                <div
                  className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
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
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

export default FileList;
