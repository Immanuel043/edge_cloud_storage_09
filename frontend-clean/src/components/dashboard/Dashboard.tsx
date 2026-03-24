import React, { Suspense, useState, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import type { PendingDownload } from './types';

const ZKDashboard = React.lazy(() => import('./zk/ZKDashboard'));
const NormalDashboard = React.lazy(() => import('./normal/Dashboard'));
const SessionUnlockModal = React.lazy(() => import('../auth/SessionUnlockModal'));

/**
 * Dashboard Router Component
 *
 * Thin mode switch + unlock modal host.
 * Routes between ZK and Normal dashboards based on user's encryption mode.
 * Owns pendingDownload state to survive cross-dashboard mode switches.
 */
const Dashboard: React.FC = () => {
  const { zkEnabled, zkSessionUnlocked, showUnlockModal } = useAuth();

  // Pending download state - lifted from child dashboards to survive dashboard switches
  // This fixes the regression where a download retry would fail after unlocking ZK session
  // because NormalDashboard unmounts and ZKDashboard mounts
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

  const handlePendingDownload = useCallback((download: PendingDownload | null) => {
    setPendingDownload(download);
  }, []);

  const handleClearPendingDownload = useCallback(() => {
    setPendingDownload(null);
  }, []);

  const handleSessionUnlockClose = useCallback(async () => {
    if (pendingDownload && zkSessionUnlocked) {
      console.log('[Dashboard] Session unlocked - pending download will be retried by active dashboard:', pendingDownload.fileName);
    }
  }, [pendingDownload, zkSessionUnlocked]);

  return (
    <>
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      }>
        {zkEnabled && zkSessionUnlocked ? (
          <ZKDashboard
            pendingDownload={pendingDownload}
            onClearPendingDownload={handleClearPendingDownload}
          />
        ) : (
          <NormalDashboard
            onPendingDownload={handlePendingDownload}
          />
        )}
      </Suspense>

      {/* Session Unlock Modal - managed at parent level to survive dashboard switches */}
      {showUnlockModal && (
        <Suspense fallback={null}>
          <SessionUnlockModal
            isOpen={showUnlockModal}
            onClose={handleSessionUnlockClose}
          />
        </Suspense>
      )}
    </>
  );
};

export default Dashboard;
