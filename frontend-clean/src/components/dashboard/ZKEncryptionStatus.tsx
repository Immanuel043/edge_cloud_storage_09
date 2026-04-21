import React, { useMemo, useState } from 'react';
import {
  Shield,
  ShieldCheck,
  Lock,
  Unlock,
  Key,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import { ZK_STORAGE } from '../../config/constants';
import type { ZKEncryptionStatusProps } from './types';
import {
  Badge,
  Banner,
  Button,
  IconButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * ZKEncryptionStatus — compact status bar at the top of the ZK dashboard
 * indicating whether the ZK session is unlocked, the active KDF, and the
 * encryption algorithm. Expandable and can request a session lock.
 */
const ZKEncryptionStatus: React.FC<ZKEncryptionStatusProps> = ({
  isUnlocked,
  onLock,
  kdfAlgorithm: propKdfAlgorithm,
  kdfIterations: propKdfIterations,
  kdfMemory: propKdfMemory,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [showLockConfirm, setShowLockConfirm] = useState<boolean>(false);

  const { kdfAlgorithm, kdfIterations, kdfMemory } = useMemo(() => {
    if (propKdfAlgorithm) {
      return {
        kdfAlgorithm: propKdfAlgorithm,
        kdfIterations: propKdfIterations || 3,
        kdfMemory: propKdfMemory || 65536,
      };
    }

    try {
      const zkDataStr = localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY);
      if (zkDataStr) {
        const zkData = JSON.parse(zkDataStr) as {
          kdfAlgorithm?: string;
          kdfIterations?: number;
          kdfMemory?: number;
        };
        return {
          kdfAlgorithm: zkData.kdfAlgorithm || 'argon2id',
          kdfIterations: zkData.kdfIterations || 3,
          kdfMemory: zkData.kdfMemory || 65536,
        };
      }
    } catch (e: unknown) {
      console.warn('Failed to read ZK data from localStorage:', e);
    }

    return { kdfAlgorithm: 'argon2id', kdfIterations: 3, kdfMemory: 65536 };
  }, [propKdfAlgorithm, propKdfIterations, propKdfMemory]);

  const getKdfDisplayString = (): string => {
    if (kdfAlgorithm === 'argon2id') {
      const memoryMB = Math.round(kdfMemory / 1024);
      return `Argon2id (${memoryMB}MB, ${kdfIterations} iterations)`;
    }
    const iterationsK = Math.round(kdfIterations / 1000);
    return `PBKDF2 (${iterationsK}K iterations)`;
  };

  const handleLockClick = (): void => {
    setShowLockConfirm(false);
    if (onLock) onLock();
  };

  const containerClass = cn(
    'mb-2 rounded-lg border transition-colors',
    isUnlocked ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'
  );

  const iconWrapperClass = cn(
    'rounded-lg p-1.5',
    isUnlocked ? 'bg-success/15' : 'bg-warning/15'
  );

  const iconToneClass = isUnlocked ? 'text-success' : 'text-warning';

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={iconWrapperClass}>
            <ShieldCheck size={18} className={iconToneClass} />
          </div>

          <div className="flex items-center gap-2">
            <span className={cn('text-body-sm font-medium', iconToneClass)}>
              {isUnlocked ? 'Your encryption keys are active' : 'Session locked'}
            </span>
            <Badge variant="neutral" size="sm">
              AES-256-GCM
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant={isUnlocked ? 'success' : 'warning'}
            size="sm"
            className="flex items-center gap-1"
          >
            {isUnlocked ? <Unlock size={12} /> : <Lock size={12} />}
            <span>{isUnlocked ? 'Session active' : 'Locked'}</span>
          </Badge>

          <IconButton
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-label={isExpanded ? 'Hide details' : 'Show details'}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </IconButton>

          {isUnlocked && onLock && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowLockConfirm(true)}
              leftIcon={<Lock size={14} />}
            >
              Lock session
            </Button>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-border/60 px-4 py-3">
          <div className="flex items-center gap-6 text-body-sm">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-fg-subtle" />
              <span className="text-fg-muted">Encryption:</span>
              <span className="font-medium text-fg">AES-256-GCM</span>
            </div>
            <div className="flex items-center gap-2">
              <Key size={14} className="text-fg-subtle" />
              <span className="text-fg-muted">Key derivation:</span>
              <span className="font-medium text-fg">{getKdfDisplayString()}</span>
            </div>
          </div>
          <p className="mt-2 text-caption text-fg-subtle">
            {isUnlocked
              ? 'You can upload, download, and manage your encrypted files.'
              : 'Enter your password to access your encrypted files.'}
          </p>
        </div>
      )}

      {showLockConfirm && (
        <Modal open onClose={() => setShowLockConfirm(false)} size="sm">
          <ModalHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-warning to-danger text-white">
                <Lock className="h-5 w-5" />
              </div>
              <span>Lock session?</span>
            </div>
          </ModalHeader>
          <ModalBody>
            <Banner variant="warning" icon={<AlertTriangle />}>
              <p className="text-body-sm font-medium">Your encryption keys will be cleared</p>
              <p className="mt-1 text-caption">
                You&apos;ll need to enter your password to access your encrypted files again.
              </p>
            </Banner>
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onClick={() => setShowLockConfirm(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleLockClick}>
              Lock session
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
};

export default ZKEncryptionStatus;
