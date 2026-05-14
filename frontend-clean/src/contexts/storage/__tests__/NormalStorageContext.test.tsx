import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NormalStorageProvider, useNormalStorage } from '../NormalStorageContext';
import type { FileItem, StorageContextValue } from '../types';

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: true,
    loading: false,
    token: 'token-1',
  },
}));

const storageMocks = vi.hoisted(() => ({
  getFiles: vi.fn(),
  getFolders: vi.fn(),
  getStorageStats: vi.fn(),
  deleteFile: vi.fn(),
  getTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
  permanentDelete: vi.fn(),
  emptyTrash: vi.fn(),
}));

const websocketMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const on = vi.fn((event: string, callback: (data?: unknown) => void) => {
    const eventListeners = listeners.get(event) ?? new Set<(data?: unknown) => void>();
    eventListeners.add(callback);
    listeners.set(event, eventListeners);
    return () => {
      eventListeners.delete(callback);
    };
  });
  const emit = (event: string, data?: unknown): void => {
    listeners.get(event)?.forEach((callback) => callback(data));
  };

  return {
    listeners,
    on,
    emit,
    send: vi.fn(),
  };
});

vi.mock('../../AuthContext', () => ({
  useAuth: () => authMock.value,
}));

vi.mock('../../../services/storageService', () => ({
  storageService: storageMocks,
}));

vi.mock('../../../services/normalUploadService', () => ({
  normalUploadService: {},
}));

vi.mock('../../../services/normalDownloadService', () => ({
  normalDownloadService: {},
}));

vi.mock('../../../services/websocketService', () => ({
  websocketService: {
    on: websocketMock.on,
    send: websocketMock.send,
    isConnected: true,
  },
}));

vi.mock('../../../utils/offlineStorage', () => ({
  offlineDB: {
    getCachedFiles: vi.fn(),
    getCachedFolders: vi.fn(),
    getCachedStats: vi.fn(),
    getLastSyncedAt: vi.fn(),
    cacheFiles: vi.fn(),
    cacheFolders: vi.fn(),
    cacheStats: vi.fn(),
    saveSyncTimestamp: vi.fn(),
  },
}));

const makeStats = (totalFiles = 1) => ({
  quota: 1000,
  used: 100,
  available: 900,
  percentage_used: 10,
  total_files: totalFiles,
  distribution: {},
  type_distribution: {},
});

let currentContext: StorageContextValue | null = null;

function Probe(): React.ReactElement {
  const context = useNormalStorage();
  currentContext = context;

  return (
    <>
      <div data-testid="files">{context.files.map((file) => file.id).join(',')}</div>
      <div data-testid="selected">{Array.from(context.selectedFiles).join(',')}</div>
      <div data-testid="files-count">{context.storageStats?.files_count ?? ''}</div>
      <div data-testid="total">{context.storageStats?.total ?? ''}</div>
    </>
  );
}

async function renderProvider(initialFiles: FileItem[] = []): Promise<void> {
  storageMocks.getFiles.mockResolvedValue(initialFiles);
  storageMocks.getFolders.mockResolvedValue([]);
  storageMocks.getStorageStats.mockResolvedValue(makeStats(initialFiles.length));

  render(
    <NormalStorageProvider>
      <Probe />
    </NormalStorageProvider>
  );

  await waitFor(() => {
    expect(currentContext).not.toBeNull();
    expect(storageMocks.getFiles).toHaveBeenCalled();
    expect(screen.getByTestId('total')).toHaveTextContent('1000');
  });
}

describe('NormalStorageContext', () => {
  beforeEach(() => {
    currentContext = null;
    websocketMock.listeners.clear();
    websocketMock.on.mockClear();
    websocketMock.send.mockClear();
    Object.values(storageMocks).forEach((mock) => mock.mockReset());
  });

  it('loads storage stats without fetching files and maps total_files to files_count', async () => {
    await renderProvider();
    storageMocks.getFiles.mockClear();
    storageMocks.getFolders.mockClear();
    storageMocks.getStorageStats.mockClear();
    storageMocks.getStorageStats.mockResolvedValue({
      ...makeStats(9),
      quota: 2048,
    });

    await act(async () => {
      await currentContext?.loadStorageStats();
    });

    expect(storageMocks.getStorageStats).toHaveBeenCalledTimes(1);
    expect(storageMocks.getFiles).not.toHaveBeenCalled();
    expect(storageMocks.getFolders).not.toHaveBeenCalled();
    expect(screen.getByTestId('files-count')).toHaveTextContent('9');
    expect(screen.getByTestId('total')).toHaveTextContent('2048');
  });

  it('removes a current-folder file_deleted event and refreshes stats without file list fetches', async () => {
    await renderProvider([
      {
        id: 'file-1',
        name: 'report.pdf',
        size: 100,
        mime_type: 'application/pdf',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        folder_id: null,
      },
    ]);

    await act(async () => {
      currentContext?.selectFile('file-1', 0, false, false);
    });
    storageMocks.getFiles.mockClear();
    storageMocks.getFolders.mockClear();
    storageMocks.getStorageStats.mockClear();
    storageMocks.getStorageStats.mockResolvedValue(makeStats(0));

    await act(async () => {
      websocketMock.emit('file_deleted', { file_id: 'file-1', folder_id: null });
    });

    await waitFor(() => {
      expect(storageMocks.getStorageStats).toHaveBeenCalledTimes(1);
    });
    expect(storageMocks.getFiles).not.toHaveBeenCalled();
    expect(storageMocks.getFolders).not.toHaveBeenCalled();
    expect(screen.getByTestId('files')).toHaveTextContent(/^$/);
    expect(screen.getByTestId('selected')).toHaveTextContent(/^$/);
  });

  it('keeps visible files when file_deleted belongs to a different folder', async () => {
    await renderProvider([
      {
        id: 'file-1',
        name: 'report.pdf',
        size: 100,
        mime_type: 'application/pdf',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        folder_id: null,
      },
    ]);
    storageMocks.getFiles.mockClear();
    storageMocks.getFolders.mockClear();
    storageMocks.getStorageStats.mockClear();
    storageMocks.getStorageStats.mockResolvedValue(makeStats(0));

    await act(async () => {
      websocketMock.emit('file_deleted', { file_id: 'file-1', folder_id: 'folder-2' });
    });

    await waitFor(() => {
      expect(storageMocks.getStorageStats).toHaveBeenCalledTimes(1);
    });
    expect(storageMocks.getFiles).not.toHaveBeenCalled();
    expect(storageMocks.getFolders).not.toHaveBeenCalled();
    expect(screen.getByTestId('files')).toHaveTextContent('file-1');
  });
});
