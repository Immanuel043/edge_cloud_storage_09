// Networking
export const API_URL =
  (import.meta.env.VITE_API_URL && import.meta.env.VITE_API_URL.replace(/\/+$/, "")) ||
  "http://localhost:3001"; // no trailing slash

export const WS_URL =
  (import.meta.env.VITE_WS_URL && import.meta.env.VITE_WS_URL.replace(/\/+$/, "")) ||
  "ws://localhost:3001"; // no trailing slash

// Sizes
export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

export const CHUNK_SIZE = 64 * MiB;         // 64 MiB
export const MAX_FILE_SIZE = 20 * GiB;      // 20 GiB

// Storage tiers
export const STORAGE_TIERS = Object.freeze({
  CACHE_DAYS: 1,
  WARM_DAYS: 7,
  COLD_DAYS: 30,
});

// File categories & helper
export const FILE_CATEGORIES = Object.freeze({
  IMAGE:    ["jpg","jpeg","png","gif","bmp","svg","webp","ico"],
  DOCUMENT: ["pdf","doc","docx","txt","rtf","odt","xls","xlsx","csv","ppt","pptx"],
  VIDEO:    ["mp4","avi","mkv","mov","wmv","flv","webm"],
  AUDIO:    ["mp3","wav","flac","aac","ogg","wma"],
  ARCHIVE:  ["zip","rar","7z","tar","gz","bz2"],
  CODE:     ["js","jsx","ts","tsx","html","css","json","xml","py","java","cpp","c","go","rs"],
});

export function getFileCategory(ext = "") {
  const e = ext.toLowerCase().replace(/^\./, "");
  for (const [cat, list] of Object.entries(FILE_CATEGORIES)) {
    if (list.includes(e)) return cat;
  }
  return "OTHER";
}

// Simple client-side rate limit defaults
export const RATE_LIMIT = Object.freeze({
  MAX_REQUESTS: 10,
  TIME_WINDOW: 1000, // ms
});

// Common endpoints (optional)
export const ENDPOINTS = Object.freeze({
  LOGIN: `${API_URL}/auth/login`,
  REFRESH: `${API_URL}/auth/refresh`,
  UPLOAD_INIT: `${API_URL}/upload/init`,
  WS_PATH: `${WS_URL}/ws`, // e.g., new WebSocket(ENDPOINTS.WS_PATH)
});
