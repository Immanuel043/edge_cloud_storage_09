import React, { useState, useEffect } from 'react';
import { Trash2, RefreshCw, RotateCcw, Trash } from 'lucide-react';
import FileGrid from './FileGrid';
import FileList from './FileList';
import { storageService } from '../../services/storageService';

export default function TrashView({
  viewMode,
  darkMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onVersionHistory,
  onToggleFavorite,
  onFileInfo,
  onRefresh
}) {
  const [trashedFiles, setTrashedFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const fetchTrashedFiles = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await storageService.getTrash();
      setTrashedFiles(data);
    } catch (err) {
      console.error('Failed to fetch trashed files:', err);
      setError(err.message || 'Failed to load trashed files');
      setTrashedFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrashedFiles();
  }, []);

  const handleRestore = async (fileId) => {
    try {
      setRestoring(true);
      await storageService.restoreFromTrash(fileId);
      // Remove from trash list
      setTrashedFiles(prev => prev.filter(f => f.id !== fileId));
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to restore file:', err);
      alert(err.message || 'Failed to restore file');
    } finally {
      setRestoring(false);
    }
  };

  const handlePermanentDelete = async (fileId) => {
    if (!confirm('Are you sure you want to permanently delete this file? This action cannot be undone.')) {
      return;
    }

    try {
      await storageService.permanentDelete(fileId);
      // Remove from trash list
      setTrashedFiles(prev => prev.filter(f => f.id !== fileId));
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to permanently delete file:', err);
      alert(err.message || 'Failed to permanently delete file');
    }
  };

  const handleEmptyTrash = async () => {
    if (!confirm('Are you sure you want to empty the entire trash? All files will be permanently deleted. This action cannot be undone.')) {
      return;
    }

    try {
      setEmptying(true);
      await storageService.emptyTrash();
      setTrashedFiles([]);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to empty trash:', err);
      alert(err.message || 'Failed to empty trash');
    } finally {
      setEmptying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className={`animate-spin ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={32} />
          <p className={darkMode ? 'text-gray-400' : 'text-gray-600'}>Loading trash...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <Trash2 className="text-red-500" size={48} />
          <p className="text-red-500">{error}</p>
          <button
            onClick={fetchTrashedFiles}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1">
      {/* Header */}
      <div className={`flex items-center justify-between p-6 border-b ${
        darkMode ? 'border-gray-700' : 'border-gray-200'
      }`}>
        <div className="flex items-center gap-4">
          <Trash2 className={darkMode ? 'text-gray-400' : 'text-gray-600'} size={24} />
          <div>
            <h2 className={`text-2xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Trash
            </h2>
            <p className={`text-sm mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {trashedFiles.length} {trashedFiles.length === 1 ? 'file' : 'files'} • Files are automatically deleted after 30 days
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchTrashedFiles}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-colors ${
              darkMode
                ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            }`}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          {trashedFiles.length > 0 && (
            <button
              onClick={handleEmptyTrash}
              disabled={emptying}
              className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              <Trash size={16} />
              {emptying ? 'Emptying...' : 'Empty Trash'}
            </button>
          )}
        </div>
      </div>

      {/* Files */}
      <div className="p-6">
        {trashedFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className={`p-6 rounded-full mb-4 ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>
              <Trash2 className={darkMode ? 'text-gray-600' : 'text-gray-400'} size={48} />
            </div>
            <h3 className={`text-xl font-semibold mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Trash is empty
            </h3>
            <p className={`text-center max-w-md ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              Files you delete will appear here. They'll be permanently deleted after 30 days.
            </p>
          </div>
        ) : viewMode === 'grid' ? (
          <FileGrid
            folders={[]}
            files={trashedFiles}
            selectedFiles={selectedFiles}
            onFolderClick={() => {}}
            onFileClick={onFileClick}
            onFilePreview={onFilePreview}
            onFileDownload={onFileDownload}
            onFileShare={onFileShare}
            onFileDelete={handlePermanentDelete}
            onVersionHistory={onVersionHistory}
            onToggleFavorite={onToggleFavorite}
            onRename={(file) => {}} // Disable rename in trash
            onFileInfo={onFileInfo}
            darkMode={darkMode}
            trashedView={true}
            onRestore={handleRestore}
          />
        ) : (
          <FileList
            folders={[]}
            files={trashedFiles}
            selectedFiles={selectedFiles}
            onFolderClick={() => {}}
            onFileClick={onFileClick}
            onFilePreview={onFilePreview}
            onFileDownload={onFileDownload}
            onFileShare={onFileShare}
            onFileDelete={handlePermanentDelete}
            onVersionHistory={onVersionHistory}
            onToggleFavorite={onToggleFavorite}
            onRename={(file) => {}} // Disable rename in trash
            onFileInfo={onFileInfo}
            darkMode={darkMode}
            trashedView={true}
            onRestore={handleRestore}
          />
        )}
      </div>
    </div>
  );
}
