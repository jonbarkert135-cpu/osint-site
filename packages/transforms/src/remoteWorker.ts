/**
 * External worker for the remote execution queue — Part 2 §36.
 *
 *   Core → Remote Execution Queue → External Worker → Result API → Core
 *
 * This is the worker half, and it is deliberately transport-blind: `claim` and `complete` are
 * injected, so the same loop drives an in-process queue (tests, single-box runs) or an HTTP
 * Result API on another machine. No timers, no process API, no fetch — the file stays importable
 * from the browser bundle (N2) and adds no dependency.
 */

import type { AdapterInput, AdapterResult } from './adapters.ts';
import type { RemoteJob } from './remote.ts';

export interface RemoteWorkerTransport {
  /** Ask the queue for work. Returns null when there is nothing to take. */
  readonly claim: (workerId: string) => Promise<RemoteJob | null> | RemoteJob | null;
  /** Post the result back to the Result API. */
  readonly complete: (jobId: string, result: AdapterResult) => unknown;
}

export interface RemoteWorkerOptions {
  readonly workerId: string;
  readonly transport: RemoteWorkerTransport;
  /** Runs one job. Whatever confinement the worker host has is applied here, not in this file. */
  readonly execute: (input: AdapterInput) => Promise<AdapterResult>;
  /** Called after each job; a host can log or count. */
  readonly onDone?: (job: RemoteJob, result: AdapterResult) => void;
}

export interface RemoteWorker {
  /** Claims and runs one job. Returns the job it handled, or null when the queue was empty. */
  readonly runOnce: () => Promise<RemoteJob | null>;
  /** Drains the queue until it is empty (or `maxJobs` jobs are done). Returns the count. */
  readonly drain: (maxJobs?: number) => Promise<number>;
}

const DEFAULT_DRAIN_LIMIT = 100;

export const createRemoteWorker = (options: RemoteWorkerOptions): RemoteWorker => {
  const runOnce = async (): Promise<RemoteJob | null> => {
    const job = await options.transport.claim(options.workerId);
    if (job === null) return null;

    // A worker that throws is a worker that stops draining, so a crash becomes a typed failure
    // the core can see and retry (U5, partial beats perfect).
    let result: AdapterResult;
    try {
      result = await options.execute(job.input);
    } catch (error) {
      result = {
        ok: false,
        error: {
          kind: 'internal',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }

    await options.transport.complete(job.id, result);
    options.onDone?.(job, result);
    return job;
  };

  return {
    runOnce,
    drain: async (maxJobs = DEFAULT_DRAIN_LIMIT) => {
      let done = 0;
      while (done < maxJobs) {
        if ((await runOnce()) === null) break;
        done += 1;
      }
      return done;
    },
  };
};
