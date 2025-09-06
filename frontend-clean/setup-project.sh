#!/bin/bash

echo "Setting up Edge Cloud Storage project structure..."

# Create index.js
cat > src/index.js << 'EOFILE'
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
