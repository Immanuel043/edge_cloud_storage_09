import React, { useState, useEffect } from 'react';
import { Trash2, RefreshCw, Trash, AlertTriangle } from 'lucide-react';
import FileGrid from './FileGrid';
import FileList from './FileList';
import { useStorage } from '../../contexts/StorageContext';
import type { TrashViewProps, FileItem } from './types';
import { getErrorMessage } from './types';
import {
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@/components/ui';

/**
 * TrashView — soft-deleted files with restore + permanent-delete actions.
 * Header has Refresh and Empty-Trash controls. Destructive actions route
 * through a Modal primitive for confirmation. Uses FileGrid/FileList with
 * `trashedView={true}` to swap the action set (rename disabled, restore
 * enabled).
 */

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: string;
  confirmText: string;
  isProcessing: boolean;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  isProcessing,
}) => (
  <Modal open={isOpen} onClose={onClose} size="sm">
    <ModalHeader>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 text-danger">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <span>{title}</span>
      </div>
    </ModalHeader>
    <ModalBody>
      <p className="text-body-sm text-fg-muted">{message}</p>
    </ModalBody>
    <ModalFooter>
      <Button variant="secondary" onClick={onClose} disabled={isProcessing}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        onClick={() => void onConfirm()}
        loading={isProcessing}
        disabled={isProcessing}
      >
        {confirmText}
      </Button>
    </ModalFooter>
  </Modal>
);

const TrashView: React.FC<TrashViewProps> = ({
  viewMode,
  darkMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onVersionHistory,
  onToggleFavorite,
  onFileInfo,
  onRestore,
}) => {
  const [trashedFiles, setTrashedFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [emptying, setEmptying] = useState<boolean>(false);
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean;
    fileId: string | null;
    fileName: string | null;
  }>({
    isOpen: false,
    fileId: null,
    fileName: null,
  });
  const [emptyTrashModal, setEmptyTrashModal] = useState<boolean>(false);

  const {
    getTrash,
    restoreFromTrash: contextRestoreFromTrash,
    permanentDelete: contextPermanentDelete,
    emptyTrash: contextEmptyTrash,
  } = useStorage();

  const fetchTrashedFiles = async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);
      const data = await getTrash();
      setTrashedFiles(data as FileItem[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to fetch trashed files:', err);
      setError(errorMessage);
      setTrashedFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTrashedFiles();
  }, []);

  const handleRestore = async (fileId: string): Promise<void> => {
    try {
      await contextRestoreFromTrash(fileId);
      setTrashedFiles((prev) => prev.filter((f) => f.id !== fileId));
      if (onRestore) onRestore(fileId);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to restore file:', err);
      alert(`Failed to restore file: ${errorMessage}`);
    }
  };

  const handlePermanentDelete = (fileId: string, fileName?: string): void => {
    setDeleteModal({ isOpen: true, fileId, fileName: fileName || null });
  };

  const confirmPermanentDelete = async (): Promise<void> => {
    const fileId = deleteModal.fileId;
    if (!fileId) return;

    try {
      await contextPermanentDelete(fileId);
      setTrashedFiles((prev) => prev.filter((f) => f.id !== fileId));
      setDeleteModal({ isOpen: false, fileId: null, fileName: null });
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to permanently delete file:', err);
      setError(errorMessage);
    }
  };

  const confirmEmptyTrash = async (): Promise<void> => {
    try {
      setEmptying(true);
      await contextEmptyTrash();
      setTrashedFiles([]);
      setEmptyTrashModal(false);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('Failed to empty trash:', err);
      setError(errorMessage);
    } finally {
      setEmptying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-body-sm text-fg-muted">Loading trash...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Banner
        variant="danger"
        icon={<Trash2 />}
        title="Failed to load trash"
        action={
          <Button variant="primary" size="sm" onClick={() => void fetchTrashedFiles()}>
            Try again
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  return (
    <Card variant="bordered">
      <CardContent className="p-0">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-6">
          <div className="flex items-center gap-4">
            <Trash2 className="h-6 w-6 text-fg-muted" />
            <div>
              <h2 className="text-h2 font-semibold text-fg">Trash</h2>
              <p className="mt-1 text-body-sm text-fg-muted">
                {trashedFiles.length} {trashedFiles.length === 1 ? 'file' : 'files'} · Files
                are automatically deleted after 30 days
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={() => void fetchTrashedFiles()}
              leftIcon={<RefreshCw className="h-4 w-4" />}
            >
              Refresh
            </Button>
            {trashedFiles.length > 0 && (
              <Button
                variant="destructive"
                size="md"
                onClick={() => setEmptyTrashModal(true)}
                disabled={emptying}
                loading={emptying}
                leftIcon={!emptying ? <Trash className="h-4 w-4" /> : undefined}
              >
                Empty trash
              </Button>
            )}
          </div>
        </div>

        {/* Files */}
        <div className="p-6">
          {trashedFiles.length === 0 ? (
            <EmptyState
              icon={<Trash2 />}
              title="Trash is empty"
              description="Files you delete will appear here. They'll be permanently deleted after 30 days."
              size="lg"
            />
          ) : viewMode === 'grid' ? (
            <FileGrid
              folders={[]}
              files={trashedFiles}
              selectedFiles={selectedFiles}
              onFolderClick={() => {}}
              onFileClick={onFileClick}
              onFilePreview={onFilePreview}
              onFileDownload={onFileDownload}
              onFileShare={onFileShare}
              onFileDelete={handlePermanentDelete}
              onVersionHistory={onVersionHistory}
              onToggleFavorite={onToggleFavorite}
              onRename={() => {}}
              onFileInfo={onFileInfo}
              darkMode={darkMode}
              trashedView={true}
              onRestore={handleRestore}
            />
          ) : (
            <FileList
              folders={[]}
              files={trashedFiles}
              selectedFiles={selectedFiles}
              onFolderClick={() => {}}
              onFileClick={onFileClick}
              onFilePreview={onFilePreview}
              onFileDownload={onFileDownload}
              onFileShare={onFileShare}
              onFileDelete={handlePermanentDelete}
              onVersionHistory={onVersionHistory}
              onToggleFavorite={onToggleFavorite}
              onRename={() => {}}
              onFileInfo={onFileInfo}
              darkMode={darkMode}
              trashedView={true}
              onRestore={handleRestore}
            />
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, fileId: null, fileName: null })}
        onConfirm={confirmPermanentDelete}
        title="Permanently delete file?"
        message={`Are you sure you want to permanently delete "${deleteModal.fileName || 'this file'}"? This action cannot be undone and the file will be lost forever.`}
        confirmText="Delete forever"
        isProcessing={false}
      />

      <ConfirmDialog
        isOpen={emptyTrashModal}
        onClose={() => setEmptyTrashModal(false)}
        onConfirm={confirmEmptyTrash}
        title="Empty trash?"
        message={`Are you sure you want to permanently delete all ${trashedFiles.length} files in trash? This action cannot be undone and all files will be lost forever.`}
        confirmText="Empty trash"
        isProcessing={emptying}
      />
    </Card>
  );
};

export default TrashView;
