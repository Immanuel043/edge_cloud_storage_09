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
 * Checks both ZK and Normal services to determine which one has an active session,
 * then corrects localStorage if it doesn't match.
 *
 * IMPORTANT: Only corrects localStorage if there's a clear mismatch.
 * If no sessions are detected, trusts localStorage (user might be logged out).
 *
 * @returns Correct ZK mode (true for ZK, false for Normal)
 */
export async function verifyServiceMode(): Promise<boolean> {
  console.log('[Bootstrap] Verifying service mode...');

  // Get current localStorage mode
  const storedZKMode = localStorage.getItem(ZK_STORAGE.ZK_ENABLED_KEY) === 'true';

  // Check both services in parallel for active sessions
  const [zkCheck, normalCheck] = await Promise.all([
    checkActiveSession('zk'),
    checkActiveSession('normal'),
  ]);

  console.log('[Bootstrap] Session checks:', { zkCheck, normalCheck, storedZKMode });

  // Determine correct mode based on active sessions
  let correctZKMode: boolean;

  if (zkCheck.hasActiveSession && !normalCheck.hasActiveSession) {
    // Only ZK session found
    correctZKMode = true;
    console.log('[Bootstrap] Active ZK session detected (only)');
  } else if (normalCheck.hasActiveSession && !zkCheck.hasActiveSession) {
    // Only Normal session found
    correctZKMode = false;
    console.log('[Bootstrap] Active Normal session detected (only)');
  } else if (zkCheck.hasActiveSession && normalCheck.hasActiveSession) {
    // Both sessions found (unusual) - prefer ZK for security
    correctZKMode = true;
    console.log('[Bootstrap] Both sessions detected, preferring ZK');
  } else {
    // No active sessions - trust localStorage (user is logged out or fresh)
    correctZKMode = storedZKMode;
    console.log('[Bootstrap] No active sessions detected, trusting localStorage:', correctZKMode);
  }

  // Correct localStorage only if there's a real mismatch with active session
  if (correctZKMode !== storedZKMode && (zkCheck.hasActiveSession || normalCheck.hasActiveSession)) {
    console.log(`[Bootstrap] Mode mismatch with active session! Correcting: ${storedZKMode} → ${correctZKMode}`);
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
