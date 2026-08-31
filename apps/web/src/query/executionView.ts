/**
 * The execution graph behind a run (Part 2 §53), as data.
 *
 * Ask Raven already shows *what* is happening as a list of steps. This is the same run seen as a
 * pipeline — query → planner → engines in parallel → aggregator → entity resolver → graph — which
 * is how the machinery is actually shaped, and the one view that makes the parallel middle obvious.
 *
 * Pure: it reads the run snapshot the hook already keeps and derives node states. Nothing here
 * knows about React, and nothing invents a state — a stage the run has not reached is `pending`,
 * never a hopeful tick.
 */

import type { QueryRunState, StepProgress } from './useQueryRun.ts';

export type ExecutionState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ExecutionNode {
  readonly id: string;
  readonly label: string;
  readonly state: ExecutionState;
  /** Short suffix: the engine, the count, the reason it was skipped. */
  readonly detail?: string;
}

export interface ExecutionGraph {
  /** The single spine of the pipeline, in order; `engines` hangs off the planner. */
  readonly before: readonly ExecutionNode[];
  readonly engines: readonly ExecutionNode[];
  readonly after: readonly ExecutionNode[];
}

export const STATE_MARK: Readonly<Record<ExecutionState, string>> = {
  pending: '○',
  running: '⏳',
  done: '✅',
  failed: '⚠️',
  skipped: '–',
};

const engineNode = (step: StepProgress): ExecutionNode => ({
  id: step.transform,
  label: step.transform,
  state:
    step.state === 'queued'
      ? 'pending'
      : step.state === 'done'
        ? 'done'
        : step.state === 'failed'
          ? 'failed'
          : step.state === 'skipped'
            ? 'skipped'
            : 'running',
  ...(step.detail === '' ? {} : { detail: step.detail }),
});

/** A downstream stage is only running once every engine has settled, and done once the run is. */
const downstream = (state: QueryRunState, enginesSettled: boolean): ExecutionState => {
  if (state.phase === 'failed') return 'failed';
  if (state.phase === 'done') return 'done';
  if (state.phase === 'running') return enginesSettled ? 'running' : 'pending';
  return 'pending';
};

export const executionGraph = (state: QueryRunState, query: string): ExecutionGraph => {
  const engines = state.steps.map(engineNode);
  const settled = engines.length > 0 && engines.every((node) => node.state !== 'running');
  const planned = state.steps.length > 0;
  const after = downstream(state, settled);

  return {
    before: [
      {
        id: 'query',
        label: 'Query',
        state: query.trim() === '' ? 'pending' : 'done',
        ...(query.trim() === '' ? {} : { detail: query.trim() }),
      },
      {
        id: 'planner',
        label: 'Planner',
        state: planned ? 'done' : state.phase === 'running' ? 'running' : 'pending',
        ...(planned ? { detail: `${String(engines.length)} step(s)` } : {}),
      },
    ],
    engines,
    after: [
      {
        id: 'aggregator',
        label: 'Aggregator',
        state: after,
        ...(state.found > 0 ? { detail: `${String(state.found)} result(s)` } : {}),
      },
      { id: 'resolver', label: 'Entity Resolver', state: after },
      {
        id: 'graph',
        label: 'Graph',
        state: state.result === null ? (after === 'failed' ? 'failed' : 'pending') : 'done',
        ...(state.result === null
          ? {}
          : {
              detail: `${String(state.result.entities.length)} entities · ${String(state.result.relations.length)} links`,
            }),
      },
    ],
  };
};
