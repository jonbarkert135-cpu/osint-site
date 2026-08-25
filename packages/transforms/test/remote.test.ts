import { describe, expect, it } from 'vitest';

import type { AdapterInput } from '../src/adapters.ts';
import { createRemoteQueue } from '../src/remote.ts';

const input = (engineId = 'e'): AdapterInput => ({
  engineId,
  capability: 'c',
  payload: {},
  timeoutMs: 1000,
});

describe('remote execution queue (§36)', () => {
  it('queues a job and reports depth', () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    expect(job.state).toBe('queued');
    expect(queue.depth()).toBe(1);
  });

  it('hands the oldest job to a claiming worker', () => {
    const queue = createRemoteQueue();
    queue.enqueue(input('first'));
    queue.enqueue(input('second'));
    const claimed = queue.claim('worker-1');
    expect(claimed?.input.engineId).toBe('first');
    expect(claimed?.claimedBy).toBe('worker-1');
    expect(queue.depth()).toBe(1);
  });

  it('returns null when there is nothing to claim', () => {
    expect(createRemoteQueue().claim('worker-1')).toBeNull();
  });

  it('records a result posted back through the Result API', () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    queue.claim('worker-1');
    const done = queue.complete(job.id, { ok: true, output: { items: [{ a: 1 }] } });
    expect(done?.state).toBe('done');
    expect(queue.get(job.id)?.result?.ok).toBe(true);
  });

  it('marks a failed result as failed, not done', () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    const failed = queue.complete(job.id, {
      ok: false,
      error: { kind: 'upstream', message: 'boom', retryable: true },
    });
    expect(failed?.state).toBe('failed');
  });

  it('ignores completion for an unknown job', () => {
    expect(createRemoteQueue().complete('nope', { ok: true, output: { items: [] } })).toBeNull();
  });

  it('falls back to local execution when no worker claims in time', () => {
    let clock = 0;
    const queue = createRemoteQueue({ claimTimeoutMs: 100, now: () => clock });
    const job = queue.enqueue(input());
    expect(queue.shouldFallBackLocally(job.id)).toBe(false);
    clock = 150;
    expect(queue.shouldFallBackLocally(job.id)).toBe(true);
    expect(queue.expireStale().map((expired) => expired.id)).toEqual([job.id]);
    expect(queue.get(job.id)?.state).toBe('expired');
  });

  it('does not fall back once a worker has claimed the job', () => {
    let clock = 0;
    const queue = createRemoteQueue({ claimTimeoutMs: 100, now: () => clock });
    const job = queue.enqueue(input());
    queue.claim('worker-1');
    clock = 999;
    expect(queue.shouldFallBackLocally(job.id)).toBe(false);
  });

  it('treats an unknown job as a local fallback', () => {
    expect(createRemoteQueue().shouldFallBackLocally('missing')).toBe(true);
  });

  it('stays bounded so a stuck worker cannot leak memory', () => {
    const queue = createRemoteQueue({ maxJobs: 3 });
    for (let i = 0; i < 10; i += 1) queue.enqueue(input(`e${i}`));
    expect(queue.list()).toHaveLength(3);
  });
});
