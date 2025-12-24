import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

// Copy argon2 wasm file to public folder for runtime loading
function copyArgon2Wasm() {
  return {
    name: 'copy-argon2-wasm',
    buildStart() {
      const wasmSrc = resolve('node_modules/argon2-browser/dist/argon2.wasm')
      const wasmDest = resolve('public/argon2.wasm')
      if (existsSync(wasmSrc)) {
        const destDir = dirname(wasmDest)
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(wasmSrc, wasmDest)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait(), copyArgon2Wasm()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  define: {
    // Polyfill for libraries that check for Buffer (like bip39)
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Provide buffer polyfill for libraries that need it
      buffer: 'buffer',
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      // Don't fail on unresolved wasm imports
      onwarn(warning, warn) {
        // Ignore wasm-related warnings
        if (warning.message && warning.message.includes('argon2.wasm')) {
          return
        }
        warn(warning)
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Node.js global to browser globalThis
      define: {
        global: 'globalThis',
      },
    },
    // Pre-bundle buffer to ensure it's available
    include: ['buffer'],
    // Exclude these from pre-bundling - they need special handling
    exclude: ['bip39', 'argon2-browser'],
  },
})
