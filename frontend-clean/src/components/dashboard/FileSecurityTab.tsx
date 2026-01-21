import React from 'react';
import {
  Shield, Lock, Users, Link2, Eye, Download, Edit,
  CheckCircle, AlertTriangle, ShieldCheck, Key
} from 'lucide-react';
import type { FileSecurityTabProps } from './types';
import type { LucideIcon } from 'lucide-react';

/**
 * FileSecurityTab - Displays file security information
 */
const FileSecurityTab: React.FC<FileSecurityTabProps> = ({ file, darkMode }) => {
  // Mock security data - will be replaced with API call
  const securityInfo = {
    encryption: {
      enabled: true,
      algorithm: 'AES-256-GCM',
      status: 'encrypted'
    } as const,
    virusScan: {
      status: 'clean' as const,
      lastScanned: file.created_at || '',
      scanner: 'ClamAV'
    },
    shareLinks: file.share_links || [],
    sharedWith: file.shared_with || [],
    permissions: {
      canView: true,
      canDownload: true,
      canEdit: false,
      canShare: true
    } as const
  };

  interface PermissionItem {
    key: keyof typeof securityInfo.permissions;
    label: string;
    icon: LucideIcon;
  }

  const permissionItems: PermissionItem[] = [
    { key: 'canView', label: 'View', icon: Eye },
    { key: 'canDownload', label: 'Download', icon: Download },
    { key: 'canEdit', label: 'Edit', icon: Edit },
    { key: 'canShare', label: 'Share', icon: Link2 },
  ];

  return (
    <div className="space-y-6">
      {/* Encryption Status */}
      <div className={`p-4 rounded-lg border ${
        darkMode
          ? 'bg-green-500/10 border-green-500/20'
          : 'bg-green-50 border-green-200'
      }`}>
        <div className="flex items-start gap-3">
          <Lock size={20} className="text-green-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className={`text-sm font-semibold mb-1 ${
              darkMode ? 'text-green-400' : 'text-green-700'
            }`}>
              File is encrypted
            </h4>
            <p className={`text-xs mb-2 ${
              darkMode ? 'text-green-400/80' : 'text-green-600'
            }`}>
              This file is protected with {securityInfo.encryption.algorithm} encryption
            </p>
            <div className={`text-xs ${
              darkMode ? 'text-green-400/60' : 'text-green-600/80'
            }`}>
              <span className="font-mono">{securityInfo.encryption.algorithm}</span> •
              <span className="ml-1">Military-grade encryption</span>
            </div>
          </div>
        </div>
      </div>

      {/* Virus Scan Status */}
      <div className={`p-4 rounded-lg border ${
        securityInfo.virusScan.status === 'clean'
          ? darkMode
            ? 'bg-blue-500/10 border-blue-500/20'
            : 'bg-blue-50 border-blue-200'
          : darkMode
            ? 'bg-red-500/10 border-red-500/20'
            : 'bg-red-50 border-red-200'
      }`}>
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className={
            securityInfo.virusScan.status === 'clean'
              ? 'text-blue-500'
              : 'text-red-500'
          } />
          <div className="flex-1">
            <h4 className={`text-sm font-semibold mb-1 ${
              securityInfo.virusScan.status === 'clean'
                ? darkMode ? 'text-blue-400' : 'text-blue-700'
                : darkMode ? 'text-red-400' : 'text-red-700'
            }`}>
              {securityInfo.virusScan.status === 'clean' ? 'No threats detected' : 'Threat detected'}
            </h4>
            <p className={`text-xs ${
              securityInfo.virusScan.status === 'clean'
                ? darkMode ? 'text-blue-400/80' : 'text-blue-600'
                : darkMode ? 'text-red-400/80' : 'text-red-600'
            }`}>
              Scanned with {securityInfo.virusScan.scanner}
            </p>
          </div>
        </div>
      </div>

      {/* Access Permissions */}
      <div>
        <h4 className={`text-sm font-semibold mb-3 ${
          darkMode ? 'text-white' : 'text-gray-900'
        }`}>
          Your Permissions
        </h4>
        <div className="space-y-2">
          {permissionItems.map(({ key, label, icon: Icon }) => (
            <div
              key={key}
              className={`flex items-center justify-between p-3 rounded-lg ${
                darkMode ? 'bg-gray-700/50' : 'bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon size={16} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
                <span className={`text-sm ${
                  darkMode ? 'text-white' : 'text-gray-900'
                }`}>
                  {label}
                </span>
              </div>
              {securityInfo.permissions[key] ? (
                <CheckCircle size={16} className="text-green-500" />
              ) : (
                <AlertTriangle size={16} className="text-red-500" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Share Links */}
      {securityInfo.shareLinks.length > 0 && (
        <div>
          <h4 className={`text-sm font-semibold mb-3 ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}>
            Active Share Links
          </h4>
          <div className="space-y-2">
            {securityInfo.shareLinks.map((link, index) => (
              <div
                key={index}
                className={`p-3 rounded-lg border ${
                  darkMode
                    ? 'bg-gray-700/50 border-gray-700'
                    : 'bg-gray-50 border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Link2 size={14} className={darkMode ? 'text-purple-400' : 'text-purple-500'} />
                    <span className={`text-xs font-medium ${
                      darkMode ? 'text-white' : 'text-gray-900'
                    }`}>
                      {link.access_type || 'View only'}
                    </span>
                  </div>
                  {link.password_protected && (
                    <div className="flex items-center gap-1 text-xs text-amber-500">
                      <Key size={12} />
                      <span>Password protected</span>
                    </div>
                  )}
                </div>
                <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Expires: {link.expires_at ? new Date(link.expires_at).toLocaleDateString() : 'Never'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shared With */}
      {securityInfo.sharedWith.length > 0 && (
        <div>
          <h4 className={`text-sm font-semibold mb-3 ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}>
            Shared With
          </h4>
          <div className="space-y-2">
            {securityInfo.sharedWith.map((person, index) => (
              <div
                key={index}
                className={`flex items-center justify-between p-3 rounded-lg ${
                  darkMode ? 'bg-gray-700/50' : 'bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    darkMode ? 'bg-blue-500/20' : 'bg-blue-100'
                  }`}>
                    <Users size={16} className={darkMode ? 'text-blue-400' : 'text-blue-600'} />
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${
                      darkMode ? 'text-white' : 'text-gray-900'
                    }`}>
                      {person.email}
                    </p>
                    <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      {person.role || 'Viewer'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Security Tips */}
      <div className={`p-4 rounded-lg border ${
        darkMode
          ? 'bg-gray-700/30 border-gray-700'
          : 'bg-gray-50 border-gray-200'
      }`}>
        <div className="flex items-start gap-3">
          <Shield size={18} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
          <div>
            <h4 className={`text-sm font-semibold mb-2 ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`}>
              Security Best Practices
            </h4>
            <ul className={`text-xs space-y-1 ${
              darkMode ? 'text-gray-400' : 'text-gray-600'
            }`}>
              <li>• Share files only with trusted recipients</li>
              <li>• Use password protection for sensitive files</li>
              <li>• Set expiration dates for temporary access</li>
              <li>• Regularly review shared files and permissions</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileSecurityTab;
