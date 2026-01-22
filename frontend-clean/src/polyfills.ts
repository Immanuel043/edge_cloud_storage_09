/**
 * Minimal polyfill for Buffer - required by bip39
 * This file must be imported FIRST in main.tsx before any other imports
 */

// Import Buffer using namespace import for compatibility
import * as BufferModule from 'buffer'

// Get the Buffer constructor
const BufferClass = (BufferModule as any).Buffer || BufferModule

// Make Buffer available globally for libraries like bip39
if (typeof globalThis !== 'undefined') {
  (globalThis as any).Buffer = BufferClass
}

if (typeof window !== 'undefined') {
  (window as any).Buffer = BufferClass
  
  // Set argon2 WASM path for argon2-browser library
  (window as any).argon2WasmPath = '/argon2.wasm'
}
