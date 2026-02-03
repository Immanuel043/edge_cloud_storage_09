/**
 * Bootstrap Mode Verification
 *
 * Verifies user's service mode on app load by checking both services.
 * Corrects localStorage if mismatch detected (e.g., after clearing localStorage).
 *
 * This utility helps recover from situations where:
 * - User clears localStorage but still has active session cookies
 * - Browser storage gets corrupted
 * - User switches devices/browsers
 */
import { API_URL, ZK_SERVICE_URL, ZK_STORAGE } from '../config/constants';

interface ServiceHealthCheck {
  service: 'zk' | 'normal';
  available: boolean;
  hasSession: boolean;
}

const HEALTH_CHECK_TIMEOUT = 2000; // 2 seconds

/**
 * Check if a service is available and has active session
 *
 * @param url - Health check endpoint URL
 * @param service - Service type ('zk' or 'normal')
 * @returns ServiceHealthCheck with availability and session status
 */
async function checkServiceHealth(
  url: string,
  service: 'zk' | 'normal'
): Promise<ServiceHealthCheck> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include', // Include HTTP-only cookies
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      // If we got a successful response with status "healthy", assume session exists
      const hasSession = data.status === 'healthy';

      return {
        service,
        available: true,
        hasSession,
      };
    }

    return { service, available: false, hasSession: false };
  } catch (error) {
    // Timeout or network error
    return { service, available: false, hasSession: false };
  }
}

/**
 * Verify service mode matches actual sessions
 *
 * Checks both ZK and Normal services to determine which one has an active session,
 * then corrects localStorage if it doesn't match.
 *
 * Preference order: ZK > Normal > localStorage
 *
 * @returns Correct ZK mode (true for ZK, false for Normal)
 */
export async function verifyServiceMode(): Promise<boolean> {
  console.log('[Bootstrap] Verifying service mode...');

  // Get current localStorage mode
  const storedZKMode = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';

  // Check both services in parallel
  const [zkCheck, normalCheck] = await Promise.all([
    checkServiceHealth(`${ZK_SERVICE_URL}/health`, 'zk'),
    checkServiceHealth(`${API_URL}/api/v1/health/db`, 'normal'),
  ]);

  console.log('[Bootstrap] Health checks:', { zkCheck, normalCheck });

  // Determine correct mode based on active sessions
  let correctZKMode: boolean;

  if (zkCheck.hasSession && zkCheck.available) {
    // Active ZK session found
    correctZKMode = true;
    console.log('[Bootstrap] Active ZK session detected');
  } else if (normalCheck.hasSession && normalCheck.available) {
    // Active Normal session found
    correctZKMode = false;
    console.log('[Bootstrap] Active Normal session detected');
  } else {
    // No active sessions, use localStorage
    correctZKMode = storedZKMode;
    console.log('[Bootstrap] No active sessions, using localStorage:', correctZKMode);
  }

  // Correct localStorage if mismatch
  if (correctZKMode !== storedZKMode) {
    console.log(`[Bootstrap] Mode mismatch detected! Correcting: ${storedZKMode} → ${correctZKMode}`);
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, String(correctZKMode));

    // Dispatch event to trigger provider switch
    window.dispatchEvent(
      new CustomEvent('zk-mode-changed', { detail: { enabled: correctZKMode } })
    );
  }

  return correctZKMode;
}

/**
 * Bootstrap with mode verification (call on app mount)
 *
 * This function should be called once when the app initializes.
 * It runs non-blocking in the background and doesn't delay app startup.
 */
export async function bootstrapWithVerification(): Promise<void> {
  try {
    await verifyServiceMode();
    console.log('[Bootstrap] Mode verification complete');
  } catch (error) {
    console.error('[Bootstrap] Mode verification failed:', error);
    // Don't block app load on error
  }
}
