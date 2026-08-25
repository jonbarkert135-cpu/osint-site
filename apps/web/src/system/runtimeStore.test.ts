import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '@nexus/transforms';

import {
  policyFor,
  recordRuns,
  requestAction,
  resetRuntime,
  runtimeSnapshot,
  setLimits,
} from './runtimeStore.ts';

const run = (id: string, engine = 'sherlock'): RunRecord =>
  ({
    id,
    transform: 'demo',
    transformVersion: '1.0.0',
    input: { kind: 'domain', value: 'example.com' },
    engine,
    engineVersion: '1.0.0',
    provider: 'local-runtime',
    mode: 'zero-credential',
    startedAt: 0,
    finishedAt: 10,
    status: 'completed',
    results: [],
    errors: [],
  }) satisfies RunRecord;

describe('runtimeStore', () => {
  beforeEach(() => {
    resetRuntime();
  });

  it('records runs once, ignoring duplicates and empty batches', () => {
    recordRuns([run('a'), run('b')]);
    recordRuns([run('b')]);
    recordRuns([]);
    expect(runtimeSnapshot().runs.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('caps the kept history', () => {
    recordRuns(Array.from({ length: 260 }, (_, i) => run(`r${String(i)}`)));
    expect(runtimeSnapshot().runs).toHaveLength(200);
  });

  it('defaults a policy and applies disable / enable', () => {
    expect(policyFor('sherlock').disabled).toBe(false);
    requestAction('sherlock', 'disable', 0);
    expect(policyFor('sherlock').disabled).toBe(true);
    requestAction('sherlock', 'enable', 0);
    expect(policyFor('sherlock').disabled).toBe(false);
  });

  it('logs retry intents but leaves policy alone', () => {
    requestAction('github', 'retry-failed', 3);
    const state = runtimeSnapshot();
    expect(state.retries[0]).toMatchObject({ engine: 'github', action: 'retry-failed', runs: 3 });
    expect(policyFor('github').disabled).toBe(false);
  });

  it('stores per-engine limits', () => {
    setLimits('spiderfoot', {
      startupTimeoutMs: 1_000,
      executionTimeoutMs: 2_000,
      memoryLimitMb: 64,
      concurrency: 1,
    });
    expect(policyFor('spiderfoot').limits.memoryLimitMb).toBe(64);
  });
});
