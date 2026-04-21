/**
 * Application Entry Point
 *
 * CRITICAL: Polyfills must be imported FIRST before any other modules
 * This ensures Buffer is available for crypto and WASM libraries
 */
import './polyfills';

// Self-hosted variable fonts — Inter for UI, JetBrains Mono for technical metadata.
// Importing the default entrypoint registers the variable @font-face at build time.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found. Make sure there is a <div id="root"></div> in your HTML.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
