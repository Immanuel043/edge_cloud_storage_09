import React from 'react';
import {
  MoreVertical,
  Eye,
  Download,
  Share2,
  Copy,
  Edit2,
  Clock,
  Info,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  IconButton,
} from '@/components/ui';
import type { FileItem } from '../types';

/**
 * FileActionsMenu — shared dropdown menu used by FileGrid and FileList for
 * per-row file actions. Built on the DropdownMenu primitive (portal-positioned,
 * ESC + click-outside + arrow-key navigation).
 */

export interface FileActionsMenuProps {
  file: FileItem;
  onFilePreview: (file: FileItem) => void;
  onFileDownload: (fileId: string, fileName: string) => void;
  onFileShare: (fileId: string) => void;
  onFileCopy?: ((file: FileItem) => void) | undefined;
  onRename?: ((file: FileItem) => void) | undefined;
  onVersionHistory: (file: FileItem) => void;
  onFileInfo?: ((file: FileItem) => void) | undefined;
  onFileDelete: (fileId: string, fileName: string) => void;
  trashedView?: boolean | undefined;
  onRestore?: ((fileId: string) => void) | undefined;
  /** ClassName applied to the trigger IconButton. */
  triggerClassName?: string | undefined;
  /** Menu alignment. */
  align?: 'start' | 'center' | 'end' | undefined;
}

export const FileActionsMenu: React.FC<FileActionsMenuProps> = ({
  file,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileCopy,
  onRename,
  onVersionHistory,
  onFileInfo,
  onFileDelete,
  trashedView,
  onRestore,
  triggerClassName,
  align = 'end',
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="File actions"
        className={triggerClassName}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreVertical />
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align={align}>
      <DropdownMenuItem icon={<Eye />} onSelect={() => onFilePreview(file)}>
        Preview
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={<Download />}
        onSelect={() => onFileDownload(file.id, file.name)}
      >
        Download
      </DropdownMenuItem>
      <DropdownMenuItem icon={<Share2 />} onSelect={() => onFileShare(file.id)}>
        Share
      </DropdownMenuItem>
      {onFileCopy && (
        <DropdownMenuItem icon={<Copy />} onSelect={() => onFileCopy(file)}>
          Make a copy
        </DropdownMenuItem>
      )}
      {onRename && (
        <DropdownMenuItem icon={<Edit2 />} onSelect={() => onRename(file)}>
          Rename
        </DropdownMenuItem>
      )}
      <DropdownMenuItem icon={<Clock />} onSelect={() => onVersionHistory(file)}>
        Version history
      </DropdownMenuItem>
      {onFileInfo && (
        <DropdownMenuItem icon={<Info />} onSelect={() => onFileInfo(file)}>
          File information
        </DropdownMenuItem>
      )}
      {trashedView && onRestore && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<RotateCcw />} onSelect={() => onRestore(file.id)}>
            Restore
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        icon={<Trash2 />}
        onSelect={() => onFileDelete(file.id, file.name)}
      >
        {trashedView ? 'Delete forever' : 'Delete'}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

export default FileActionsMenu;
