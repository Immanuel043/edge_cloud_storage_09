import React from 'react';
import { AlertTriangle, RefreshCw, Mail } from 'lucide-react';
import type { FileCorruptionModalProps } from './types';
import {
  Banner,
  Button,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';

/**
 * FileCorruptionModal — surfaced when a file fails client-side decryption.
 * Explains common causes and offers a re-upload / support path. Technical
 * error is collapsed behind a `<details>` for the curious.
 */
const FileCorruptionModal: React.FC<FileCorruptionModalProps> = ({
  isOpen,
  onClose,
  fileName,
  errorMessage,
}) => {
  if (!isOpen) return null;

  return (
    <Modal open={isOpen} onClose={onClose} size="md">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-danger to-warning text-white">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <p className="text-h3 font-bold text-fg">File corruption detected</p>
            <p className="text-body-sm text-fg-muted">Unable to decrypt file</p>
          </div>
        </div>
      </ModalHeader>
      <ModalBody>
        <div className="space-y-6">
          <Banner variant="danger" icon={<AlertTriangle />}>
            <p className="text-body-sm font-medium">
              The file <span className="font-semibold">&ldquo;{fileName}&rdquo;</span> could not be
              decrypted.
            </p>
            <p className="mt-1 text-caption">
              {errorMessage || 'The file may have been tampered with or corrupted during storage.'}
            </p>
          </Banner>

          <section>
            <h3 className="mb-2 text-body-sm font-semibold text-fg">What does this mean?</h3>
            <ul className="space-y-1 text-body-sm text-fg-muted">
              <li>• The encrypted file data failed authentication</li>
              <li>• The file may have been modified or corrupted</li>
              <li>• Network errors during upload may have occurred</li>
              <li>• Storage system issues may have affected the file</li>
            </ul>
          </section>

          <section>
            <h3 className="mb-3 text-body-sm font-semibold text-fg">What can you do?</h3>
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
                <RefreshCw className="h-5 w-5 text-primary" />
                <div className="flex-1">
                  <p className="text-body-sm font-medium text-fg">Re-upload the file</p>
                  <p className="mt-1 text-caption text-fg-muted">
                    Delete this corrupted file and upload it again from your device.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
                <Mail className="h-5 w-5 text-accent" />
                <div className="flex-1">
                  <p className="text-body-sm font-medium text-fg">Contact support</p>
                  <p className="mt-1 text-caption text-fg-muted">
                    If this problem persists, our team can investigate.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <details className="text-caption text-fg-subtle">
            <summary className="cursor-pointer font-medium">Technical details</summary>
            <div className="mt-2 rounded-lg bg-surface-muted p-3 font-mono text-fg-muted">
              {errorMessage}
            </div>
          </details>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" className="w-full" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default FileCorruptionModal;
