import React from 'react';
import { Shield, Lock, Users, Link2, ShieldCheck, Key } from 'lucide-react';
import type { FileSecurityTabProps } from './types';

// TODO: Connect to real security scanning API — /api/v1/files/{id}/security (not yet implemented)

/**
 * FileSecurityTab — presents security posture for a file: encryption mode,
 * scan status (placeholder until API lands), share-link summary, and the
 * set of collaborators the file is shared with.
 */
const FileSecurityTab: React.FC<FileSecurityTabProps> = ({ file }) => {
  const shareLinks = file.share_links || [];
  const sharedWith = file.shared_with || [];
  const isEncrypted = file.is_encrypted === true || !!file.encrypted_file_key;

  return (
    <div className="space-y-6">
      {isEncrypted ? (
        <div className="rounded-lg border border-success/30 bg-success/10 p-4">
          <div className="flex items-start gap-3">
            <Lock size={20} className="mt-0.5 shrink-0 text-success" />
            <div className="flex-1">
              <h4 className="mb-1 text-body-sm font-semibold text-success">File is encrypted</h4>
              <p className="text-caption text-success/80">
                This file is protected with end-to-end encryption
                {file.encryption_mode === 'client_zk' && ' (Zero-Knowledge)'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-muted p-4">
          <div className="flex items-start gap-3">
            <Lock size={20} className="text-fg-subtle" />
            <div className="flex-1">
              <h4 className="mb-1 text-body-sm font-semibold text-fg-muted">Standard storage</h4>
              <p className="text-caption text-fg-subtle">Server-side encryption at rest</p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface-muted p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="text-fg-subtle" />
          <div className="flex-1">
            <h4 className="mb-1 text-body-sm font-semibold text-fg-muted">
              No security scan data available
            </h4>
            <p className="text-caption text-fg-subtle">Security scanning is not yet connected</p>
          </div>
        </div>
      </div>

      {shareLinks.length > 0 && (
        <div>
          <h4 className="mb-3 text-body-sm font-semibold text-fg">Active share links</h4>
          <div className="space-y-2">
            {shareLinks.map((link, index) => (
              <div key={index} className="rounded-lg border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link2 size={14} className="text-accent" />
                    <span className="text-caption font-medium text-fg">
                      {link.access_type || 'View only'}
                    </span>
                  </div>
                  {link.password_protected && (
                    <div className="flex items-center gap-1 text-caption text-warning">
                      <Key size={12} />
                      <span>Password protected</span>
                    </div>
                  )}
                </div>
                <p className="text-caption text-fg-muted">
                  Expires:{' '}
                  {link.expires_at ? new Date(link.expires_at).toLocaleDateString() : 'Never'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {sharedWith.length > 0 && (
        <div>
          <h4 className="mb-3 text-body-sm font-semibold text-fg">Shared with</h4>
          <div className="space-y-2">
            {sharedWith.map((person, index) => (
              <div
                key={index}
                className="flex items-center justify-between rounded-lg bg-surface-muted p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15">
                    <Users size={16} className="text-primary" />
                  </div>
                  <div>
                    <p className="text-body-sm font-medium text-fg">{person.email}</p>
                    <p className="text-caption text-fg-muted">{person.role || 'Viewer'}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <Shield size={18} className="text-fg-muted" />
          <div>
            <h4 className="mb-2 text-body-sm font-semibold text-fg">Security best practices</h4>
            <ul className="space-y-1 text-caption text-fg-muted">
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
