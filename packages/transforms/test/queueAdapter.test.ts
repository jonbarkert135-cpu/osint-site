import { describe, expect, it } from 'vitest';

import type { AdapterInput, AdapterResult, EngineAdapter } from '../src/adapters.ts';
import { createQueueAdapter } from '../src/queueAdapter.ts';
import { createRemoteQueue } from '../src/remote.ts';
import { createRemoteWorker } from '../src/remoteWorker.ts';

const input: AdapterInput = {
  engineId: 'subfinder',
  capability: 'subdomain-discovery',
  payload: { domain: 'example.com' },
  timeoutMs: 1_000,
};

const localAdapter = (result: AdapterResult): EngineAdapter => ({
  runtime: 'cli',
  available: () => true,
  execute: async () => result,
});

const ok = (value: string): AdapterResult => ({ ok: true, output: { items: [{ host: value }] } });

describe('queue-backed adapter (§36)', () => {
  it('returns what the worker produced', async () => {
    const queue = createRemoteQueue();
    const worker = createRemoteWorker({
      workerId: 'w1',
      transport: { claim: (id) => queue.claim(id), complete: (id, r) => queue.complete(id, r) },
      execute: async () => ok('remote.example.com'),
    });
    const adapter = createQueueAdapter({
      queue,
      runtime: 'cli',
      local: localAdapter(ok('local.example.com')),
      settle: () => worker.drain(),
    });

    const result = await adapter.execute(input);
    expect(result).toEqual(ok('remote.example.com'));
  });

  it('falls back to the local adapter when nobody claims the job', async () => {
    const queue = createRemoteQueue();
    const adapter = createQueueAdapter({
      queue,
      runtime: 'cli',
      local: localAdapter(ok('local.example.com')),
    });

    expect(await adapter.execute(input)).toEqual(ok('local.example.com'));
  });

  it('reports unavailable, retryable when there is no local fallback either', async () => {
    const adapter = createQueueAdapter({ queue: createRemoteQueue(), runtime: 'cli' });
    const result = await adapter.execute(input);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: expect.any(String), retryable: true },
    });
  });

  it('keeps a worker failure instead of silently retrying it locally', async () => {
    const queue = createRemoteQueue();
    const failure: AdapterResult = {
      ok: false,
      error: { kind: 'upstream', message: 'tool exited 2', retryable: false },
    };
    const worker = createRemoteWorker({
      workerId: 'w1',
      transport: { claim: (id) => queue.claim(id), complete: (id, r) => queue.complete(id, r) },
      execute: async () => failure,
    });
    const adapter = createQueueAdapter({
      queue,
      runtime: 'cli',
      local: localAdapter(ok('local.example.com')),
      settle: () => worker.drain(),
    });

    expect(await adapter.execute(input)).toEqual(failure);
  });

  it('reports the job id as progress and availability from the local adapter', async () => {
    const queue = createRemoteQueue();
    const adapter = createQueueAdapter({
      queue,
      runtime: 'cli',
      local: { runtime: 'cli', available: () => false, execute: async () => ok('x') },
    });
    const messages: string[] = [];
    await adapter.execute(input, (progress) => messages.push(progress.message ?? ''));
    expect(messages[0]).toContain('job-1');
    expect(adapter.available()).toBe(false);
  });
});
