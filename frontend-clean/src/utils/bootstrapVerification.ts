/**
 * Bootstrap Mode Verification
 *
 * Verifies user's service mode on app load by checking the current service first.
 * Only probes the other service as a fallback if the current one has no active session.
 *
 * This utility helps recover from situations where:
 * - User clears localStorage but still has active session cookies
 * - Browser storage gets corrupted
 * - User switches devices/browsers
 *
 * SECURITY: Corrects localStorage when it mismatches actual backend sessions.
 * The backend validates HTTP-only cookies, not localStorage. If localStorage
 * says zkEnabled=true but user has no ZK session, ZK API calls would 401.
 * When we detect session on the other service, we correct localStorage.
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
 * Checks the CURRENT service first (based on localStorage). Only probes the
 * other service if the current one has no active session. This avoids
 * unnecessary cross-service 401 errors on every page load.
 *
 * Fallback logic still corrects localStorage if the user has an active session
 * on the other service (e.g., after clearing localStorage).
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

  // Primary service has no session — check the other service as fallback
  const fallbackService: 'zk' | 'normal' = storedZKMode ? 'normal' : 'zk';
  const fallbackCheck = await checkActiveSession(fallbackService);

  if (fallbackCheck.hasActiveSession) {
    // Mismatch: user has session on the OTHER service — correct localStorage
    const correctZKMode = fallbackService === 'zk';

    // Don't re-enable ZK mode without encryption data in localStorage.
    // ZK requires kdfSalt, encryptedMasterKey, etc. to derive the master key.
    // Without them (e.g., after clearing storage), ZK mode is non-functional.
    if (correctZKMode && !localStorage.getItem(ZK_STORAGE.ZK_DATA_KEY)) {
      console.log('[Bootstrap] ZK session cookie found but no ZK encryption data in localStorage — treating as logged out');
      return false;
    }

    console.log(`[Bootstrap] Mode mismatch! Active session on ${fallbackService}. Correcting: ${storedZKMode} → ${correctZKMode}`);
    localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, String(correctZKMode));

    // Dispatch event to trigger provider switch
    window.dispatchEvent(
      new CustomEvent('zk-mode-changed', { detail: { enabled: correctZKMode } })
    );

    return correctZKMode;
  }

  // No active sessions on either service — user is logged out
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
