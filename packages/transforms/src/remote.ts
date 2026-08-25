/**
 * Remote execution queue — Part 2 §36.
 *
 *   Core → Remote Execution Queue → External Worker → Result API → Core
 *
 * The point of this file is the *option*, not the dependency: with no worker attached the queue
 * reports every job as `unclaimed` and the caller falls back to local execution. Raven must stay
 * fully usable on one box (invariant N2, local-first).
 */

import type { AdapterInput, AdapterResult } from './adapters.ts';

export type RemoteJobState = 'queued' | 'claimed' | 'done' | 'failed' | 'expired';

export interface RemoteJob {
  readonly id: string;
  readonly input: AdapterInput;
  readonly state: RemoteJobState;
  readonly enqueuedAt: number;
  readonly claimedBy?: string;
  readonly claimedAt?: number;
  readonly result?: AdapterResult;
}

export interface RemoteQueueOptions {
  /** A job nobody claims within this window falls back to local execution. */
  readonly claimTimeoutMs?: number;
  readonly now?: () => number;
  readonly maxJobs?: number;
}

const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_JOBS = 500;

export interface RemoteQueue {
  readonly enqueue: (input: AdapterInput) => RemoteJob;
  /** Called by an external worker. Returns the oldest queued job it can take, or null. */
  readonly claim: (workerId: string) => RemoteJob | null;
  /** The Result API endpoint: a worker posts back here. */
  readonly complete: (jobId: string, result: AdapterResult) => RemoteJob | null;
  readonly get: (jobId: string) => RemoteJob | undefined;
  readonly list: () => readonly RemoteJob[];
  /** True when a job has waited past the claim timeout — the caller should run it locally. */
  readonly shouldFallBackLocally: (jobId: string) => boolean;
  readonly expireStale: () => readonly RemoteJob[];
  readonly depth: () => number;
}

export const createRemoteQueue = (options: RemoteQueueOptions = {}): RemoteQueue => {
  const claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const now = options.now ?? (() => Date.now());
  const jobs = new Map<string, RemoteJob>();
  let sequence = 0;

  const put = (job: RemoteJob): RemoteJob => {
    jobs.set(job.id, job);
    // Bounded on purpose: an unbounded queue on a single VPS is a memory leak with a nice name.
    while (jobs.size > maxJobs) {
      const oldest = jobs.keys().next();
      if (oldest.done) break;
      jobs.delete(oldest.value);
    }
    return job;
  };

  return {
    enqueue: (input) =>
      put({
        id: `job-${++sequence}`,
        input,
        state: 'queued',
        enqueuedAt: now(),
      }),

    claim: (workerId) => {
      for (const job of jobs.values()) {
        if (job.state !== 'queued') continue;
        return put({ ...job, state: 'claimed', claimedBy: workerId, claimedAt: now() });
      }
      return null;
    },

    complete: (jobId, result) => {
      const job = jobs.get(jobId);
      if (!job || job.state === 'done' || job.state === 'expired') return null;
      return put({ ...job, state: result.ok ? 'done' : 'failed', result });
    },

    get: (jobId) => jobs.get(jobId),

    list: () => [...jobs.values()],

    shouldFallBackLocally: (jobId) => {
      const job = jobs.get(jobId);
      if (!job) return true;
      if (job.state !== 'queued') return false;
      return now() - job.enqueuedAt >= claimTimeoutMs;
    },

    expireStale: () => {
      const expired: RemoteJob[] = [];
      for (const job of jobs.values()) {
        if (job.state === 'queued' && now() - job.enqueuedAt >= claimTimeoutMs) {
          expired.push(put({ ...job, state: 'expired' }));
        }
      }
      return expired;
    },

    depth: () => [...jobs.values()].filter((job) => job.state === 'queued').length,
  };
};
