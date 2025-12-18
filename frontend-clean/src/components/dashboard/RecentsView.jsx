import React, { useMemo } from 'react';
import { Clock, Loader, AlertCircle } from 'lucide-react';
import FileGrid from './FileGrid';
import FileList from './FileList';
import { useRecents } from '../../hooks/useRecents';

export default function RecentsView({
  viewMode,
  darkMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
}) {
  const { recents, loading, error, refresh } = useRecents(true);

  // Group files by time period
  const groupedFiles = useMemo(() => {
    const now = new Date();
    const groups = {
      today: [],
      yesterday: [],
      thisWeek: [],
      thisMonth: [],
      older: []
    };

    recents.forEach(file => {
      const fileDate = new Date(file.last_accessed || file.created_at);
      const daysDiff = Math.floor((now - fileDate) / (1000 * 60 * 60 * 24));

      if (daysDiff === 0) {
        groups.today.push(file);
      } else if (daysDiff === 1) {
        groups.yesterday.push(file);
      } else if (daysDiff <= 7) {
        groups.thisWeek.push(file);
      } else if (daysDiff <= 30) {
        groups.thisMonth.push(file);
      } else {
        groups.older.push(file);
      }
    });

    return groups;
  }, [recents]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="animate-spin text-blue-500" size={48} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={`p-6 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center gap-3 text-red-500">
          <AlertCircle size={24} />
          <div>
            <h3 className="font-semibold">Failed to load recent files</h3>
            <p className="text-sm mt-1">{error}</p>
            <button
              onClick={refresh}
              className="mt-3 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (recents.length === 0) {
    return (
      <div className={`p-12 rounded-lg text-center ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <Clock className={`mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={64} />
        <h3 className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          No recent files
        </h3>
        <p className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
          Files you access will appear here for easy access
        </p>
      </div>
    );
  }

  const TimeGroup = ({ title, files }) => {
    if (files.length === 0) return null;

    return (
      <div className="mb-8">
        <h2 className={`text-sm font-semibold mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'} uppercase tracking-wide`}>
          {title}
        </h2>
        {viewMode === 'grid' ? (
          <FileGrid
            folders={[]}
            files={files}
            selectedFiles={selectedFiles}
            onFolderClick={() => {}}
            onFileClick={onFileClick}
            onFilePreview={onFilePreview}
            onFileDownload={onFileDownload}
            onFileShare={onFileShare}
            onFileDelete={onFileDelete}
            onVersionHistory={onVersionHistory}
            darkMode={darkMode}
          />
        ) : (
          <FileList
            folders={[]}
            files={files}
            selectedFiles={selectedFiles}
            onFolderClick={() => {}}
            onFileClick={onFileClick}
            onFilePreview={onFilePreview}
            onFileDownload={onFileDownload}
            onFileShare={onFileShare}
            onFileDelete={onFileDelete}
            onVersionHistory={onVersionHistory}
            darkMode={darkMode}
          />
        )}
      </div>
    );
  };

  return (
    <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Clock size={24} className="text-blue-500" />
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Recent Files
          </h1>
        </div>
        <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {recents.length} files in the last 30 days
        </span>
      </div>

      <div className="space-y-8">
        <TimeGroup title="Today" files={groupedFiles.today} />
        <TimeGroup title="Yesterday" files={groupedFiles.yesterday} />
        <TimeGroup title="This Week" files={groupedFiles.thisWeek} />
        <TimeGroup title="This Month" files={groupedFiles.thisMonth} />
        <TimeGroup title="Older" files={groupedFiles.older} />
      </div>
    </div>
  );
}
