import React, { useState } from 'react';
import {
  Cloud,
  Clock,
  Zap,
  Star,
  Users,
  Brain,
  BarChart3,
  Settings,
  ChevronDown,
  ChevronRight,
  Target,
  Sparkles,
  FolderCog,
  Lightbulb,
  HardDrive,
  Menu,
  X,
  Trash2
} from 'lucide-react';

export default function Sidebar({
  activeView,
  onViewChange,
  darkMode,
  storageStats,
  isMobileOpen,
  onMobileToggle
}) {
  const [aiExpanded, setAiExpanded] = useState(true);

  const formatBytes = (bytes) => {
    // Handle null, undefined, or invalid values
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '0 B';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const menuItems = [
    {
      id: 'cloud-drive',
      label: 'Cloud Drive',
      icon: Cloud,
      description: 'All your files',
    },
    {
      id: 'recents',
      label: 'Recents',
      icon: Clock,
      description: 'Recently accessed',
    },
    {
      id: 'shared-with-me',
      label: 'Shared with me',
      icon: Users,
      description: 'Files shared by others',
    },
    {
      id: 'trash',
      label: 'Trash',
      icon: Trash2,
      description: 'Deleted files (30 days)',
    },
    {
      id: 'dedup',
      label: 'Dedup Dashboard',
      icon: Zap,
      description: 'Storage optimization',
    },
    {
      id: 'favorites',
      label: 'Favorites',
      icon: Star,
      description: 'Starred files',
    },
  ];

  const aiFeatures = [
    {
      id: 'quota-alerts',
      label: 'Quota Alerts',
      icon: Target,
      description: 'Predictive warnings',
    },
    {
      id: 'storage-optimization',
      label: 'Storage Optimization',
      icon: Sparkles,
      description: 'Auto-optimize storage',
    },
    {
      id: 'auto-organize',
      label: 'Auto-Organize',
      icon: FolderCog,
      description: 'Smart file organization',
    },
    {
      id: 'recommendations',
      label: 'Recommendations',
      icon: Lightbulb,
      description: 'File suggestions',
    },
  ];

  const bottomItems = [
    {
      id: 'analytics',
      label: 'Analytics',
      icon: BarChart3,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
    },
  ];

  const MenuItem = ({ item, isActive, onClick, isSubItem = false }) => {
    const Icon = item.icon;
    return (
      <button
        onClick={onClick}
        className={`
          w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200
          ${isSubItem ? 'pl-12 py-2' : ''}
          ${isActive
            ? darkMode
              ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
              : 'bg-[#0033A0] text-white shadow-lg'
            : darkMode
              ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
              : 'text-gray-700 hover:bg-blue-50 hover:text-[#0033A0]'
          }
        `}
        title={item.description}
      >
        <Icon size={isSubItem ? 18 : 20} />
        <span className="font-medium text-sm">{item.label}</span>
      </button>
    );
  };

  const sidebarContent = (
    <>
      {/* Logo Section */}
      <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center justify-center">
          <img
            src="/logo.png"
            alt="Edge Cloud Storage"
            className="h-16 w-auto"
            onError={(e) => {
              // Fallback to text logo if image fails to load
              e.target.style.display = 'none';
              e.target.nextSibling.style.display = 'flex';
            }}
          />
          <div
            className="hidden flex-col items-center"
            style={{ display: 'none' }}
          >
            <Cloud size={48} className="text-[#0033A0]" />
            <span className={`text-sm font-bold mt-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              EDGE CLOUD
            </span>
          </div>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        {/* Primary Menu Items */}
        {menuItems.map((item) => (
          <MenuItem
            key={item.id}
            item={item}
            isActive={activeView === item.id}
            onClick={() => onViewChange(item.id)}
          />
        ))}

        {/* AI Features Section */}
        <div className="pt-4">
          <button
            onClick={() => setAiExpanded(!aiExpanded)}
            className={`
              w-full flex items-center justify-between px-4 py-3 rounded-lg transition-all
              ${darkMode
                ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
                : 'text-gray-700 hover:bg-blue-50 hover:text-[#0033A0]'
              }
            `}
          >
            <div className="flex items-center gap-3">
              <Brain size={20} />
              <span className="font-medium text-sm">AI Features</span>
            </div>
            {aiExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>

          {aiExpanded && (
            <div className="mt-2 space-y-1">
              {aiFeatures.map((item) => (
                <MenuItem
                  key={item.id}
                  item={item}
                  isActive={activeView === item.id}
                  onClick={() => onViewChange(item.id)}
                  isSubItem
                />
              ))}
            </div>
          )}
        </div>

        {/* Bottom Menu Items */}
        <div className="pt-4 border-t mt-4" style={{ borderColor: darkMode ? '#374151' : '#e5e7eb' }}>
          {bottomItems.map((item) => (
            <MenuItem
              key={item.id}
              item={item}
              isActive={activeView === item.id}
              onClick={() => onViewChange(item.id)}
            />
          ))}
        </div>
      </nav>

      {/* Storage Info Footer */}
      {storageStats && (
        <div className={`p-4 border-t ${darkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
              <span className={`text-xs font-medium ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Storage
              </span>
            </div>
            <div className="space-y-1">
              <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {formatBytes(storageStats.used_bytes)} / {formatBytes(storageStats.quota_bytes)}
              </div>
              <div className="w-full bg-gray-300 dark:bg-gray-600 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${storageStats.usage_percentage || 0}%`,
                    backgroundColor: storageStats.usage_percentage > 90
                      ? '#ef4444'
                      : storageStats.usage_percentage > 70
                        ? '#f59e0b'
                        : '#0033A0'
                  }}
                />
              </div>
              <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {(storageStats.usage_percentage || 0).toFixed(1)}% used
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Mobile Overlay */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={onMobileToggle}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 h-full z-50 flex flex-col
          transition-transform duration-300 ease-in-out
          ${darkMode ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'}
          ${isMobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          w-64 shadow-xl
        `}
      >
        {/* Mobile Close Button */}
        <button
          onClick={onMobileToggle}
          className={`
            lg:hidden absolute top-4 right-4 p-2 rounded-lg
            ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}
          `}
        >
          <X size={20} />
        </button>

        {sidebarContent}
      </aside>

      {/* Mobile Menu Button */}
      <button
        onClick={onMobileToggle}
        className={`
          lg:hidden fixed top-4 left-4 z-30 p-2 rounded-lg shadow-lg
          ${darkMode ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'}
        `}
      >
        <Menu size={24} />
      </button>
    </>
  );
}
