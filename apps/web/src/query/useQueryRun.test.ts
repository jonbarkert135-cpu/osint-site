import type { QueryEvent } from '@nexus/query-engine';
import { describe, expect, it } from 'vitest';

import { reduceEvent } from './useQueryRun.ts';

const step = { transform: 'domain.certificates', stage: 0, input: { kind: 'domain', value: 'a' } };

const base = {
  phase: 'running' as const,
  steps: [],
  progress: 0,
  inFlight: 0,
  found: 0,
  result: null,
  error: null,
};

const fold = (events: readonly QueryEvent[]) => events.reduce(reduceEvent, base);

describe('reduceEvent', () => {
  it('shows a step as running with the engine behind it', () => {
    const state = fold([{ type: 'step.started', step, engine: 'ct-log-search' }]);
    expect(state.steps[0]).toMatchObject({ state: 'running', detail: 'via ct-log-search' });
  });

  it('counts results as they stream in, before the run finishes', () => {
    const found = { type: 'entity.found', step, entity: {} } as unknown as QueryEvent;
    expect(fold([found, found, found]).found).toBe(3);
  });

  it('replaces a step row instead of appending a second one', () => {
    const state = fold([
      { type: 'step.started', step, engine: 'ct-log-search' },
      {
        type: 'step.done',
        step,
        engine: 'ct-log-search',
        status: 'completed',
        produced: 4,
        cached: true,
        run: {},
      } as unknown as QueryEvent,
    ]);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.detail).toBe('4 result(s) · cached');
  });

  it('keeps a step running while a fallback engine is tried (U5)', () => {
    const state = fold([
      {
        type: 'step.failed',
        step,
        engine: 'ct-log-search',
        message: 'timeout',
        fallback: true,
      },
    ]);
    expect(state.steps[0]).toMatchObject({ state: 'running', detail: 'retrying after: timeout' });
  });

  it('marks a step failed once no fallback is left', () => {
    const state = fold([
      {
        type: 'step.failed',
        step,
        engine: 'ct-log-search',
        message: 'blocked by CORS',
        fallback: false,
      },
    ]);
    expect(state.steps[0]).toMatchObject({ state: 'failed', detail: 'blocked by CORS' });
  });

  it('records a skipped step with the reason the planner gave', () => {
    const state = fold([{ type: 'step.skipped', step, reason: 'budget-exhausted' }]);
    expect(state.steps[0]).toMatchObject({ state: 'skipped', detail: 'budget-exhausted' });
  });

  it('seeds queued rows from the scheduled DAG, showing what each step waits for', () => {
    const state = fold([
      {
        type: 'plan.graph',
        nodes: [
          { transform: 'dns.resolve', dependsOn: [], rank: 0 },
          { transform: 'ip.geo', dependsOn: ['dns.resolve'], rank: 1 },
        ],
        depth: 2,
        width: 1,
        warnings: [],
      },
    ]);
    expect(state.steps).toHaveLength(2);
    expect(state.steps[0]).toMatchObject({ state: 'queued', detail: 'ready', fraction: 0 });
    expect(state.steps[1]?.detail).toBe('waits for dns.resolve');
  });

  it('advances a per-step bar and never lets it walk backwards', () => {
    const state = fold([
      { type: 'step.progress', step, fraction: 0.6, produced: 3 },
      { type: 'step.progress', step, fraction: 0.2, produced: 3 },
    ]);
    expect(state.steps[0]).toMatchObject({ state: 'running', fraction: 0.6, produced: 3 });
  });

  it('tracks whole-run progress and how many services run in parallel', () => {
    const state = fold([
      {
        type: 'run.progress',
        fraction: 0.5,
        settled: 2,
        planned: 4,
        inFlight: 3,
        entities: 11,
      },
    ]);
    expect(state.progress).toBe(0.5);
    expect(state.inFlight).toBe(3);
  });

  it('fills the bar when a step settles, whatever way it settled', () => {
    const done = fold([
      {
        type: 'step.done',
        step,
        engine: 'ct-log-search',
        status: 'completed',
        produced: 2,
        cached: false,
        run: {},
      } as unknown as QueryEvent,
    ]);
    const skipped = fold([{ type: 'step.skipped', step, reason: 'budget-exhausted' }]);
    expect(done.steps[0]?.fraction).toBe(1);
    expect(skipped.steps[0]?.fraction).toBe(1);
  });
});
