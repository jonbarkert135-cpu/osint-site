import { describe, expect, it } from 'vitest';
import type { RunRecord, RunStatus } from '@nexus/transforms';

import {
  applyAction,
  DEFAULT_POLICY,
  engineHealth,
  HEALTH_LABEL,
  healthReport,
  retryTargets,
  runIsUsable,
} from '../src/health.ts';

let seq = 0;

const run = (engine: string, status: RunStatus, over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: `run-${String((seq += 1))}`,
    transform: 'demo.transform',
    transformVersion: '1.0.0',
    input: { kind: 'domain', value: 'example.com' },
    engine,
    engineVersion: '1.0.0',
    provider: 'local-runtime',
    mode: 'zero-credential',
    startedAt: seq * 1_000,
    finishedAt: seq * 1_000 + 200,
    status,
    results: [],
    errors: [],
    ...over,
  }) as RunRecord;

describe('engineHealth', () => {
  it('reports unknown when the engine has never run', () => {
    const health = engineHealth('sherlock', { runs: [] });
    expect(health.state).toBe('unknown');
    expect(health.runs).toBe(0);
    expect(health.responseMs).toBe(0);
    expect(HEALTH_LABEL[health.state]).toBe('Not run yet');
  });

  it('counts a queued step as online even before the first record', () => {
    expect(engineHealth('sherlock', { runs: [], queued: 2 }).state).toBe('online');
  });

  it('is online when every run completed', () => {
    const health = engineHealth('sherlock', {
      runs: [run('sherlock', 'completed'), run('sherlock', 'completed')],
    });
    expect(health.state).toBe('online');
    expect(health.successRate).toBe(1);
    expect(health.responseMs).toBe(200);
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it('treats a partial run as degraded, not failed', () => {
    const health = engineHealth('spiderfoot', { runs: [run('spiderfoot', 'partial')] });
    expect(health.state).toBe('degraded');
    expect(health.failures).toBe(0);
  });

  it('goes offline after a streak of failures and counts timeouts', () => {
    const runs = [
      run('spiderfoot', 'completed'),
      run('spiderfoot', 'failed', { errors: ['timed out after 30000ms'] }),
      run('spiderfoot', 'failed', { errors: ['timed out'] }),
      run('spiderfoot', 'failed', { errors: ['socket hang up'] }),
      run('spiderfoot', 'failed', { errors: ['deadline exceeded'] }),
    ];
    const health = engineHealth('spiderfoot', { runs });
    expect(health.state).toBe('offline');
    expect(health.consecutiveFailures).toBe(4);
    expect(health.timeouts).toBe(3);
    expect(health.lastFailureAt).not.toBeNull();
  });

  it('ignores runs from other engines', () => {
    const health = engineHealth('github', {
      runs: [run('sherlock', 'failed'), run('github', 'completed')],
    });
    expect(health.runs).toBe(1);
    expect(health.state).toBe('online');
  });

  it('honours policy over history', () => {
    const runs = [run('sherlock', 'completed')];
    expect(
      engineHealth('sherlock', { runs, policy: { ...DEFAULT_POLICY, disabled: true } }).state,
    ).toBe('disabled');
    expect(
      engineHealth('sherlock', { runs, policy: { ...DEFAULT_POLICY, ignored: true } }).state,
    ).toBe('ignored');
  });
});

describe('healthReport', () => {
  it('returns one row per engine, in the order asked for', () => {
    const runs = [run('sherlock', 'completed'), run('spiderfoot', 'failed')];
    const report = healthReport(['sherlock', 'spiderfoot', 'github'], runs, {}, { github: 1 });
    expect(report.map((row) => row.engine)).toEqual(['sherlock', 'spiderfoot', 'github']);
    expect(report.map((row) => row.state)).toEqual(['online', 'degraded', 'online']);
  });

  it('keeps the run usable while one engine is dead (§29)', () => {
    const runs = [
      run('sherlock', 'completed'),
      run('spiderfoot', 'failed'),
      run('spiderfoot', 'failed'),
      run('spiderfoot', 'failed'),
      run('spiderfoot', 'failed'),
    ];
    const report = healthReport(['sherlock', 'spiderfoot'], runs);
    expect(report[1]?.state).toBe('offline');
    expect(runIsUsable(report)).toBe(true);
  });

  it('is unusable only when nothing can serve', () => {
    expect(
      runIsUsable(
        healthReport(['sherlock'], [], { sherlock: { ...DEFAULT_POLICY, disabled: true } }),
      ),
    ).toBe(false);
  });
});

describe('retryTargets and applyAction', () => {
  const runs = [run('sherlock', 'completed'), run('sherlock', 'failed'), run('github', 'failed')];

  it('retries everything or only the failures', () => {
    expect(retryTargets(runs, 'sherlock', 'retry')).toHaveLength(2);
    expect(retryTargets(runs, 'sherlock', 'retry-failed')).toHaveLength(1);
    expect(retryTargets(runs, 'sherlock', 'restart')).toHaveLength(2);
    expect(retryTargets(runs, 'sherlock', 'disable')).toHaveLength(0);
  });

  it('maps actions onto policy', () => {
    expect(applyAction(DEFAULT_POLICY, 'disable').disabled).toBe(true);
    expect(applyAction(DEFAULT_POLICY, 'ignore').ignored).toBe(true);
    const revived = applyAction(applyAction(DEFAULT_POLICY, 'disable'), 'enable');
    expect(revived.disabled).toBe(false);
    expect(revived.ignored).toBe(false);
    expect(applyAction(DEFAULT_POLICY, 'retry')).toEqual(DEFAULT_POLICY);
  });
});
