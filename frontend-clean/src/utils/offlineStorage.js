class OfflineDB {
  constructor() {
    this.dbName = 'EdgeCloudOffline';
    this.version = 1;
    this.db = null;
    this.init();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }
        
        if (!db.objectStoreNames.contains('stats')) {
          db.createObjectStore('stats', { keyPath: 'id' });
        }
      };
    });
  }

  async cacheFiles(files) {
    if (!this.db) await this.init();
    
    const transaction = this.db.transaction(['files'], 'readwrite');
    const store = transaction.objectStore('files');
    
    files.forEach(file => store.put(file));
    
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getCachedFiles() {
    if (!this.db) await this.init();
    
    const transaction = this.db.transaction(['files'], 'readonly');
    const store = transaction.objectStore('files');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async cacheFolders(folders) {
    if (!this.db) await this.init();
    
    const transaction = this.db.transaction(['folders'], 'readwrite');
    const store = transaction.objectStore('folders');
    
    folders.forEach(folder => store.put(folder));
    
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getCachedFolders() {
    if (!this.db) await this.init();
    
    const transaction = this.db.transaction(['folders'], 'readonly');
    const store = transaction.objectStore('folders');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async cacheStats(stats) {
    if (!this.db) await this.init();
    
    const transaction = this.db.transaction(['stats'], 'readwrite');
    const store = transaction.objectStore('stats');
    
    store.put({ ...stats, id: 'current' });
    
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getCachedStats() {
    if (!this.db) await this.init();
    
    const transaction = this.db.transaction(['stats'], 'readonly');
    const store = transaction.objectStore('stats');
    
    return new Promise((resolve, reject) => {
      const request = store.get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export const offlineDB = new OfflineDB();