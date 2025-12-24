import React from 'react';
import { HardDrive, FileText, Shield } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';

/**
 * ZKStorageStats - Storage display for Zero-Knowledge encrypted users
 *
 * Shows:
 * - Used storage vs total quota (same as normal users)
 * - Progress bar
 * - File count
 * - Small ZK indicator badge
 *
 * Does NOT show cache/warm/cold tiers (not applicable for ZK encrypted files)
 */
export default function ZKStorageStats({ stats, darkMode }) {
  if (!stats) return null;

  const used = stats.used || 0;
  const total = stats.total || stats.quota || 100 * 1024 * 1024 * 1024; // Default 100GB
  const percentage = total > 0 ? (used / total) * 100 : 0;
  const fileCount = stats.files_count || stats.fileCount || 0;

  // Color based on usage
  const getProgressColor = () => {
    if (percentage > 90) return 'bg-red-500';
    if (percentage > 70) return 'bg-yellow-500';
    return 'bg-blue-500';
  };

  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      {/* Header - same as normal Storage Usage */}
      <div className="flex items-center justify-between mb-3">
        <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          Storage Usage
        </h2>
        {/* Small ZK badge */}
        <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
          darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
        }`}>
          <Shield size={10} />
          <span>ZK</span>
        </div>
      </div>

      {/* Usage bar - same style as normal */}
      <div className="mb-4">
        <div className="flex justify-between text-sm mb-1">
          <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
            {formatBytes(used)} of {formatBytes(total)} used
          </span>
          <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
            {percentage.toFixed(1)}%
          </span>
        </div>
        <div className={`w-full h-2 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
          <div
            className={`h-2 rounded-full transition-all duration-300 ${getProgressColor()}`}
            style={{ width: `${Math.min(100, percentage)}%` }}
          />
        </div>
      </div>

      {/* Stats grid - simplified without cache/warm/cold */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
          <div className="flex items-center gap-2 mb-1">
            <HardDrive size={16} className={darkMode ? 'text-blue-400' : 'text-blue-500'} />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Available
            </span>
          </div>
          <p className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {formatBytes(total - used)}
          </p>
        </div>
        <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
          <div className="flex items-center gap-2 mb-1">
            <FileText size={16} className={darkMode ? 'text-green-400' : 'text-green-500'} />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Total Files
            </span>
          </div>
          <p className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {fileCount}
          </p>
        </div>
      </div>
    </div>
  );
}
