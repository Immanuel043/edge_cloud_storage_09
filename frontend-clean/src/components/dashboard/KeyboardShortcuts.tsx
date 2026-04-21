import React from 'react';
import type { KeyboardShortcutsProps, KeyboardShortcut } from './types';
import { Modal, ModalHeader, ModalBody } from '@/components/ui';

/**
 * KeyboardShortcuts — modal listing global keyboard shortcuts. Shortcut set
 * differs between Edge (full shortcuts) and ZK (base set) dashboards.
 */
const KeyboardShortcuts: React.FC<KeyboardShortcutsProps> = ({ onClose, isZK = false }) => {
  const baseShortcuts: KeyboardShortcut[] = [
    { keys: 'Ctrl+U', description: 'Upload files' },
    { keys: 'Ctrl+N', description: 'New folder' },
    { keys: 'Ctrl+A', description: 'Select all' },
    { keys: 'Esc', description: 'Clear selection / Close modals' },
    { keys: 'Shift+?', description: 'Show keyboard shortcuts' },
  ];

  const nonZKShortcuts: KeyboardShortcut[] = [
    { keys: 'Ctrl+F', description: 'Focus search' },
    { keys: 'Delete', description: 'Delete selected files' },
    { keys: 'Ctrl+1', description: 'Go to Cloud Drive' },
    { keys: 'Ctrl+2', description: 'Go to Recents' },
    { keys: 'Ctrl+3', description: 'Go to Deduplication' },
    { keys: 'Ctrl+4', description: 'Go to Favorites' },
  ];

  const shortcuts: KeyboardShortcut[] = isZK
    ? baseShortcuts
    : [
        ...baseShortcuts.slice(0, 3),
        ...nonZKShortcuts.slice(0, 2),
        ...baseShortcuts.slice(3),
        ...nonZKShortcuts.slice(2),
      ];

  return (
    <Modal open onClose={onClose} size="sm">
      <ModalHeader>Keyboard shortcuts</ModalHeader>
      <ModalBody>
        <div className="space-y-1">
          {shortcuts.map(({ keys, description }) => (
            <div
              key={keys}
              className="flex items-center justify-between rounded-md py-2"
            >
              <kbd className="rounded-md border border-border bg-surface-muted px-2 py-1 font-mono text-body-sm text-fg">
                {keys}
              </kbd>
              <span className="text-body-sm text-fg-muted">{description}</span>
            </div>
          ))}
        </div>
      </ModalBody>
    </Modal>
  );
};

export default KeyboardShortcuts;
