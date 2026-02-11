import React from 'react';
import type { FilterPanelProps } from './types';

/**
 * FilterPanel Component
 *
 * Advanced filter controls for file type, size, and date.
 */
const FilterPanel: React.FC<FilterPanelProps> = ({ filters, setFilters, darkMode }) => {
  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          Filters
        </h3>
        {(filters.type !== 'all' || filters.size !== 'all' || filters.date !== 'all') && (
          <button
            onClick={() => setFilters({ type: 'all', size: 'all', date: 'all' })}
            className={`text-sm px-3 py-1 rounded-lg transition-colors ${
              darkMode ? 'text-blue-400 hover:bg-gray-700' : 'text-blue-600 hover:bg-gray-100'
            }`}
          >
            Reset filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* File Type Filter */}
        <div>
          <label
            className={`block text-sm font-medium mb-2 ${
              darkMode ? 'text-gray-300' : 'text-gray-700'
            }`}
          >
            File Type
          </label>
          <select
            value={filters.type}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setFilters({ ...filters, type: e.target.value })
            }
            className={`w-full p-2 rounded ${darkMode ? 'bg-gray-700 text-white' : 'bg-gray-100'}`}
          >
            <option value="all">All Files</option>
            <option value="image">Images</option>
            <option value="document">Documents</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
            <option value="archive">Archives</option>
            <option value="code">Code</option>
          </select>
        </div>

        {/* Size Filter */}
        <div>
          <label
            className={`block text-sm font-medium mb-2 ${
              darkMode ? 'text-gray-300' : 'text-gray-700'
            }`}
          >
            File Size
          </label>
          <select
            value={filters.size}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setFilters({ ...filters, size: e.target.value })
            }
            className={`w-full p-2 rounded ${darkMode ? 'bg-gray-700 text-white' : 'bg-gray-100'}`}
          >
            <option value="all">All Sizes</option>
            <option value="small">Small (&lt; 10MB)</option>
            <option value="medium">Medium (10-100MB)</option>
            <option value="large">Large (&gt; 100MB)</option>
          </select>
        </div>

        {/* Date Filter */}
        <div>
          <label
            className={`block text-sm font-medium mb-2 ${
              darkMode ? 'text-gray-300' : 'text-gray-700'
            }`}
          >
            Date Modified
          </label>
          <select
            value={filters.date}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setFilters({ ...filters, date: e.target.value })
            }
            className={`w-full p-2 rounded ${darkMode ? 'bg-gray-700 text-white' : 'bg-gray-100'}`}
          >
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
          </select>
        </div>
      </div>
    </div>
  );
};

export default FilterPanel;
