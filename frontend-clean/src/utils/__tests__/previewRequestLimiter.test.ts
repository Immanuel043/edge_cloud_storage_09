import { describe, it, expect, beforeEach } from 'vitest';
import {
  runPreviewRequest,
  MAX_PREVIEW_FETCHES,
  _getActiveCountForTest,
  _getQueueDepthForTest,
  _resetForTest,
} from '../previewRequestLimiter';

// A "deferred" — like Promise.withResolvers but compatible with older targets.
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Yield the microtask queue enough times for any pending continuations to run.
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('previewRequestLimiter', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('caps in-flight tasks at MAX_PREVIEW_FETCHES', async () => {
    expect(MAX_PREVIEW_FETCHES).toBe(4);

    // Spawn 16 tasks; each waits on its own gate.
    const gates = Array.from({ length: 16 }, () => deferred());
    const promises = gates.map((g) => runPreviewRequest(() => g.promise));

    await flushMicrotasks();

    // First 4 are running; remaining 12 are queued.
    expect(_getActiveCountForTest()).toBe(4);
    expect(_getQueueDepthForTest()).toBe(12);

    // Resolve gates one at a time and confirm the cap holds.
    for (let i = 0; i < 16; i++) {
      gates[i]!.resolve();
      await flushMicrotasks();
      // Active count never exceeds the cap.
      expect(_getActiveCountForTest()).toBeLessThanOrEqual(
        MAX_PREVIEW_FETCHES,
      );
    }

    await Promise.all(promises);
    expect(_getActiveCountForTest()).toBe(0);
    expect(_getQueueDepthForTest()).toBe(0);
  });

  it('admits queued tasks in FIFO order', async () => {
    // 8 tasks, each records its index in `started` when its body begins,
    // then waits on its gate. We assert admission order, NOT completion
    // order — completion depends on which gates we resolve in which order.
    const started: number[] = [];
    const gates = Array.from({ length: 8 }, () => deferred());

    const promises = gates.map((g, i) =>
      runPreviewRequest(async () => {
        started.push(i);
        await g.promise;
      }),
    );

    await flushMicrotasks();
    // First 4 should have started; tasks 4-7 are queued.
    expect(started).toEqual([0, 1, 2, 3]);

    // Resolve task 0 → slot 0 frees → task 4 starts (next in FIFO queue).
    gates[0]!.resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    // Resolve task 1 → task 5 starts.
    gates[1]!.resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    // Resolve task 2 → task 6 starts. Note we resolved task 1 before task 2,
    // but admission order is purely by spawn order, which this asserts.
    gates[2]!.resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // Resolve task 3 → task 7 starts.
    gates[3]!.resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // Drain the rest.
    for (let i = 4; i < 8; i++) gates[i]!.resolve();

    await Promise.all(promises);
    expect(_getActiveCountForTest()).toBe(0);
    expect(_getQueueDepthForTest()).toBe(0);
  });

  it('releases slots when tasks reject (generic Error)', async () => {
    // 8 tasks; every other one rejects.
    const gates = Array.from({ length: 8 }, () => deferred<void>());
    const promises = gates.map((g, i) =>
      runPreviewRequest(async () => {
        await g.promise;
        if (i % 2 === 1) throw new Error(`task ${i} failed`);
        return i;
      }),
    );

    await flushMicrotasks();
    expect(_getActiveCountForTest()).toBe(4);
    expect(_getQueueDepthForTest()).toBe(4);

    // Resolve all gates; the rejecting tasks must still release their slots
    // so the queued tasks 4..7 can run.
    gates.forEach((g) => g.resolve());
    const results = await Promise.allSettled(promises);

    expect(results).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      const r = results[i]!;
      if (i % 2 === 1) {
        expect(r.status).toBe('rejected');
      } else {
        expect(r.status).toBe('fulfilled');
      }
    }
    expect(_getActiveCountForTest()).toBe(0);
    expect(_getQueueDepthForTest()).toBe(0);
  });

  it('releases slots when tasks reject with AbortError (real-world cancel)', async () => {
    // Simulate the most common cancellation path: AbortController.abort()
    // causes fetch to reject with DOMException 'AbortError'.
    const gates = Array.from({ length: 8 }, () => deferred<void>());
    const promises = gates.map((g, i) =>
      runPreviewRequest(async () => {
        await g.promise;
        if (i % 2 === 1) {
          // DOMException is available in jsdom; use a fallback Error
          // shape if the test environment lacks it.
          const DomExc =
            typeof DOMException !== 'undefined' ? DOMException : Error;
          throw new DomExc('aborted', 'AbortError');
        }
        return i;
      }),
    );

    await flushMicrotasks();
    expect(_getActiveCountForTest()).toBe(4);
    expect(_getQueueDepthForTest()).toBe(4);

    gates.forEach((g) => g.resolve());
    const results = await Promise.allSettled(promises);

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(_getActiveCountForTest()).toBe(0);
    expect(_getQueueDepthForTest()).toBe(0);
  });

  it('_resetForTest restores counters even if tasks are still queued', async () => {
    // Document the test-fixture behavior: a stalled test (with unresolved
    // gates) leaves counters non-zero, but _resetForTest brings them back.
    const gates = Array.from({ length: 8 }, () => deferred<void>());
    gates.forEach((g) => runPreviewRequest(() => g.promise));
    await flushMicrotasks();

    expect(_getActiveCountForTest()).toBe(4);
    expect(_getQueueDepthForTest()).toBe(4);

    _resetForTest();

    expect(_getActiveCountForTest()).toBe(0);
    expect(_getQueueDepthForTest()).toBe(0);
  });
});
