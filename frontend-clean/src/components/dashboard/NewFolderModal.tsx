import React, { useState, useEffect, useRef } from 'react';
import { FolderPlus } from 'lucide-react';
import type { NewFolderModalProps } from './types';
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

const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

const NewFolderModal: React.FC<NewFolderModalProps> = ({ open, onClose, onCreate }) => {
  const [name, setName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setError('');
      setIsCreating(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const validate = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return 'Folder name cannot be empty';
    if (trimmed.length > 255) return 'Folder name is too long (max 255 characters)';
    if (FORBIDDEN_CHARS.test(trimmed)) return 'Folder name contains invalid characters';
    if (trimmed === '.' || trimmed === '..') return 'That name is reserved';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsCreating(true);
    setError('');
    try {
      await onCreate(name.trim());
      onClose();
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  };

  if (!open) return null;

  return (
    <Modal open onClose={onClose} size="sm">
      <ModalHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderPlus className="h-4 w-4" />
          </div>
          <span>New folder</span>
        </div>
      </ModalHeader>
      <form onSubmit={handleSubmit}>
        <ModalBody>
          <div className="space-y-4">
            <FormField
              label="Folder name"
              error={error || undefined}
              hint={!error ? 'Folder name must not contain: < > : " / \\ | ? *' : undefined}
            >
              <Input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError('');
                }}
                placeholder="Untitled folder"
                disabled={isCreating}
                autoComplete="off"
                maxLength={255}
              />
            </FormField>

            {error && <Banner variant="danger">{error}</Banner>}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" type="button" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isCreating || !name.trim()}
            loading={isCreating}
          >
            {isCreating ? 'Creating...' : 'Create folder'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
};

export default NewFolderModal;
