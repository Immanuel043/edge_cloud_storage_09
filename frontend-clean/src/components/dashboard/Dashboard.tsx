import React from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useStorage } from '../../contexts/StorageContext';
import { useTheme } from '../../contexts/ThemeContext';
import ZKDashboard from './zk/ZKDashboard';
import NormalDashboard from './normal/Dashboard';
import type { DownloadProgressData, DownloadStatus } from './types';

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
  const { user, logout, zkEnabled, zkSessionUnlocked, lockSession } = useAuth();
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

  // ZK Mode: Route to Zero-Knowledge encrypted dashboard with props
  if (zkEnabled && zkSessionUnlocked) {
    return (
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
              bytesDownloaded: (progress.bytesUploaded as number) || 0,
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
      />
    );
  }

  // Normal Mode: Route to standard dashboard (uses hooks internally)
  return <NormalDashboard />;
};

export default Dashboard;
