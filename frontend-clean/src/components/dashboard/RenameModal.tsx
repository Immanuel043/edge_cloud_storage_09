import React, { useState, useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';
import type { RenameModalProps } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  FormField,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@/components/ui';

/**
 * RenameModal — renames a file. Pre-fills the input with the current name
 * (selection excludes the extension) and validates against the usual
 * filesystem-forbidden characters before delegating to the `onRename`
 * callback.
 */
const RenameModal: React.FC<RenameModalProps> = ({ file, onClose, onRename }) => {
  const [newName, setNewName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (file) {
      const fileName = file.name;
      const lastDotIndex = fileName.lastIndexOf('.');
      const nameWithoutExt = lastDotIndex > 0 ? fileName.substring(0, lastDotIndex) : fileName;
      setNewName(fileName);

      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(0, nameWithoutExt.length);
        }
      }, 100);
    }
  }, [file]);

  const validateFileName = (name: string): string | null => {
    if (!name || name.trim().length === 0) return 'File name cannot be empty';
    if (name.length > 255) return 'File name is too long (max 255 characters)';
    const invalidChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (invalidChars.test(name)) return 'File name contains invalid characters';
    if (file && name.trim() === file.name) return 'Please enter a different name';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const validationError = validateFileName(newName);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!file) return;

    setIsRenaming(true);
    setError('');

    try {
      await onRename(file.id, newName.trim());
      onClose();
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setIsRenaming(false);
    }
  };

  if (!file) return null;

  return (
    <Modal open onClose={onClose} size="sm">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="h-4 w-4" />
          </div>
          <span>Rename file</span>
        </div>
      </ModalHeader>
      <form onSubmit={handleSubmit}>
        <ModalBody>
          <div className="space-y-4">
            <FormField label="Current name">
              <div className="rounded-lg bg-surface-muted px-4 py-2.5 font-mono text-body-sm text-fg-muted">
                {file.name}
              </div>
            </FormField>

            <FormField
              label="New name"
              error={error || undefined}
              hint={!error ? 'File name must not contain: < > : " / \\ | ? *' : undefined}
            >
              <Input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setError('');
                }}
                placeholder="Enter new file name"
                disabled={isRenaming}
                autoComplete="off"
              />
            </FormField>

            {error && <Banner variant="danger">{error}</Banner>}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" type="button" onClick={onClose} disabled={isRenaming}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isRenaming || !newName.trim()}
            loading={isRenaming}
          >
            {isRenaming ? 'Renaming...' : 'Rename'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
};

export default RenameModal;
