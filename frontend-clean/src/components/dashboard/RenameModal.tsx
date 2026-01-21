import React, { useState, useEffect, useRef } from 'react';
import { X, AlertCircle, FileText } from 'lucide-react';
import type { RenameModalProps } from './types';
import { getErrorMessage } from './types';

/**
 * RenameModal - Modal for renaming files
 */
const RenameModal: React.FC<RenameModalProps> = ({ file, onClose, onRename, darkMode }) => {
  const [newName, setNewName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (file) {
      // Pre-fill with current name and select the name part (without extension)
      const fileName = file.name;
      const lastDotIndex = fileName.lastIndexOf('.');
      const nameWithoutExt = lastDotIndex > 0 ? fileName.substring(0, lastDotIndex) : fileName;
      setNewName(fileName);

      // Focus input and select name without extension
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(0, nameWithoutExt.length);
        }
      }, 100);
    }
  }, [file]);

  const validateFileName = (name: string): string | null => {
    if (!name || name.trim().length === 0) {
      return 'File name cannot be empty';
    }

    if (name.length > 255) {
      return 'File name is too long (max 255 characters)';
    }

    // Check for invalid characters
    const invalidChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (invalidChars.test(name)) {
      return 'File name contains invalid characters';
    }

    // Check if name is same as original
    if (file && name.trim() === file.name) {
      return 'Please enter a different name';
    }

    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();

    const validationError = validateFileName(newName);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!file) return;

    setIsRenaming(true);
    setError('');

    try {
      await onRename(file.id, newName.trim());
      onClose();
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setIsRenaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!file) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div
        className={`w-full max-w-md rounded-2xl shadow-2xl ${
          darkMode ? 'bg-gray-800' : 'bg-white'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-b ${
            darkMode ? 'border-gray-700' : 'border-gray-200'
          }`}
        >
          <div className="flex items-center gap-3">
            <FileText size={20} className={darkMode ? 'text-blue-400' : 'text-blue-500'} />
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Rename File
            </h2>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition-colors ${
              darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6">
          <div className="space-y-4">
            {/* Current Name Display */}
            <div>
              <label
                className={`block text-sm font-medium mb-2 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                Current name
              </label>
              <div
                className={`px-4 py-2.5 rounded-lg text-sm font-mono ${
                  darkMode ? 'bg-gray-700/50 text-gray-400' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {file.name}
              </div>
            </div>

            {/* New Name Input */}
            <div>
              <label
                className={`block text-sm font-medium mb-2 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                New name
              </label>
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setNewName(e.target.value);
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                className={`w-full px-4 py-2.5 rounded-lg border transition-colors ${
                  error
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                    : darkMode
                      ? 'bg-gray-700 border-gray-600 text-white focus:border-blue-500 focus:ring-blue-500'
                      : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500 focus:ring-blue-500'
                } focus:outline-none focus:ring-2`}
                placeholder="Enter new file name"
                disabled={isRenaming}
              />
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-500">{error}</p>
              </div>
            )}

            {/* Info */}
            <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              File name must not contain: {'< > : " / \\ | ? *'}
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              disabled={isRenaming}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isRenaming || !newName.trim()}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                darkMode
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isRenaming ? 'Renaming...' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RenameModal;
