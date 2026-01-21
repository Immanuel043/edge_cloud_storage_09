import React from 'react';
import { Download, Trash2, X, Share2 } from 'lucide-react';
import type { BulkActionsProps } from './types';

/**
 * BulkActions - Action buttons for selected files
 */
const BulkActions: React.FC<BulkActionsProps> = ({
  selectedCount,
  onDownload,
  onDelete,
  onShare,
  onClear,
  darkMode,
}) => {
  // Stop propagation to prevent parent container from clearing selection
  const handleClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    callback: () => void
  ): void => {
    e.stopPropagation();
    callback();
  };

  return (
    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        {selectedCount} selected
      </span>
      <button
        onClick={(e) => handleClick(e, onShare)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors font-medium text-sm"
        title="Share selected files"
      >
        <Share2 size={16} />
        Share
      </button>
      <button
        onClick={(e) => handleClick(e, onDownload)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium text-sm"
        title="Download selected"
      >
        <Download size={16} />
        Download
      </button>
      <button
        onClick={(e) => handleClick(e, onDelete)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors font-medium text-sm"
        title="Delete selected"
      >
        <Trash2 size={16} />
        Delete
      </button>
      <button
        onClick={(e) => handleClick(e, onClear)}
        className={`p-1.5 rounded-lg transition-colors ${
          darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
        }`}
        title="Clear selection"
      >
        <X size={18} />
      </button>
    </div>
  );
};

export default BulkActions;
