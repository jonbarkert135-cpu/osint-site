/** The pipeline view (Part 2 §53): every node's state is derived, never assumed. */

import { describe, expect, it } from 'vitest';

import { executionGraph, STATE_MARK } from './executionView.ts';
import type { QueryRunState, StepProgress } from './useQueryRun.ts';

const step = (transform: string, over: Partial<StepProgress> = {}): StepProgress => ({
  transform,
  state: 'queued',
  detail: '',
  fraction: 0,
  produced: 0,
  ...over,
});

const state = (over: Partial<QueryRunState> = {}): QueryRunState => ({
  phase: 'idle',
  steps: [],
  progress: 0,
  inFlight: 0,
  found: 0,
  counts: {},
  relations: 0,
  result: null,
  error: null,
  log: [],
  ...over,
});

describe('executionGraph', () => {
  it('is all pending before anything is typed or planned', () => {
    const graph = executionGraph(state(), '');

    expect(graph.before.map((node) => node.state)).toEqual(['pending', 'pending']);
    expect(graph.engines).toEqual([]);
    expect(graph.after.every((node) => node.state === 'pending')).toBe(true);
  });

  it('marks the query done as soon as there is one, and the planner while it runs', () => {
    const graph = executionGraph(state({ phase: 'running' }), ' example.com ');

    expect(graph.before[0]).toMatchObject({ state: 'done', detail: 'example.com' });
    expect(graph.before[1]?.state).toBe('running');
  });

  it('maps each step state onto a node state and keeps downstream pending while engines run', () => {
    const graph = executionGraph(
      state({
        phase: 'running',
        found: 3,
        steps: [
          step('a', { state: 'running', detail: 'via sherlock' }),
          step('b', { state: 'done' }),
          step('c', { state: 'failed' }),
          step('d', { state: 'skipped' }),
        ],
      }),
      'example_user',
    );

    expect(graph.engines.map((node) => node.state)).toEqual([
      'running',
      'done',
      'failed',
      'skipped',
    ]);
    expect(graph.engines[0]?.detail).toBe('via sherlock');
    expect(graph.before[1]).toMatchObject({ state: 'done', detail: '4 step(s)' });
    expect(graph.after.map((node) => node.state)).toEqual(['pending', 'pending', 'pending']);
    expect(graph.after[0]?.detail).toBe('3 result(s)');
  });

  it('runs the downstream stages once every engine has settled', () => {
    const graph = executionGraph(
      state({ phase: 'running', steps: [step('a', { state: 'done' })] }),
      'example.com',
    );

    expect(graph.after.map((node) => node.state)).toEqual(['running', 'running', 'pending']);
  });

  it('finishes the graph node only when a result exists', () => {
    const result = {
      entities: [{}, {}],
      relations: [{}],
    } as unknown as NonNullable<QueryRunState['result']>;
    const graph = executionGraph(
      state({ phase: 'done', steps: [step('a', { state: 'done' })], result }),
      'example.com',
    );

    expect(graph.after.map((node) => node.state)).toEqual(['done', 'done', 'done']);
    expect(graph.after[2]?.detail).toBe('2 entities · 1 links');
  });

  it('fails the whole tail when the run itself failed', () => {
    const graph = executionGraph(
      state({ phase: 'failed', steps: [step('a', { state: 'done' })] }),
      'example.com',
    );

    expect(graph.after.map((node) => node.state)).toEqual(['failed', 'failed', 'failed']);
  });

  it('has a mark for every state', () => {
    expect(Object.values(STATE_MARK).filter((mark) => mark.length > 0)).toHaveLength(5);
  });
});
