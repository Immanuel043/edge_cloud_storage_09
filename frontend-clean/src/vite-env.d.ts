/// <reference types="vite/client" />

interface ImportMetaEnv {
  // API URLs
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_STORAGE_API_URL?: string;
  readonly VITE_ZK_API_URL?: string;
  readonly VITE_ZK_SERVICE_URL?: string;

  // ZK Feature Flags
  readonly VITE_ZK_ENABLED?: string;
  readonly VITE_ZK_REQUIRED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
