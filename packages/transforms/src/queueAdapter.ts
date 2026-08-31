/**
 * Queue-backed adapter — the core half of Part 2 §36.
 *
 *   Core → Remote Execution Queue → External Worker → Result API → Core
 *
 * `createRemoteQueue` holds the jobs and `createRemoteWorker` drains them; this is the piece that
 * lets a plan step use them without knowing they exist: an ordinary `EngineAdapter` that enqueues
 * instead of executing. With no worker attached the job stays unclaimed and the call falls back to
 * the local adapter, so a single box keeps working (N2, local-first).
 *
 * No timers and no fetch here on purpose: *when* a worker gets its chance is the host's business,
 * injected as `settle`. That keeps the file browser-safe and the behaviour testable without clocks.
 */

import type { AdapterResult, EngineAdapter } from './adapters.ts';
import type { RemoteQueue } from './remote.ts';
import type { EngineRuntime } from './types.ts';

export interface QueueAdapterOptions {
  readonly queue: RemoteQueue;
  /** Runtime this adapter answers for; the queue itself is runtime-blind. */
  readonly runtime: EngineRuntime;
  /** Used when nobody claimed the job. Omitted means: report the engine as unavailable. */
  readonly local?: EngineAdapter;
  /** Gives an attached worker its turn (drain a loop, await an HTTP round trip). */
  readonly settle?: () => unknown;
}

const UNCLAIMED: AdapterResult = {
  ok: false,
  error: {
    kind: 'unavailable',
    message: 'no worker claimed the job and no local adapter is configured',
    retryable: true,
  },
};

export const createQueueAdapter = (options: QueueAdapterOptions): EngineAdapter => ({
  runtime: options.runtime,

  // Available whenever the queue can take work: a local-only host still answers through `local`.
  available: () => options.local?.available() ?? true,

  execute: async (input, onProgress) => {
    const job = options.queue.enqueue(input);
    onProgress?.({ fraction: null, message: `queued as ${job.id}` });
    await options.settle?.();

    const settled = options.queue.get(job.id);
    if (settled?.result !== undefined) return settled.result;

    // Still unclaimed (or expired): run it here rather than making the analyst wait for a worker
    // that may never arrive — U5, partial beats perfect.
    return options.local === undefined ? UNCLAIMED : options.local.execute(input, onProgress);
  },
});
