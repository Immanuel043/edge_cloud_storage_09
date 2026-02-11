import React from 'react';
import {
  Shield, Lock, Users, Link2,
  ShieldCheck, Key
} from 'lucide-react';
import type { FileSecurityTabProps } from './types';

// TODO: Connect to real security scanning API — /api/v1/files/{id}/security (not yet implemented)

/**
 * FileSecurityTab - Displays file security information derived from actual file data
 */
const FileSecurityTab: React.FC<FileSecurityTabProps> = ({ file, darkMode }) => {
  const shareLinks = file.share_links || [];
  const sharedWith = file.shared_with || [];
  const isEncrypted = file.is_encrypted === true || !!file.encrypted_file_key;

  return (
    <div className="space-y-6">
      {/* Encryption Status — derived from actual file data */}
      {isEncrypted ? (
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
              <p className={`text-xs ${
                darkMode ? 'text-green-400/80' : 'text-green-600'
              }`}>
                This file is protected with end-to-end encryption
                {file.encryption_mode === 'client_zk' && ' (Zero-Knowledge)'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className={`p-4 rounded-lg border ${
          darkMode
            ? 'bg-gray-500/10 border-gray-500/20'
            : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex items-start gap-3">
            <Lock size={20} className={darkMode ? 'text-gray-500' : 'text-gray-400'} />
            <div className="flex-1">
              <h4 className={`text-sm font-semibold mb-1 ${
                darkMode ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Standard storage
              </h4>
              <p className={`text-xs ${
                darkMode ? 'text-gray-500' : 'text-gray-500'
              }`}>
                Server-side encryption at rest
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Security Scan Status — no real API source yet */}
      <div className={`p-4 rounded-lg border ${
        darkMode
          ? 'bg-gray-500/10 border-gray-500/20'
          : 'bg-gray-50 border-gray-200'
      }`}>
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className={darkMode ? 'text-gray-500' : 'text-gray-400'} />
          <div className="flex-1">
            <h4 className={`text-sm font-semibold mb-1 ${
              darkMode ? 'text-gray-400' : 'text-gray-600'
            }`}>
              No security scan data available
            </h4>
            <p className={`text-xs ${
              darkMode ? 'text-gray-500' : 'text-gray-500'
            }`}>
              Security scanning is not yet connected
            </p>
          </div>
        </div>
      </div>

      {/* Share Links */}
      {shareLinks.length > 0 && (
        <div>
          <h4 className={`text-sm font-semibold mb-3 ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}>
            Active Share Links
          </h4>
          <div className="space-y-2">
            {shareLinks.map((link, index) => (
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
      {sharedWith.length > 0 && (
        <div>
          <h4 className={`text-sm font-semibold mb-3 ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}>
            Shared With
          </h4>
          <div className="space-y-2">
            {sharedWith.map((person, index) => (
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
