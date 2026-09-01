/**
 * Job metrics (§64): the handler wrapper (duration, failures, retries), the queue-depth poller and
 * the scrape endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  jobFailures,
  jobRetries,
  measureJob,
  pollQueueDepth,
  queueDepth,
  reasonOf,
  registry,
  startMetricsServer,
} from '../src/metrics.ts';

const sample = async (name: string, labels: Record<string, string>): Promise<number> => {
  const text = await registry.metrics();
  const wanted = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const line = text
    .split('\n')
    .find((row) => row.startsWith(`${name}{`) && (wanted === '' || row.includes(wanted)));
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
};

beforeEach(() => {
  registry.resetMetrics();
});

describe('reasonOf', () => {
  it('prefers a short error code and falls back to the error name', () => {
    const coded = Object.assign(new Error('nope'), { code: 'EGRESS_DENIED' });
    expect(reasonOf(coded)).toBe('EGRESS_DENIED');
    expect(reasonOf(new TypeError('bad'))).toBe('TypeError');
    expect(reasonOf('a string')).toBe('unknown');
  });

  it('drops a code that would explode label cardinality', () => {
    const long = Object.assign(new Error('nope'), { code: 'x'.repeat(200) });
    expect(reasonOf(long)).toBe('Error');
  });
});

describe('measureJob', () => {
  it('times a successful job and returns its value', async () => {
    const value = await measureJob('integration.parse', { name: 'integration.parse' }, () =>
      Promise.resolve('ok'),
    );

    expect(value).toBe('ok');
    expect(
      await sample('raven_job_duration_seconds_count', {
        queue: 'integration.parse',
        job: 'integration.parse',
      }),
    ).toBe(1);
    expect(await sample('raven_job_failures_total', {})).toBe(0);
  });

  it('counts a failure by reason and re-throws so BullMQ still retries', async () => {
    await expect(
      measureJob('github', { name: 'github.hydrate' }, () =>
        Promise.reject(Object.assign(new Error('x'), { code: 'GH_RATE_LIMIT' })),
      ),
    ).rejects.toThrow('x');

    expect(
      await sample('raven_job_failures_total', { queue: 'github', job: 'github.hydrate' }),
    ).toBe(1);
    expect(await jobFailures.get().then((m) => m.values.length)).toBe(1);
  });

  it('counts a retry only when this is not the first attempt', async () => {
    await measureJob('ai.embed', { name: 'ai.embed', attemptsMade: 0 }, () => Promise.resolve(1));
    expect(await jobRetries.get().then((m) => m.values.length)).toBe(0);

    await measureJob('ai.embed', { name: 'ai.embed', attemptsMade: 2 }, () => Promise.resolve(1));
    expect(await sample('raven_job_retries_total', { queue: 'ai.embed' })).toBe(1);
  });

  it('labels an unnamed job with its queue', async () => {
    await measureJob('watchers', {}, () => Promise.resolve(1));
    expect(
      await sample('raven_job_duration_seconds_count', { queue: 'watchers', job: 'watchers' }),
    ).toBe(1);
  });
});

describe('pollQueueDepth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets the gauge to waiting plus delayed and stops when told to', async () => {
    vi.useFakeTimers();
    const getJobCounts = vi.fn(() => Promise.resolve({ waiting: 4, delayed: 3 }));
    const stop = pollQueueDepth([{ name: 'github', getJobCounts }], 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await sample('raven_queue_depth', { queue: 'github' })).toBe(7);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJobCounts).toHaveBeenCalledTimes(1);
    expect(await queueDepth.get().then((m) => m.values.length)).toBe(1);
  });

  it('reports a failing poll instead of crashing the worker', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const stop = pollQueueDepth(
      [{ name: 'github', getJobCounts: () => Promise.reject(new Error('redis down')) }],
      1_000,
      onError,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledOnce();
    stop();
  });

  it('treats a queue with no counts as empty', async () => {
    vi.useFakeTimers();
    const stop = pollQueueDepth(
      [{ name: 'watchers', getJobCounts: () => Promise.resolve({}) }],
      1_000,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await sample('raven_queue_depth', { queue: 'watchers' })).toBe(0);
    stop();
  });
});

describe('startMetricsServer', () => {
  it('serves the registry on its own port and nothing else', async () => {
    const server = await startMetricsServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('raven_queue_depth');

      const other = await fetch(`http://127.0.0.1:${String(server.port)}/`);
      expect(other.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
