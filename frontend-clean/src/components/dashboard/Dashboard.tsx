import React, { useState, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import { useTheme } from '../../contexts/ThemeContext';
import ZKDashboard from './zk/ZKDashboard';
import NormalDashboard from './normal/Dashboard';
import SessionUnlockModal from '../auth/SessionUnlockModal';
import type { DownloadProgressData, DownloadStatus, PendingDownload } from './types';

/**
 * Dashboard Router Component
 *
 * Routes between ZK and Normal dashboards based on user's encryption mode:
 * - ZK Mode (zkEnabled + zkSessionUnlocked): Uses ZKDashboard with client-side encryption
 * - Normal Mode: Uses NormalDashboard with server-side encryption
 *
 * This clean separation ensures:
 * - Zero code mixing between ZK and Normal paths
 * - Independent development and testing
 * - Clear architectural boundaries
 */
const Dashboard: React.FC = () => {
  const { darkMode, toggleTheme } = useTheme();
  const { user, logout, zkEnabled, zkSessionUnlocked, lockSession, showUnlockModal } = useAuth();
  const {
    files,
    folders,
    currentFolder,
    currentFolderName,
    storageStats,
    selectedFiles,
    uploadFile,
    downloadFile,
    deleteFile,
    createFolder,
    navigateToFolder,
    selectFile,
    selectAll,
    clearSelection,
    refreshFiles
  } = useStorage();

  // Pending download state - lifted from child dashboards to survive dashboard switches
  // This fixes the regression where a download retry would fail after unlocking ZK session
  // because NormalDashboard unmounts and ZKDashboard mounts
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

  // Handle pending download passed from NormalDashboard
  const handlePendingDownload = useCallback((download: PendingDownload | null) => {
    setPendingDownload(download);
  }, []);

  // Clear pending download (called after successful retry)
  const handleClearPendingDownload = useCallback(() => {
    setPendingDownload(null);
  }, []);

  // Handle session unlock modal close - retry pending download in whichever dashboard is active
  const handleSessionUnlockClose = useCallback(async () => {
    if (pendingDownload && zkSessionUnlocked) {
      console.log('[Dashboard] Session unlocked - pending download will be retried by active dashboard:', pendingDownload.fileName);
      // The active dashboard (ZKDashboard in this case) will pick up the pending download via props
      // and trigger the retry in its own useEffect
    }
  }, [pendingDownload, zkSessionUnlocked]);

  // ZK Mode: Route to Zero-Knowledge encrypted dashboard with props
  if (zkEnabled && zkSessionUnlocked) {
    return (
      <>
        <ZKDashboard
          darkMode={darkMode}
          toggleTheme={toggleTheme}
          user={user}
          logout={logout}
          isUnlocked={zkSessionUnlocked}
          onLock={lockSession || (() => {})}
          files={files}
          folders={folders}
          currentFolder={currentFolder}
          currentFolderName={currentFolderName}
          storageStats={storageStats}
          selectedFiles={selectedFiles}
          uploadFile={async (file: File, onProgress?: (data: { progress: number; chunksUploaded: number; totalChunks: number; bytesUploaded?: number }) => void) => {
            await uploadFile(file, onProgress ? (progress) => {
              // Map context UploadProgress to expected format
              const chunksUploaded = progress.chunksUploaded || 0;
              const totalChunks = progress.totalChunks || 0;
              onProgress({
                progress: progress.progress,
                chunksUploaded,
                totalChunks,
                bytesUploaded: progress.bytesUploaded || 0
              });
            } : undefined);
          }}
          downloadFile={async (fileId: string, fileName: string, onProgress?: (data: DownloadProgressData) => void) => {
            await downloadFile(fileId, fileName, onProgress ? (progress) => {
              onProgress({
                status: (progress.status || 'downloading') as DownloadStatus,
                progress: (progress.progress as number) || 0,
                bytesDownloaded: (progress.bytesDownloaded as number) || 0,
                totalBytes: (progress.totalBytes as number) || 0
              });
            } : undefined);
          }}
          deleteFile={async (fileId: string, fileName?: string) => {
            await deleteFile(fileId, fileName);
          }}
          createFolder={createFolder}
          navigateToFolder={navigateToFolder}
          selectFile={selectFile}
          selectAll={selectAll}
          clearSelection={clearSelection}
          refreshFiles={refreshFiles}
          pendingDownload={pendingDownload}
          onClearPendingDownload={handleClearPendingDownload}
        />
        {/* Session Unlock Modal - managed at parent level to survive dashboard switches */}
        {showUnlockModal && (
          <SessionUnlockModal
            isOpen={showUnlockModal}
            onClose={handleSessionUnlockClose}
          />
        )}
      </>
    );
  }

  // Normal Mode: Route to standard dashboard (uses hooks internally)
  // Pass pending download callback to lift state to parent for cross-dashboard retry
  return (
    <>
      <NormalDashboard
        onPendingDownload={handlePendingDownload}
      />
      {/* Session Unlock Modal - managed at parent level to survive dashboard switches */}
      {showUnlockModal && (
        <SessionUnlockModal
          isOpen={showUnlockModal}
          onClose={handleSessionUnlockClose}
        />
      )}
    </>
  );
};

export default Dashboard;
