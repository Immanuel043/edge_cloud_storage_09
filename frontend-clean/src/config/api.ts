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

/**
 * API Configuration interface
 */
export interface ApiConfig {
  /** Normal Storage Service API URL */
  STORAGE_API: string;
  /** Zero-Knowledge Encryption Service API URL */
  ZK_API: string;
}

/**
 * Remove trailing slash from URL. Preserve an explicit empty string (dev
 * sets `VITE_STORAGE_API_URL=''` so calls are same-origin and go through
 * the Vite proxy → nginx, avoiding the self-signed-cert trust problem).
 */
function normalizeUrl(url: string | undefined, defaultUrl: string): string {
  if (url === '') return '';
  return (url ?? defaultUrl).replace(/\/+$/, '');
}

/**
 * API configuration object with normalized URLs
 */
const API_CONFIG: ApiConfig = {
  // Normal Storage Service API
  STORAGE_API: normalizeUrl(import.meta.env.VITE_STORAGE_API_URL, ''),

  // Zero-Knowledge Encryption Service API
  ZK_API: normalizeUrl(import.meta.env.VITE_ZK_API_URL, ''),
};

export default API_CONFIG;
