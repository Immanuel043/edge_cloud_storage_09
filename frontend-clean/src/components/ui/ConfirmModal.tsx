import React from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Button } from './Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';

export type ConfirmModalVariant = 'default' | 'danger';

export interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmModalVariant;
  loading?: boolean;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  loading = false,
}) => {
  if (!open) return null;

  const isDanger = variant === 'danger';
  const Icon = isDanger ? AlertTriangle : HelpCircle;
  const iconChip = isDanger
    ? 'bg-danger/10 text-danger'
    : 'bg-primary/10 text-primary';

  const handleConfirm = async (): Promise<void> => {
    await onConfirm();
  };

  return (
    <Modal open onClose={onClose} size="sm">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconChip}`}>
            <Icon className="h-4 w-4" />
          </div>
          <span>{title}</span>
        </div>
      </ModalHeader>
      <ModalBody>
        <div className="text-body-sm text-fg-muted">{message}</div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" type="button" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={isDanger ? 'destructive' : 'primary'}
          onClick={handleConfirm}
          disabled={loading}
          loading={loading}
        >
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
};
