import { useState, useEffect } from 'react';

/**
 * Hook to detect online/offline status
 * @returns {boolean} isOnline - true if online, false if offline
 */
export const useOnlineStatus = (): boolean => {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = (): void => {
      console.log('🟢 Network: Online');
      setIsOnline(true);
    };

    const handleOffline = (): void => {
      console.log('🔴 Network: Offline');
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
};

export default useOnlineStatus;
