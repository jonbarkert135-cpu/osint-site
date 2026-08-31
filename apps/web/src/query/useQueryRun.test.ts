import type { QueryEvent } from '@nexus/query-engine';
import { describe, expect, it } from 'vitest';

import { liveCounters, reduceEvent } from './useQueryRun.ts';

const step = { transform: 'domain.certificates', stage: 0, input: { kind: 'domain', value: 'a' } };

const base = {
  phase: 'running' as const,
  steps: [],
  progress: 0,
  inFlight: 0,
  found: 0,
  counts: {},
  relations: 0,
  result: null,
  error: null,
  log: [],
};

const fold = (events: readonly QueryEvent[]) => events.reduce(reduceEvent, base);

describe('reduceEvent', () => {
  it('shows a step as running with the engine behind it', () => {
    const state = fold([{ type: 'step.started', step, engine: 'ct-log-search' }]);
    expect(state.steps[0]).toMatchObject({ state: 'running', detail: 'via ct-log-search' });
  });

  it('counts results as they stream in, before the run finishes', () => {
    const found = {
      type: 'entity.found',
      step,
      entity: { kind: 'host', value: 'a.example.com', confidence: 0.8 },
    } as unknown as QueryEvent;
    expect(fold([found, found, found]).found).toBe(3);
  });

  it('tallies entities by kind and relationships for the live counters (§52)', () => {
    const entity = (kind: string): QueryEvent =>
      ({
        type: 'entity.found',
        step,
        entity: { kind, value: `${kind}.example.com`, confidence: 0.8 },
      }) as unknown as QueryEvent;
    const link = {
      type: 'relation.found',
      step,
      relation: { kind: 'resolves-to', derived: false, confidence: 0.9 },
    } as unknown as QueryEvent;
    const state = fold([entity('hostname'), entity('hostname'), entity('repo'), link]);

    expect(state.counts).toEqual({ hostname: 2, repo: 1 });
    expect(state.relations).toBe(1);
    expect(liveCounters(state)).toEqual([
      '3 entities found',
      '2 hostnames found',
      '1 repo found',
      '1 relationship discovered',
    ]);
  });

  it('has no live counters before anything is found', () => {
    expect(liveCounters(base)).toEqual([]);
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

describe('the run console log (§24)', () => {
  it('says what is running, through which engine and on what data', () => {
    const state = fold([{ type: 'step.started', step, engine: 'ct-log-search' }]);
    expect(state.log.at(-1)?.text).toBe('run domain.certificates via ct-log-search on domain a');
  });

  it('records what came back, and marks a failure as an error', () => {
    const state = fold([
      {
        type: 'step.done',
        step,
        engine: 'ct-log-search',
        status: 'completed',
        produced: 2,
        cached: false,
        run: {},
      } as unknown as QueryEvent,
      { type: 'step.failed', step, engine: 'ct-log-search', message: 'timeout', fallback: false },
    ]);
    expect(state.log.map((line) => line.text)).toEqual([
      'done domain.certificates · 2 result(s)',
      'fail domain.certificates · timeout',
    ]);
    expect(state.log.at(-1)?.level).toBe('error');
    expect(state.log.map((line) => line.seq)).toEqual([1, 2]);
  });

  it('starts a fresh log for a fresh plan', () => {
    const state = fold([
      { type: 'step.started', step, engine: 'ct-log-search' },
      { type: 'plan.started', stages: 2, steps: 3 },
    ]);
    expect(state.log).toHaveLength(1);
    expect(state.log[0]?.text).toBe('plan started · 3 step(s) in 2 stage(s)');
  });
});
