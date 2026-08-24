import type { QueryEvent } from '@nexus/query-engine';
import { describe, expect, it } from 'vitest';

import { reduceEvent } from './useQueryRun.ts';

const step = { transform: 'domain.certificates', stage: 0, input: { kind: 'domain', value: 'a' } };

const base = { phase: 'running' as const, steps: [], found: 0, result: null, error: null };

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
});
