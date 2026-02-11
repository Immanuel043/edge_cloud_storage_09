import React, { useState, useEffect } from 'react';
import { X, Download, RotateCcw, Clock, User, FileText, Trash2, MessageSquare, Loader } from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes, formatDate } from '../../utils/helpers';
import type { VersionHistoryProps, FileVersion } from './types';
import { getErrorMessage } from './types';

interface VersionsResponse {
  versions?: FileVersion[];
}

/**
 * VersionHistory - Displays file version history with restore and download options
 */
const VersionHistory: React.FC<VersionHistoryProps> = ({ file, onClose, onRestore, darkMode }) => {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    loadVersions();
  }, [file.id]);

  const loadVersions = async (): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/v1/files/${file.id}/versions`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to load versions');
      }

      const data = await response.json() as VersionsResponse;
      setVersions(data.versions || []);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to load versions:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (versionNumber: number): Promise<void> => {
    if (!window.confirm(`Restore to version ${versionNumber}? Your current version will be saved.`)) {
      return;
    }

    setRestoring(versionNumber);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/v1/files/${file.id}/versions/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ version_number: versionNumber }),
      });

      if (!response.ok) {
        throw new Error('Failed to restore version');
      }

      // Reload versions and notify parent
      await loadVersions();
      if (onRestore) {
        await onRestore(String(versionNumber));
      }

      setError(''); // Clear any previous errors — restore succeeded
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to restore version:', err);
      setError(errorMessage);
    } finally {
      setRestoring(null);
    }
  };

  const handleDownload = async (versionNumber: number): Promise<void> => {
    try {
      const response = await fetch(
        `${API_URL}/api/v1/files/${file.id}/versions/${versionNumber}/download`,
        { credentials: 'include' }
      );

      if (!response.ok) {
        throw new Error('Download failed');
      }

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `${file.name}_v${versionNumber}`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?(.+)"?/i);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Download failed:', err);
      setError(errorMessage);
    }
  };

  const handleDelete = async (versionNumber: number): Promise<void> => {
    if (!window.confirm(`Delete version ${versionNumber}? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/v1/files/${file.id}/versions/${versionNumber}`,
        {
          method: 'DELETE',
          credentials: 'include',
        }
      );

      if (!response.ok) {
        throw new Error('Failed to delete version');
      }

      await loadVersions();
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to delete version:', err);
      setError(errorMessage);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col ${
        darkMode ? 'bg-gray-800' : 'bg-white'
      }`}>
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
              <Clock size={24} className="text-blue-500" />
            </div>
            <div>
              <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Version History
              </h3>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {file.name}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
            type="button"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className={`mb-4 p-3 rounded-lg ${darkMode ? 'bg-red-900/30 text-red-300' : 'bg-red-100 text-red-700'} text-sm`}>
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader className="animate-spin text-blue-500 mb-3" size={32} />
              <p className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
                Loading version history...
              </p>
            </div>
          ) : versions.length === 0 ? (
            <div className="text-center py-12">
              <Clock size={48} className="mx-auto mb-3 opacity-50" />
              <p className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
                No version history available
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {versions.map((version) => {
                const isCurrent = version.version === versions[0]?.version;
                return (
                  <div
                    key={version.id}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      isCurrent
                        ? darkMode
                          ? 'border-blue-500 bg-blue-900/20'
                          : 'border-blue-500 bg-blue-50'
                        : darkMode
                        ? 'border-gray-700 bg-gray-900/20 hover:border-gray-600'
                        : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        {/* Version header */}
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`font-semibold ${
                            isCurrent
                              ? 'text-blue-600 dark:text-blue-400'
                              : darkMode ? 'text-white' : 'text-gray-900'
                          }`}>
                            Version {version.version}
                          </span>
                          {isCurrent && (
                            <span className="px-2 py-0.5 rounded-full bg-blue-500 text-white text-xs font-medium">
                              Current
                            </span>
                          )}
                        </div>

                        {/* Metadata */}
                        <div className="space-y-1 text-sm">
                          {version.created_by && (
                            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                              <User size={14} />
                              <span>{version.created_by}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                            <Clock size={14} />
                            <span>{formatDate(version.created_at)}</span>
                          </div>
                          <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                            <FileText size={14} />
                            <span>{formatBytes(version.size)}</span>
                          </div>
                          {version.change_description && (
                            <div className="flex items-start gap-2 text-gray-600 dark:text-gray-400 mt-2">
                              <MessageSquare size={14} className="mt-0.5" />
                              <span className="italic">{version.change_description}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        {!isCurrent && (
                          <button
                            onClick={() => handleRestore(version.version)}
                            disabled={restoring === version.version}
                            className={`p-2 rounded-lg transition-colors ${
                              restoring === version.version
                                ? 'bg-gray-300 cursor-not-allowed'
                                : darkMode
                                ? 'hover:bg-gray-700 text-blue-400'
                                : 'hover:bg-blue-100 text-blue-600'
                            }`}
                            title="Restore this version"
                            type="button"
                          >
                            {restoring === version.version ? (
                              <Loader size={18} className="animate-spin" />
                            ) : (
                              <RotateCcw size={18} />
                            )}
                          </button>
                        )}

                        <button
                          onClick={() => handleDownload(version.version)}
                          className={`p-2 rounded-lg transition-colors ${
                            darkMode
                              ? 'hover:bg-gray-700 text-green-400'
                              : 'hover:bg-green-100 text-green-600'
                          }`}
                          title="Download this version"
                          type="button"
                        >
                          <Download size={18} />
                        </button>

                        {!isCurrent && (
                          <button
                            onClick={() => handleDelete(version.version)}
                            className={`p-2 rounded-lg transition-colors ${
                              darkMode
                                ? 'hover:bg-gray-700 text-red-400'
                                : 'hover:bg-red-100 text-red-600'
                            }`}
                            title="Delete this version"
                            type="button"
                          >
                            <Trash2 size={18} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className={`p-4 border-t ${darkMode ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            💡 Tip: Versions are created automatically when you replace a file.
            Restore any version to bring back previous changes.
          </p>
        </div>
      </div>
    </div>
  );
};

export default VersionHistory;
