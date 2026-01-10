import React from 'react';
import { Cloud, HardDrive, FileText, Crown, Zap } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { useSubscription } from '../../contexts/SubscriptionContext';

/**
 * StorageStats - Compact storage display for non-ZK users
 *
 * Desktop: Single horizontal row with cache/warm/cold badges
 * Mobile: Stacked layout
 *
 * Shows:
 * - Plan badge with upgrade button
 * - Used storage vs total quota
 * - Progress bar (inline on desktop)
 * - Cache/Warm/Cold distribution as badges
 * - File count
 */
export default function StorageStats({ stats, darkMode, onUpgradeClick }) {
  const { subscription, usage } = useSubscription();

  if (!stats) return null;

  // Use subscription data if available, otherwise fall back to stats
  const used = usage?.storage_used_bytes || stats.used || 0;
  const total = subscription?.storage_quota_gb
    ? subscription.storage_quota_gb * 1024 * 1024 * 1024
    : stats.quota || 100 * 1024 * 1024 * 1024;
  const percentage = usage?.storage_percent || stats.percentage_used || (total > 0 ? (used / total) * 100 : 0);
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

  // Show upgrade button when storage > 80%
  const showUpgrade = percentage > 80;

  return (
    <div className={`mb-3 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      {/* Plan Badge */}
      {subscription && (
        <div className={`px-3 pt-3 pb-2 flex items-center justify-between border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2">
            <Crown className={`w-4 h-4 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
            <span className={`text-sm font-semibold ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
              {subscription.plan_name}
            </span>
          </div>
          {showUpgrade && onUpgradeClick && (
            <button
              onClick={onUpgradeClick}
              className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 rounded-md transition-all"
            >
              <Zap className="w-3 h-3" />
              Upgrade
            </button>
          )}
        </div>
      )}

      {/* Desktop: Horizontal layout */}
      <div className="p-3">
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
    </div>
  );
}
