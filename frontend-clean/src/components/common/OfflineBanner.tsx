import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useStorage } from '../../contexts/StorageContext';

function formatTimeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * OfflineBanner — fixed-top notice shown whenever the browser reports no
 * network connectivity. Uses the Signal danger token + mild backdrop-blur so
 * it reads cleanly over any page background.
 */
const OfflineBanner: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { lastSyncedAt } = useStorage();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-0 right-0 top-0 z-[9999] flex items-center justify-center gap-2 bg-danger px-4 py-2.5 text-body-sm font-medium text-white shadow-md backdrop-blur-sm"
    >
      <WifiOff className="h-4 w-4" aria-hidden />
      <span>
        {lastSyncedAt
          ? `You're offline. Showing cached data from ${formatTimeAgo(lastSyncedAt)}.`
          : 'No internet connection. Some features may be unavailable.'}
      </span>
    </div>
  );
};

export default OfflineBanner;
