/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ZK_API_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  // Add other env variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
