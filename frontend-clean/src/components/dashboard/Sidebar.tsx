import React, { useState, useMemo } from 'react';
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
  Trash2,
  Shield,
  CreditCard,
  Link2,
  Activity,
} from 'lucide-react';
import type { SidebarProps, MenuItem as MenuItemType } from './types';
import { formatBytes } from '../../utils/helpers';
import { useSubscription } from '../../contexts/SubscriptionContext';

/**
 * Internal MenuItem component props
 */
interface MenuItemComponentProps {
  item: MenuItemType;
  isActive: boolean;
  onClick: () => void;
  isSubItem?: boolean;
  darkMode: boolean;
}

/**
 * MenuItem - Internal component for sidebar navigation items
 */
const MenuItemComponent: React.FC<MenuItemComponentProps> = ({
  item,
  isActive,
  onClick,
  isSubItem = false,
  darkMode,
}) => {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={`
        w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200
        ${isSubItem ? 'pl-12 py-2' : ''}
        ${
          isActive
            ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg'
            : darkMode
              ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
              : 'text-gray-700 hover:bg-blue-50 hover:text-blue-600'
        }
      `}
      title={item.description}
    >
      <Icon size={isSubItem ? 18 : 20} />
      <span className="font-medium text-sm">{item.label}</span>
    </button>
  );
};


/**
 * Sidebar Component
 *
 * Main navigation sidebar for the dashboard.
 * Supports mobile responsive design with overlay.
 */
const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onViewChange,
  darkMode,
  storageStats,
  isMobileOpen,
  onMobileToggle,
}) => {
  const { subscription, usage } = useSubscription();
  const [aiExpanded, setAiExpanded] = useState<boolean>(true);

  // Compute percentage consistently with StorageStats component
  const storagePercentage = useMemo(() => {
    if (usage && typeof (usage as Record<string, unknown>).storage_percent === 'number') {
      return (usage as Record<string, unknown>).storage_percent as number;
    }
    if (storageStats?.percentage_used != null) {
      return storageStats.percentage_used;
    }
    const quota = storageStats?.quota ?? 0;
    const used = storageStats?.used ?? 0;
    if (quota > 0) {
      return (used / quota) * 100;
    }
    return 0;
  }, [usage, storageStats]);

  // Use subscription quota for display if available
  const displayQuota = useMemo(() => {
    const storageQuotaGb = typeof subscription?.storage_quota_gb === 'number' ? subscription.storage_quota_gb : 0;
    if (storageQuotaGb > 0) return storageQuotaGb * 1024 * 1024 * 1024;
    return storageStats?.quota ?? 0;
  }, [subscription, storageStats]);

  const menuItems: MenuItemType[] = [
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
      id: 'my-share-links',
      label: 'My Share Links',
      icon: Link2,
      description: 'Manage your share links',
    },
    {
      id: 'share-analytics',
      label: 'Share Analytics',
      icon: Activity,
      description: 'Share access analytics',
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

  const aiFeatures: MenuItemType[] = [
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
      id: 'security-alerts',
      label: 'Security Alerts',
      icon: Shield,
      description: 'Anomaly detection alerts',
    },
    {
      id: 'recommendations',
      label: 'Recommendations',
      icon: Lightbulb,
      description: 'File suggestions',
    },
  ];

  const bottomItems: MenuItemType[] = [
    {
      id: 'analytics',
      label: 'Analytics',
      icon: BarChart3,
    },
    {
      id: 'billing',
      label: 'Billing & Plans',
      icon: CreditCard,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
    },
  ];

  const sidebarContent = (
    <>
      {/* Logo Section */}
      <div className={`p-6 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center justify-center gap-3">
          <div
            className={`p-2 rounded-xl ${darkMode ? 'bg-gradient-to-br from-blue-500 to-purple-600' : 'bg-gradient-to-br from-blue-400 to-purple-500'} shadow-lg`}
          >
            <Cloud className="text-white" size={28} />
          </div>
          <div>
            <h1 className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Edge Cloud
            </h1>
            <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Storage</p>
          </div>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        {/* Primary Menu Items */}
        {menuItems.map((item) => (
          <MenuItemComponent
            key={item.id}
            item={item}
            isActive={activeView === item.id}
            onClick={() => onViewChange(item.id)}
            darkMode={darkMode}
          />
        ))}

        {/* AI Features Section */}
        <div className="pt-4">
          <button
            onClick={() => setAiExpanded(!aiExpanded)}
            className={`
              w-full flex items-center justify-between px-4 py-3 rounded-lg transition-all
              ${
                darkMode
                  ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
                  : 'text-gray-700 hover:bg-blue-50 hover:text-blue-600'
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
                <MenuItemComponent
                  key={item.id}
                  item={item}
                  isActive={activeView === item.id}
                  onClick={() => onViewChange(item.id)}
                  isSubItem
                  darkMode={darkMode}
                />
              ))}
            </div>
          )}
        </div>

        {/* Bottom Menu Items */}
        <div
          className="pt-4 border-t mt-4"
          style={{ borderColor: darkMode ? '#374151' : '#e5e7eb' }}
        >
          {bottomItems.map((item) => (
            <MenuItemComponent
              key={item.id}
              item={item}
              isActive={activeView === item.id}
              onClick={() => onViewChange(item.id)}
              darkMode={darkMode}
            />
          ))}
        </div>
      </nav>

      {/* Storage Info Footer */}
      {storageStats && (
        <div
          className={`p-4 border-t ${darkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
              <span
                className={`text-xs font-medium ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}
              >
                Storage
              </span>
            </div>
            <div className="space-y-1">
              <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {formatBytes(storageStats.used)} / {formatBytes(displayQuota)}
              </div>
              <div className="w-full bg-gray-300 dark:bg-gray-600 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${storagePercentage}%`,
                    background:
                      storagePercentage > 90
                        ? '#ef4444'
                        : storagePercentage > 70
                          ? '#f59e0b'
                          : 'linear-gradient(to right, #3b82f6, #8b5cf6)',
                  }}
                />
              </div>
              <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {storagePercentage.toFixed(1)}% used
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
};

export default Sidebar;
