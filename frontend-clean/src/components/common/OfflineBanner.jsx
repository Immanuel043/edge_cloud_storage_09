import React from 'react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

/**
 * Offline Banner - Shows when user loses internet connection
 */
const OfflineBanner = () => {
  const isOnline = useOnlineStatus();

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
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}
    >
      <span style={{ marginRight: '0.5rem' }}>⚠️</span>
      No internet connection. Some features may be unavailable.
    </div>
  );
};

export default OfflineBanner;
