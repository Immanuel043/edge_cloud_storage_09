import React from 'react';
import { Download, Trash2, X } from 'lucide-react';

export default function BulkActions({ selectedCount, onDownload, onDelete, onClear }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-500">
        {selectedCount} selected
      </span>
      <button
        onClick={onDownload}
        className="flex items-center gap-1 px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
        title="Download selected"
      >
        <Download size={16} />
        Download
      </button>
      <button
        onClick={onDelete}
        className="flex items-center gap-1 px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600"
        title="Delete selected"
      >
        <Trash2 size={16} />
        Delete
      </button>
      <button
        onClick={onClear}
        className="p-1 text-gray-500 hover:text-gray-700"
        title="Clear selection"
      >
        <X size={20} />
      </button>
    </div>
  );
}