import React from 'react';
import { X } from 'lucide-react';

export default function KeyboardShortcuts({ onClose, darkMode }) {
  const shortcuts = [
    { keys: 'Ctrl+U', description: 'Upload files' },
    { keys: 'Ctrl+N', description: 'New folder' },
    { keys: 'Ctrl+F', description: 'Focus search' },
    { keys: 'Ctrl+A', description: 'Select all files' },
    { keys: 'Delete', description: 'Delete selected files' },
    { keys: 'Esc', description: 'Clear selection / Close modals' },
    { keys: 'Shift+?', description: 'Show keyboard shortcuts' },
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className={`p-6 rounded-lg max-w-md w-full ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex justify-between items-center mb-4">
          <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Keyboard Shortcuts
          </h3>
          <button onClick={onClose} className={`p-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}>
            <X size={20} />
          </button>
        </div>
        
        <div className="space-y-2">
          {shortcuts.map(({ keys, description }) => (
            <div key={keys} className="flex justify-between items-center py-2">
              <kbd className={`px-2 py-1 rounded text-sm font-mono ${
                darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
              }`}>
                {keys}
              </kbd>
              <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                {description}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}