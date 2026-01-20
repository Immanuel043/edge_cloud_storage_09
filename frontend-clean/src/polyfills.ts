/**
 * Minimal polyfill for Buffer - required by bip39
 * This file must be imported FIRST in main.tsx before any other imports
 */

import { Buffer } from 'buffer';

// Make Buffer available globally for libraries like bip39
// Type assertion needed because we're adding to global scope
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

if (typeof window !== 'undefined') {
  // Type assertion for window.Buffer
  (window as Window & { Buffer: typeof Buffer }).Buffer = Buffer;
  
  // Set argon2 WASM path for argon2-browser library
  (window as Window & { argon2WasmPath?: string }).argon2WasmPath = '/argon2.wasm';
}
