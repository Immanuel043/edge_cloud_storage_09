// Minimal polyfill for Buffer - required by bip39
// This file must be imported FIRST in main.jsx before any other imports
import { Buffer } from 'buffer';

// Make Buffer available globally for libraries like bip39
globalThis.Buffer = Buffer;
if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
  // Set argon2 WASM path for argon2-browser library
  window.argon2WasmPath = '/argon2.wasm';
}
