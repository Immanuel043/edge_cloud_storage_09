import React from 'react';
import { Clock, Folder, Image, FileText, Video, Music, LayoutGrid } from 'lucide-react';
import type { QuickFiltersProps, FilterOption } from './types';
import { cn } from '@/lib/cn';

/**
 * QuickFilters — horizontal pill filters displayed above the file grid.
 * Active pill is tinted with the brand accent (ZK mode uses success green
 * to signal client-side scope).
 */
const FILTER_OPTIONS: FilterOption[] = [
  { value: 'all', label: 'All', icon: LayoutGrid },
  { value: 'recent', label: 'Recent', icon: Clock },
  { value: 'folders', label: 'Folders', icon: Folder },
  { value: 'image', label: 'Images', icon: Image },
  { value: 'document', label: 'Documents', icon: FileText },
  { value: 'video', label: 'Videos', icon: Video },
  { value: 'audio', label: 'Audio', icon: Music },
];

const QuickFilters: React.FC<QuickFiltersProps> = ({
  activeFilter = 'all',
  onFilterChange,
  isZK = false,
}) => {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2">
      {FILTER_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isActive = activeFilter === option.value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onFilterChange(option.value)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-body-sm font-medium transition-colors',
              isActive
                ? isZK
                  ? 'bg-success text-white'
                  : 'bg-primary text-white'
                : 'bg-surface-muted text-fg-muted hover:bg-surface-elevated hover:text-fg'
            )}
          >
            <Icon size={16} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default QuickFilters;
