/**
 * Thrown when the server status check returns a transient/ambiguous result
 * (network failure, 500, 503, etc.) and the upload checkpoint should be preserved.
 * Treated as retriable in the Dashboard UI — same as network errors.
 */
export class TransientUploadError extends Error {
  readonly transient = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'TransientUploadError';
  }
}
