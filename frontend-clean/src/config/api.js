/**
 * API Configuration
 *
 * Centralized API endpoint configuration supporting environment-specific URLs.
 * Use environment variables to override defaults for different deployment environments.
 *
 * Environment Variables:
 * - VITE_STORAGE_API_URL: Normal storage service API URL
 * - VITE_ZK_API_URL: Zero-knowledge encryption service API URL
 *
 * Defaults to localhost for development.
 */

const API_CONFIG = {
  // Normal Storage Service API
  STORAGE_API: import.meta.env.VITE_STORAGE_API_URL || 'http://localhost:8001',

  // Zero-Knowledge Encryption Service API
  ZK_API: import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002',
};

// Validation: Ensure URLs don't end with trailing slash
Object.keys(API_CONFIG).forEach(key => {
  if (API_CONFIG[key].endsWith('/')) {
    API_CONFIG[key] = API_CONFIG[key].slice(0, -1);
  }
});

export default API_CONFIG;
