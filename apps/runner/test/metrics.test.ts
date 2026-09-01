/**
 * Runner metrics (§64): the outcome classification, what one finished run records, and that the
 * scrape endpoint serves the Prometheus text format.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRunResult } from '@nexus/integrations';

import {
  concurrentRuns,
  observeRun,
  outcomeOf,
  registry,
  startMetricsServer,
  withRunSlot,
} from '../src/metrics.ts';

const result = (over: Partial<RawRunResult> = {}): RawRunResult => ({
  runId: 'run_1',
  status: 'succeeded',
  exitCode: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:12.000Z',
  durationMs: 12_000,
  artifacts: [],
  stats: { bytesOut: 2_048, egressRequests: 3, egressDenied: 0, peakMemMiB: 64 },
  ...over,
});

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

describe('outcomeOf', () => {
  it('treats a partial run as a success — it produced entities', () => {
    expect(outcomeOf('succeeded', undefined)).toBe('success');
    expect(outcomeOf('partial', undefined)).toBe('success');
  });

  it('classifies timeouts from the status and from the error code', () => {
    expect(outcomeOf('timed_out', undefined)).toBe('timeout');
    expect(outcomeOf('failed', 'START_TIMEOUT')).toBe('timeout');
    expect(outcomeOf('failed', 'IMAGE_PULL_TIMEOUT')).toBe('timeout');
  });

  it('separates resource limits from policy blocks', () => {
    expect(outcomeOf('failed', 'OOM_KILLED')).toBe('resource_limit');
    expect(outcomeOf('failed', 'OUTPUT_TOO_LARGE')).toBe('resource_limit');
    expect(outcomeOf('failed', 'EGRESS_DENIED')).toBe('blocked');
    expect(outcomeOf('failed', 'CONSENT_REQUIRED')).toBe('blocked');
  });

  it('falls back to failed for unclassified codes and for cancellation', () => {
    expect(outcomeOf('failed', 'TOOL_EXIT_NONZERO')).toBe('failed');
    expect(outcomeOf('failed', undefined)).toBe('failed');
    expect(outcomeOf('cancelled', 'CANCELLED')).toBe('failed');
  });
});

describe('observeRun', () => {
  it('records the outcome, the duration in seconds and the output size', async () => {
    observeRun('sherlock', result());

    expect(await sample('raven_runs_total', { tool: 'sherlock', status: 'success' })).toBe(1);
    expect(await sample('raven_run_duration_seconds_sum', { tool: 'sherlock' })).toBe(12);
    expect(await sample('raven_run_output_bytes_sum', { tool: 'sherlock' })).toBe(2_048);
  });

  it('counts denied egress as network sandbox violations', async () => {
    observeRun(
      'spiderfoot',
      result({
        stats: { bytesOut: 0, egressRequests: 5, egressDenied: 2, peakMemMiB: 12 },
      }),
    );

    expect(await sample('raven_runner_sandbox_violations_total', { kind: 'network' })).toBe(2);
  });

  it('counts a sandbox violation of the kind the error reported', async () => {
    observeRun(
      'sherlock',
      result({
        status: 'failed',
        error: {
          code: 'SANDBOX_VIOLATION',
          what: 'blocked',
          why: 'wrote outside the sandbox',
          action: 'freeze the image',
          retryable: false,
          detail: { kind: 'filesystem' },
        },
      }),
    );

    expect(await sample('raven_runner_sandbox_violations_total', { kind: 'filesystem' })).toBe(1);
    expect(await sample('raven_runs_total', { tool: 'sherlock', status: 'blocked' })).toBe(1);
  });

  it('ignores a violation kind that is not one of the four sandbox dimensions', async () => {
    observeRun(
      'sherlock',
      result({
        status: 'failed',
        error: {
          code: 'SANDBOX_VIOLATION',
          what: 'blocked',
          why: 'unknown dimension',
          action: 'investigate',
          retryable: false,
          detail: { kind: 'telepathy' },
        },
      }),
    );

    expect(await sample('raven_runner_sandbox_violations_total', {})).toBe(0);
  });
});

describe('withRunSlot', () => {
  it('releases the concurrency gauge on both paths', async () => {
    let peak = 0;
    await withRunSlot(async () => {
      peak = (await concurrentRuns.get()).values[0]?.value ?? 0;
    });
    expect(peak).toBe(1);
    expect((await concurrentRuns.get()).values[0]?.value).toBe(0);

    await expect(withRunSlot(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect((await concurrentRuns.get()).values[0]?.value).toBe(0);
  });
});

describe('startMetricsServer', () => {
  it('serves the registry on its own port and nothing else', async () => {
    const server = await startMetricsServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('raven_runs_total');

      const other = await fetch(`http://127.0.0.1:${String(server.port)}/`);
      expect(other.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
