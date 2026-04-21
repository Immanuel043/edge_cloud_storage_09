import React from 'react';
import { Lock, AlertTriangle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, Button, Banner } from '@/components/ui';

/**
 * LockSessionDialog — confirmation prompt shown before clearing the ZK
 * encryption keys from memory. Rebuilt on the `Modal` primitive for focus
 * trap + ESC handling; previously an inline `fixed inset-0` panel in each
 * dashboard.
 */

export interface LockSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export const LockSessionDialog: React.FC<LockSessionDialogProps> = ({
  open,
  onClose,
  onConfirm,
}) => (
  <Modal
    open={open}
    onClose={onClose}
    size="sm"
    title={
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/15 text-warning"
        >
          <Lock className="h-4 w-4" />
        </span>
        Lock session?
      </span>
    }
  >
    <ModalBody>
      <Banner variant="warning" icon={<AlertTriangle />} title="Your encryption keys will be cleared">
        You&rsquo;ll need to enter your password to access your encrypted files again.
      </Banner>
    </ModalBody>
    <ModalFooter>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="primary"
        onClick={() => {
          onClose();
          onConfirm();
        }}
      >
        Lock session
      </Button>
    </ModalFooter>
  </Modal>
);

export default LockSessionDialog;
