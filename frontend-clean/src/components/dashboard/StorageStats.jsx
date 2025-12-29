import React from 'react';
import { Cloud, HardDrive, FileText } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';

/**
 * StorageStats - Compact storage display for non-ZK users
 *
 * Desktop: Single horizontal row with cache/warm/cold badges
 * Mobile: Stacked layout
 *
 * Shows:
 * - Used storage vs total quota
 * - Progress bar (inline on desktop)
 * - Cache/Warm/Cold distribution as badges
 * - File count
 */
export default function StorageStats({ stats, darkMode }) {
  if (!stats) return null;

  const used = stats.used || 0;
  const total = stats.quota || 100 * 1024 * 1024 * 1024;
  const percentage = stats.percentage_used || (total > 0 ? (used / total) * 100 : 0);
  const fileCount = stats.files_count || stats.fileCount || 0;

  const cacheSize = stats.distribution?.cache?.size || 0;
  const warmSize = stats.distribution?.warm?.size || 0;
  const coldSize = stats.distribution?.cold?.size || 0;

  // Color based on usage
  const getProgressColor = () => {
    if (percentage > 90) return 'bg-red-500';
    if (percentage > 70) return 'bg-yellow-500';
    return 'bg-blue-500';
  };

  return (
    <div className={`mb-3 p-3 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      {/* Desktop: Horizontal layout */}
      <div className="hidden sm:flex items-center justify-between gap-4">
        {/* Storage info */}
        <div className="flex items-center gap-3">
          <HardDrive size={18} className={darkMode ? 'text-blue-400' : 'text-blue-500'} />
          <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {formatBytes(used)} / {formatBytes(total)}
          </span>
        </div>

        {/* Progress bar - fixed width */}
        <div className="flex items-center gap-2 flex-1 max-w-xs">
          <div className={`flex-1 h-2 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
            <div
              className={`h-2 rounded-full transition-all duration-300 ${getProgressColor()}`}
              style={{ width: `${Math.min(100, percentage)}%` }}
            />
          </div>
          <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {percentage.toFixed(1)}%
          </span>
        </div>

        {/* Cache/Warm/Cold badges */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Cloud size={12} className="text-blue-400" />
            <span className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              {formatBytes(cacheSize)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <HardDrive size={12} className="text-green-400" />
            <span className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              {formatBytes(warmSize)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <HardDrive size={12} className="text-gray-400" />
            <span className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              {formatBytes(coldSize)}
            </span>
          </div>
        </div>

        {/* File count */}
        <div className="flex items-center gap-2">
          <FileText size={14} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
          <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        </div>
      </div>

      {/* Mobile: Stacked layout */}
      <div className="sm:hidden space-y-3">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className={darkMode ? 'text-blue-400' : 'text-blue-500'} />
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {formatBytes(used)} / {formatBytes(total)}
            </span>
          </div>
          <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {percentage.toFixed(1)}%
          </span>
        </div>

        {/* Progress bar */}
        <div className={`w-full h-2 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
          <div
            className={`h-2 rounded-full transition-all duration-300 ${getProgressColor()}`}
            style={{ width: `${Math.min(100, percentage)}%` }}
          />
        </div>

        {/* Cache/Warm/Cold row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Cloud size={12} className="text-blue-400" />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Cache:</span>
            <span className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              {formatBytes(cacheSize)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <HardDrive size={12} className="text-green-400" />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Warm:</span>
            <span className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              {formatBytes(warmSize)}
            </span>
          </div>
        </div>

        {/* File count */}
        <div className="flex items-center gap-2">
          <FileText size={14} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
          <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        </div>
      </div>
    </div>
  );
}
