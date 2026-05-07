/**
 * Process-global concurrency limiter for /preview fetches.
 *
 * Caps total in-flight preview requests across all <FileThumbnail/> instances
 * at MAX_PREVIEW_FETCHES. Surplus tasks queue FIFO and pick up slots as
 * in-flight tasks finish (success, error, or AbortError).
 *
 * The cap matches the backend semaphore (PREVIEW_GENERATION_CONCURRENCY=2)
 * at a small multiple — keeps the backend's slots full without bursting.
 *
 * Component-lifecycle safety is the CALLER's responsibility:
 * - Pass a closure that respects an AbortController.signal so unmount-aborts
 *   release the slot quickly.
 * - Guard setState calls inside the closure with a `mounted` flag (existing
 *   pattern in FileThumbnail; the limiter does not introspect React state).
 */

export const MAX_PREVIEW_FETCHES = 4;

let activeCount = 0;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_PREVIEW_FETCHES) {
    activeCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      activeCount += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeCount -= 1;
  const next = queue.shift();
  if (next) next();
}

/**
 * Run a preview-fetch task under the global concurrency cap.
 *
 * The slot is always released — even if the task throws (including
 * AbortError) — so a failed/cancelled task cannot stall the queue.
 *
 * @param task Closure that performs the fetch (and any timeout setup that
 *   should NOT begin until a slot is acquired). Must be idempotent if the
 *   caller may invoke `runPreviewRequest` again on retry.
 */
export async function runPreviewRequest<T>(
  task: () => Promise<T>,
): Promise<T> {
  await acquireSlot();
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

// ---------------------------------------------------------------------------
// Test-only escape hatches.
// Underscore-prefixed; consumed exclusively by previewRequestLimiter.test.ts.
// Calling these from production code is undefined behavior — they exist to
// let unit tests inspect/reset module state without exposing internal
// queue/active variables.
// ---------------------------------------------------------------------------

export function _getActiveCountForTest(): number {
  return activeCount;
}

export function _getQueueDepthForTest(): number {
  return queue.length;
}

export function _resetForTest(): void {
  activeCount = 0;
  queue.length = 0;
}
