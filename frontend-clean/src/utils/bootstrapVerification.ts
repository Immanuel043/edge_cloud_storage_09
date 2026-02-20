/**
 * Bootstrap Mode Verification
 *
 * Verifies the user's service mode on app load by checking ONLY the current
 * service (based on localStorage). Does NOT probe the other service to avoid
 * leaking endpoint existence and generating noisy 403/404 errors in logs.
 *
 * If the current service has no active session, the user is treated as logged out.
 * Users who cleared localStorage simply need to log in again.
 */
import { API_URL, ZK_SERVICE_URL, ZK_STORAGE } from '../config/constants';

interface SessionCheck {
  service: 'zk' | 'normal';
  hasActiveSession: boolean;
}

const SESSION_CHECK_TIMEOUT = 3000; // 3 seconds

/**
 * Check if user has active session on a service by calling an authenticated endpoint
 *
 * Uses profile/me endpoints which require valid session cookies.
 * A 200 response means active session exists.
 * A 401/403 or error means no active session.
 *
 * @param service - Service type ('zk' or 'normal')
 * @returns SessionCheck with active session status
 */
async function checkActiveSession(service: 'zk' | 'normal'): Promise<SessionCheck> {
  // Use authenticated endpoints that require session cookies
  const url = service === 'zk'
    ? `${ZK_SERVICE_URL}/api/v1/zk/me`
    : `${API_URL}/api/v1/users/profile`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT);

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include', // Include HTTP-only session cookies
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 200 OK means we have a valid session
    if (response.ok) {
      return { service, hasActiveSession: true };
    }

    // 401/403 means no valid session (expected when not logged in)
    return { service, hasActiveSession: false };
  } catch (error) {
    // Timeout, network error, or CORS error - no active session
    return { service, hasActiveSession: false };
  }
}

/**
 * Verify service mode matches actual sessions
 *
 * Checks ONLY the current service (based on localStorage). If no active
 * session exists, treats the user as logged out without probing the other
 * service — this prevents cross-service 403/404 noise in logs and console.
 *
 * @returns Correct ZK mode (true for ZK, false for Normal)
 */
export async function verifyServiceMode(): Promise<boolean> {
  console.log('[Bootstrap] Verifying service mode...');

  // If the user just logged out, don't re-enable ZK from a stale backend cookie.
  // The logout function sets this marker before clearing localStorage.
  // sessionStorage persists across page refresh but clears when the tab closes.
  const logoutIntent = sessionStorage.getItem('zkLogoutIntent');
  if (logoutIntent) {
    sessionStorage.removeItem('zkLogoutIntent');
    console.log('[Bootstrap] Logout intent detected, skipping fallback session check');
    // Clear any stale ZK localStorage
    localStorage.removeItem(ZK_STORAGE.ZK_ENABLED_KEY);
    localStorage.removeItem(ZK_STORAGE.ZK_EMAIL_KEY);
    localStorage.removeItem(ZK_STORAGE.ZK_DATA_KEY);
    localStorage.removeItem(ZK_STORAGE.RECOVERY_ENABLED_KEY);
    return false;
  }

  // Get current localStorage mode
  const storedZKMode = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';

  // Check the current (expected) service first
  const primaryService: 'zk' | 'normal' = storedZKMode ? 'zk' : 'normal';
  const primaryCheck = await checkActiveSession(primaryService);

  if (primaryCheck.hasActiveSession) {
    // Happy path: current service has active session, no need to check the other
    console.log(`[Bootstrap] Active ${primaryService} session confirmed`);
    return storedZKMode;
  }

  // No active session on current service — user is logged out.
  // We intentionally do NOT probe the other service to avoid:
  // 1. Leaking ZK endpoint existence to normal users (403 in console/logs)
  // 2. Leaking normal endpoint existence to ZK users
  // If localStorage was cleared, the user simply needs to log in again.
  if (storedZKMode) {
    // Stale ZK localStorage — no backend session exists, clear it
    console.log('[Bootstrap] No active sessions, clearing stale ZK localStorage');
    localStorage.removeItem(ZK_STORAGE.ZK_ENABLED_KEY);
    localStorage.removeItem(ZK_STORAGE.ZK_EMAIL_KEY);
    localStorage.removeItem(ZK_STORAGE.ZK_DATA_KEY);
    localStorage.removeItem(ZK_STORAGE.RECOVERY_ENABLED_KEY);
    return false;
  }
  console.log('[Bootstrap] No active sessions, user is logged out');
  return false;
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
