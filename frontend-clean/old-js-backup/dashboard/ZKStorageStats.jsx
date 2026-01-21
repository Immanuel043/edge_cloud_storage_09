import React from 'react';
import { HardDrive, FileText, Shield, Crown, Zap } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { useSubscription } from '../../contexts/SubscriptionContext';

/**
 * ZKStorageStats - Compact storage display for Zero-Knowledge encrypted users
 *
 * Desktop: Single horizontal row
 * Mobile: Stacked layout
 *
 * Shows:
 * - Plan badge with upgrade button
 * - Used storage vs total quota
 * - Progress bar (inline on desktop)
 * - File count
 * - ZK indicator badge
 */
export default function ZKStorageStats({ stats, darkMode, onUpgradeClick }) {
  const { subscription, usage } = useSubscription();

  if (!stats) return null;

  // Use subscription data if available, otherwise fall back to stats
  const used = usage?.storage_used_bytes || stats.used || 0;
  const total = subscription?.storage_quota_gb
    ? subscription.storage_quota_gb * 1024 * 1024 * 1024
    : stats.total || stats.quota || 100 * 1024 * 1024 * 1024;
  const percentage = usage?.storage_percent || (total > 0 ? (used / total) * 100 : 0);
  const fileCount = stats.files_count || stats.fileCount || 0;

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
            <Crown className={`w-4 h-4 ${darkMode ? 'text-green-400' : 'text-green-600'}`} />
            <span className={`text-sm font-semibold ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
              {subscription.plan_name}
            </span>
            <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
              darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
            }`}>
              <Shield size={10} />
              <span>ZK</span>
            </div>
          </div>
          {showUpgrade && onUpgradeClick && (
            <button
              onClick={onUpgradeClick}
              className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-gradient-to-r from-green-600 to-blue-600 hover:from-green-700 hover:to-blue-700 rounded-md transition-all"
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
        <div className="flex items-center gap-2">
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
