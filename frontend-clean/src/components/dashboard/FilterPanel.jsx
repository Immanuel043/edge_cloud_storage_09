import React from 'react';
import { FileText, Image, Video, Music, Archive, Code, HardDrive, Calendar } from 'lucide-react';

export default function FilterPanel({ filters, setFilters, darkMode }) {
  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <h3 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Filters
      </h3>
      
      <div className="grid grid-cols-3 gap-4">
        {/* File Type Filter */}
        <div>
          <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            File Type
          </label>
          <select
            value={filters.type}
            onChange={(e) => setFilters({ ...filters, type: e.target.value })}
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
          <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            File Size
          </label>
          <select
            value={filters.size}
            onChange={(e) => setFilters({ ...filters, size: e.target.value })}
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
          <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            Date Modified
          </label>
          <select
            value={filters.date}
            onChange={(e) => setFilters({ ...filters, date: e.target.value })}
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
}