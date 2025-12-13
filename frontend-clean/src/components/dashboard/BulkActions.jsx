import React from 'react';
import { Download, Trash2, X, Share2 } from 'lucide-react';

export default function BulkActions({ selectedCount, onDownload, onDelete, onShare, onClear, darkMode }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        {selectedCount} selected
      </span>
      <button
        onClick={onShare}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors font-medium text-sm"
        title="Share selected files"
      >
        <Share2 size={16} />
        Share
      </button>
      <button
        onClick={onDownload}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium text-sm"
        title="Download selected"
      >
        <Download size={16} />
        Download
      </button>
      <button
        onClick={onDelete}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors font-medium text-sm"
        title="Delete selected"
      >
        <Trash2 size={16} />
        Delete
      </button>
      <button
        onClick={onClear}
        className={`p-1.5 rounded-lg transition-colors ${darkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
        title="Clear selection"
      >
        <X size={20} />
      </button>
    </div>
  );
}