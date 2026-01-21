import React, { useState } from 'react';
import { X, Info, Clock, Shield } from 'lucide-react';
import FileDetailsTab from './FileDetailsTab';
import FileActivityTab from './FileActivityTab';
import FileSecurityTab from './FileSecurityTab';
import type { FileInfoPanelProps, FileInfoTab } from './types';

/**
 * FileInfoPanel Component
 *
 * Side panel showing file details, activity, and security information.
 */
const FileInfoPanel: React.FC<FileInfoPanelProps> = ({
  file,
  onClose,
  onRename,
  darkMode,
  isZK = false,
}) => {
  const [activeTab, setActiveTab] = useState<string>('details');

  const tabs: FileInfoTab[] = [
    { id: 'details', label: 'Details', icon: Info },
    { id: 'activity', label: 'Activity', icon: Clock },
    { id: 'security', label: 'Security', icon: Shield },
  ];

  if (!file) return null;

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />

      {/* Side Panel */}
      <div
        className={`fixed right-0 top-0 bottom-0 w-full md:w-[400px] z-50 shadow-2xl transform transition-transform duration-300 ${
          darkMode ? 'bg-gray-800' : 'bg-white'
        }`}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-b ${
            darkMode ? 'border-gray-700' : 'border-gray-200'
          }`}
        >
          <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            File Information
          </h2>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition-colors ${
              darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className={`flex border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors relative ${
                  activeTab === tab.id
                    ? darkMode
                      ? 'text-blue-400'
                      : 'text-blue-600'
                    : darkMode
                      ? 'text-gray-400 hover:text-gray-300'
                      : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
                {activeTab === tab.id && (
                  <div
                    className={`absolute bottom-0 left-0 right-0 h-0.5 ${
                      darkMode ? 'bg-blue-400' : 'bg-blue-600'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="overflow-y-auto h-[calc(100vh-130px)] p-6">
          {activeTab === 'details' && (
            <FileDetailsTab file={file} onRename={onRename} darkMode={darkMode} isZK={isZK} />
          )}
          {activeTab === 'activity' && <FileActivityTab file={file} darkMode={darkMode} />}
          {activeTab === 'security' && <FileSecurityTab file={file} darkMode={darkMode} />}
        </div>
      </div>
    </>
  );
};

export default FileInfoPanel;
