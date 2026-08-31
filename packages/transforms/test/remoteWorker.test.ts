import { describe, expect, it } from 'vitest';

import type { AdapterInput, AdapterResult } from '../src/adapters.ts';
import { createRemoteQueue } from '../src/remote.ts';
import { createRemoteWorker } from '../src/remoteWorker.ts';

const input = (engineId = 'e'): AdapterInput => ({
  engineId,
  capability: 'c',
  payload: {},
  timeoutMs: 1000,
});

const ok = (engineId: string): AdapterResult => ({
  ok: true,
  output: { items: [{ engineId }] },
});

describe('external worker (§36)', () => {
  it('claims a job, runs it and posts the result back', async () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input('subfinder'));
    const worker = createRemoteWorker({
      workerId: 'worker-1',
      transport: { claim: queue.claim, complete: queue.complete },
      execute: async (job) => ok(job.engineId),
    });

    expect((await worker.runOnce())?.id).toBe(job.id);
    const stored = queue.get(job.id);
    expect(stored?.state).toBe('done');
    expect(stored?.claimedBy).toBe('worker-1');
  });

  it('returns null when there is nothing to claim', async () => {
    const queue = createRemoteQueue();
    const worker = createRemoteWorker({
      workerId: 'worker-1',
      transport: { claim: queue.claim, complete: queue.complete },
      execute: async () => ok('never'),
    });
    expect(await worker.runOnce()).toBeNull();
  });

  it('turns a thrown execution into a retryable failure instead of stopping', async () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    const worker = createRemoteWorker({
      workerId: 'worker-1',
      transport: { claim: queue.claim, complete: queue.complete },
      execute: () => {
        throw new Error('docker is gone');
      },
    });

    await worker.runOnce();
    const stored = queue.get(job.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.result?.ok).toBe(false);
    expect(stored?.result?.ok === false && stored.result.error).toEqual({
      kind: 'internal',
      message: 'docker is gone',
      retryable: true,
    });
  });

  it('reports a non-Error throw as a string', async () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    const worker = createRemoteWorker({
      workerId: 'worker-1',
      transport: { claim: queue.claim, complete: queue.complete },
      execute: () => Promise.reject('nope'),
    });

    await worker.runOnce();
    const result = queue.get(job.id)?.result;
    expect(result?.ok === false && result.error.message).toBe('nope');
  });

  it('drains the queue and notifies the host per job', async () => {
    const queue = createRemoteQueue();
    queue.enqueue(input('a'));
    queue.enqueue(input('b'));
    queue.enqueue(input('c'));
    const seen: string[] = [];
    const worker = createRemoteWorker({
      workerId: 'worker-1',
      transport: { claim: queue.claim, complete: queue.complete },
      execute: async (job) => ok(job.engineId),
      onDone: (job) => seen.push(job.input.engineId),
    });

    expect(await worker.drain()).toBe(3);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(queue.depth()).toBe(0);
  });

  it('stops draining at maxJobs so one worker cannot hog the box', async () => {
    const queue = createRemoteQueue();
    queue.enqueue(input('a'));
    queue.enqueue(input('b'));
    const worker = createRemoteWorker({
      workerId: 'worker-1',
      transport: { claim: queue.claim, complete: queue.complete },
      execute: async (job) => ok(job.engineId),
    });

    expect(await worker.drain(1)).toBe(1);
    expect(queue.depth()).toBe(1);
  });

  it('works over an async transport, not just the in-process queue', async () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input('remote'));
    const worker = createRemoteWorker({
      workerId: 'worker-2',
      transport: {
        claim: async (workerId) => queue.claim(workerId),
        complete: async (jobId, result) => queue.complete(jobId, result),
      },
      execute: async (job) => ok(job.engineId),
    });

    await worker.runOnce();
    expect(queue.get(job.id)?.state).toBe('done');
  });
});
