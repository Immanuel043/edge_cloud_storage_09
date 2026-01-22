import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import type { Plugin } from 'vite'

// Copy argon2 files to public folder for runtime loading
function copyArgon2Files(): Plugin {
  const filesToCopy = [
    { src: 'node_modules/argon2-browser/dist/argon2.wasm', dest: 'public/argon2.wasm' },
    // Use bundled version which includes everything (no dynamic imports)
    { src: 'node_modules/argon2-browser/dist/argon2-bundled.min.js', dest: 'public/argon2-browser.js' },
  ]
  
  function copyFiles() {
    for (const { src, dest } of filesToCopy) {
      const srcPath = resolve(src)
      const destPath = resolve(dest)
      
      if (!existsSync(srcPath)) {
        console.warn(`[vite-plugin] ${src} not found`)
        continue
      }
      
      try {
        const destDir = dirname(destPath)
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcPath, destPath)
      } catch (error) {
        console.error(`[vite-plugin] Failed to copy ${src}:`, error)
      }
    }
    console.log('[vite-plugin] Copied argon2 files to public directory')
  }
  
  return {
    name: 'copy-argon2-files',
    buildStart() {
      copyFiles()
    },
    configureServer() {
      copyFiles()
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    copyArgon2Files(),
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      onwarn(warning, warn) {
        // Ignore argon2 WASM warnings
        if (warning.message?.includes('argon2')) {
          return
        }
        warn(warning)
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    include: ['buffer'],
    exclude: ['bip39', 'argon2-browser'],
  },
})
