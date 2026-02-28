import React from 'react';
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

const OfflineBanner: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { lastSyncedAt } = useStorage();

  if (isOnline) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        backgroundColor: '#dc2626',
        color: 'white',
        padding: '0.75rem',
        textAlign: 'center',
        zIndex: 9999,
        fontSize: '0.875rem',
        fontWeight: '500',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
      }}
    >
      <span style={{ marginRight: '0.5rem' }}>⚠️</span>
      {lastSyncedAt
        ? `You're offline. Showing cached data from ${formatTimeAgo(lastSyncedAt)}.`
        : 'No internet connection. Some features may be unavailable.'}
    </div>
  );
};

export default OfflineBanner;
