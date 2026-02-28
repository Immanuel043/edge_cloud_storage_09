interface FileData {
  id: string;
  [key: string]: unknown;
}

interface FolderData {
  id: string;
  [key: string]: unknown;
}

interface StatsData {
  id?: string;
  [key: string]: unknown;
}

class OfflineDB {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null;

  constructor() {
    this.dbName = 'EdgeCloudOffline';
    this.version = 2;
    this.db = null;
    this.init();
  }

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('stats')) {
          db.createObjectStore('stats', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('syncMeta')) {
          db.createObjectStore('syncMeta', { keyPath: 'id' });
        }
      };
    });
  }

  async cacheFiles(files: FileData[]): Promise<void> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['files'], 'readwrite');
    const store = transaction.objectStore('files');

    // Clear stale records so deleted files don't persist in cache
    store.clear();

    // Filter out files without valid IDs (required for IndexedDB keyPath)
    const validFiles = files.filter(file => file && file.id != null);
    validFiles.forEach(file => store.put(file));

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getCachedFiles(): Promise<FileData[]> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['files'], 'readonly');
    const store = transaction.objectStore('files');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as FileData[]);
      request.onerror = () => reject(request.error);
    });
  }

  async cacheFolders(folders: FolderData[]): Promise<void> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['folders'], 'readwrite');
    const store = transaction.objectStore('folders');

    // Clear stale records so deleted folders don't persist in cache
    store.clear();

    folders.forEach(folder => store.put(folder));

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getCachedFolders(): Promise<FolderData[]> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['folders'], 'readonly');
    const store = transaction.objectStore('folders');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as FolderData[]);
      request.onerror = () => reject(request.error);
    });
  }

  async cacheStats(stats: StatsData): Promise<void> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['stats'], 'readwrite');
    const store = transaction.objectStore('stats');

    store.put({ ...stats, id: 'current' });

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getCachedStats(): Promise<StatsData | undefined> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['stats'], 'readonly');
    const store = transaction.objectStore('stats');

    return new Promise((resolve, reject) => {
      const request = store.get('current');
      request.onsuccess = () => resolve(request.result as StatsData | undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async saveSyncTimestamp(): Promise<void> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['syncMeta'], 'readwrite');
    const store = transaction.objectStore('syncMeta');

    store.put({ id: 'lastSync', lastSyncedAt: new Date().toISOString() });

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getLastSyncedAt(): Promise<string | null> {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['syncMeta'], 'readonly');
    const store = transaction.objectStore('syncMeta');

    return new Promise((resolve, reject) => {
      const request = store.get('lastSync');
      request.onsuccess = () => {
        const result = request.result as { id: string; lastSyncedAt: string } | undefined;
        resolve(result?.lastSyncedAt ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }
}

export const offlineDB = new OfflineDB();
