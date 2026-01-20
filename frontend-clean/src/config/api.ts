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
 * Remove trailing slash from URL if present
 */
function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * API configuration object with normalized URLs
 */
const API_CONFIG: ApiConfig = {
  // Normal Storage Service API
  STORAGE_API: normalizeUrl(
    import.meta.env.VITE_STORAGE_API_URL || 'http://localhost:8001'
  ),

  // Zero-Knowledge Encryption Service API
  ZK_API: normalizeUrl(
    import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002'
  ),
};

export default API_CONFIG;
