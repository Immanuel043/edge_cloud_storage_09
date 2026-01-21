import React from 'react';
import { Clock, Folder, Image, FileText, Video, Music, LayoutGrid } from 'lucide-react';

/**
 * QuickFilters - Horizontal pill-style filter buttons for dashboard
 *
 * Filters:
 * - All: Show all files and folders
 * - Recent: Files from last 7 days only
 * - Folders: Show only folders
 * - Images/Documents/Videos/Audio: Filter by file type
 */

const FILTER_OPTIONS = [
  { value: 'all', label: 'All', icon: LayoutGrid },
  { value: 'recent', label: 'Recent', icon: Clock },
  { value: 'folders', label: 'Folders', icon: Folder },
  { value: 'image', label: 'Images', icon: Image },
  { value: 'document', label: 'Documents', icon: FileText },
  { value: 'video', label: 'Videos', icon: Video },
  { value: 'audio', label: 'Audio', icon: Music },
];

export default function QuickFilters({
  activeFilter = 'all',
  onFilterChange,
  darkMode,
  isZK = false,
}) {
  const getButtonClasses = (isActive) => {
    const baseClasses = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors';

    if (isActive) {
      // Active state - ZK uses green, non-ZK uses blue
      return `${baseClasses} ${isZK ? 'bg-green-500 text-white' : 'bg-blue-500 text-white'}`;
    }

    // Inactive state
    return `${baseClasses} ${
      darkMode
        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
    }`;
  };

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide mb-4">
      {FILTER_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isActive = activeFilter === option.value;

        return (
          <button
            key={option.value}
            onClick={() => onFilterChange(option.value)}
            className={getButtonClasses(isActive)}
            aria-pressed={isActive}
            aria-label={`Filter by ${option.label}`}
          >
            <Icon size={14} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Export filter options for use in parent components
export { FILTER_OPTIONS };
