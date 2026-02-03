import React from 'react';
import { Shield, Cloud } from 'lucide-react';

interface ServiceModeBadgeProps {
  isZKMode: boolean;
  darkMode: boolean;
}

/**
 * ServiceModeBadge - Shows current service mode in dashboard header
 *
 * Displays a visual indicator of which service the user is currently using:
 * - ZK Mode: Green badge with Shield icon + "ZK Encrypted"
 * - Normal Mode: Blue badge with Cloud icon + "Standard Storage"
 *
 * The badge adapts to dark mode with appropriate color adjustments.
 */
const ServiceModeBadge: React.FC<ServiceModeBadgeProps> = ({ isZKMode, darkMode }) => {
  if (isZKMode) {
    return (
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${
          darkMode
            ? 'bg-green-900/20 text-green-400 border border-green-800/50'
            : 'bg-green-50 text-green-700 border border-green-200'
        }`}
      >
        <Shield size={14} />
        <span>ZK Encrypted</span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${
        darkMode
          ? 'bg-blue-900/20 text-blue-400 border border-blue-800/50'
          : 'bg-blue-50 text-blue-700 border border-blue-200'
      }`}
    >
      <Cloud size={14} />
      <span>Standard Storage</span>
    </div>
  );
};

export default ServiceModeBadge;
