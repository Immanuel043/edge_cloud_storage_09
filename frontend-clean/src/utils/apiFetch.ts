/**
 * Thin fetch wrapper that signals authenticated-session expiry.
 *
 * On any 401 it dispatches an `auth:session-expired` CustomEvent on the
 * window. The active AuthContext owns the actual response (logout + redirect
 * + toast) and gates on isAuthenticated, so 401s from `/auth/login` while
 * already logged out are harmless.
 *
 * Callers receive the original Response unchanged.
 */
export const SESSION_EXPIRED_EVENT = 'auth:session-expired';

export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && typeof window !== 'undefined') {
    const url = typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : String(input);
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url } }));
  }
  return response;
}
