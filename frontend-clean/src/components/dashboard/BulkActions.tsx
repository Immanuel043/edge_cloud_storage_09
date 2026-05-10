import React from 'react';
import { Download, Trash2, X, Share2 } from 'lucide-react';
import type { BulkActionsProps } from './types';
import { Button, IconButton } from '@/components/ui';

/**
 * BulkActions — toolbar shown when one or more files are selected. Each
 * handler stops propagation so clicks don't bubble to the grid background
 * (which clears the selection).
 */
const BulkActions: React.FC<BulkActionsProps> = ({
  selectedCount,
  onDownload,
  onDelete,
  onShare,
  onClear,
}) => {
  const handleClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    callback: () => void
  ): void => {
    e.stopPropagation();
    callback();
  };

  return (
    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <span className="text-body-sm text-fg-subtle">{selectedCount} selected</span>
      <Button
        variant="primary"
        size="sm"
        onClick={(e) => handleClick(e, onShare)}
        leftIcon={<Share2 className="h-4 w-4" />}
        title="Share selected files"
      >
        Share
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={(e) => handleClick(e, onDownload)}
        leftIcon={<Download className="h-4 w-4" />}
        title="Download selected"
      >
        Download
      </Button>
      <Button
        variant="destructive"
        size="sm"
        onClick={(e) => handleClick(e, onDelete)}
        leftIcon={<Trash2 className="h-4 w-4" />}
        title="Delete selected"
      >
        Delete
      </Button>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Clear selection"
        onClick={(e) => handleClick(e, onClear)}
      >
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );
};

export default BulkActions;
