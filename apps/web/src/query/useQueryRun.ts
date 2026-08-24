/**
 * The Ask Raven run loop (24_UNIFIED_QUERY.md §6.2).
 *
 * `executePlan` is an async generator of events; a React panel wants a snapshot it can render. This
 * hook is the bridge: it drains the stream, keeps a progress line per step, accumulates results as
 * they arrive (so a slow provider never blocks what is already known — U5), and exposes `stop()`
 * for cooperative cancellation. It never writes to the board: the run ends with an
 * `InvestigationResult`, and the caller decides what to do with it (U7).
 */

import {
  executePlan,
  createEngineLibrary,
  type InvestigationResult,
  type QueryEvent,
  type QueryPlan,
} from '@nexus/query-engine';
import {
  BUILTIN_ENGINES,
  createCatalogRegistry,
  createResultCache,
  type ExecutionMode,
  type HostFetch,
  type TransformRegistry,
} from '@nexus/transforms';
import { useCallback, useMemo, useRef, useState } from 'react';

import { createBrowserHostFetch } from './hostFetch.ts';

export type RunPhase = 'idle' | 'running' | 'done' | 'failed';

export interface StepProgress {
  readonly transform: string;
  readonly state: 'running' | 'done' | 'failed' | 'skipped';
  readonly detail: string;
}

export interface QueryRunState {
  readonly phase: RunPhase;
  readonly steps: readonly StepProgress[];
  readonly found: number;
  readonly result: InvestigationResult | null;
  readonly error: string | null;
}

const EMPTY: QueryRunState = {
  phase: 'idle',
  steps: [],
  found: 0,
  result: null,
  error: null,
};

const upsert = (
  steps: readonly StepProgress[],
  transform: string,
  next: Omit<StepProgress, 'transform'>,
): StepProgress[] => {
  const index = steps.findIndex((step) => step.transform === transform);
  const row: StepProgress = { transform, ...next };
  if (index < 0) return [...steps, row];
  return steps.map((step, i) => (i === index ? row : step));
};

/** Folds one event into the snapshot. Exported because the reducer is the part worth unit-testing. */
export function reduceEvent(state: QueryRunState, event: QueryEvent): QueryRunState {
  switch (event.type) {
    case 'plan.started':
      return { ...EMPTY, phase: 'running' };
    case 'step.started':
      return {
        ...state,
        steps: upsert(state.steps, event.step.transform, {
          state: 'running',
          detail: `via ${event.engine}`,
        }),
      };
    case 'step.skipped':
      return {
        ...state,
        steps: upsert(state.steps, event.step.transform, {
          state: 'skipped',
          detail: event.reason,
        }),
      };
    case 'entity.found':
      return { ...state, found: state.found + 1 };
    case 'step.done':
      return {
        ...state,
        steps: upsert(state.steps, event.step.transform, {
          state: 'done',
          detail: `${String(event.produced)} result(s)${event.cached ? ' · cached' : ''}`,
        }),
      };
    case 'step.failed':
      return {
        ...state,
        steps: upsert(state.steps, event.step.transform, {
          state: event.fallback ? 'running' : 'failed',
          detail: event.fallback ? `retrying after: ${event.message}` : event.message,
        }),
      };
    default:
      return state;
  }
}

export interface UseQueryRunOptions {
  readonly mode?: ExecutionMode;
  readonly registry?: TransformRegistry;
  /** Injected in tests and by deployments that route through the egress proxy. */
  readonly fetch?: HostFetch;
}

export interface QueryRunController extends QueryRunState {
  readonly run: (plan: QueryPlan) => Promise<void>;
  readonly stop: () => void;
  readonly reset: () => void;
}

export function useQueryRun(options: UseQueryRunOptions = {}): QueryRunController {
  const [state, setState] = useState<QueryRunState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  const registry = useMemo(() => options.registry ?? createCatalogRegistry(), [options.registry]);
  const engines = useMemo(() => createEngineLibrary(BUILTIN_ENGINES), []);
  const cache = useMemo(() => createResultCache(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(EMPTY);
  }, []);

  const run = useCallback(
    async (plan: QueryPlan) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ ...EMPTY, phase: 'running' });

      const hostFetch = options.fetch ?? createBrowserHostFetch({ signal: controller.signal });

      try {
        const stream = executePlan(plan, {
          registry,
          engines,
          mode: options.mode ?? 'zero-credential',
          fetch: hostFetch,
          cache,
          signal: controller.signal,
        });
        for (;;) {
          const step = await stream.next();
          if (step.done === true) {
            const result = step.value;
            setState((current) => ({ ...current, phase: 'done', result }));
            return;
          }
          const event = step.value;
          setState((current) => reduceEvent(current, event));
        }
      } catch (cause) {
        setState((current) => ({
          ...current,
          phase: 'failed',
          error: cause instanceof Error ? cause.message : 'The run failed.',
        }));
      }
    },
    [registry, engines, cache, options.fetch, options.mode],
  );

  return { ...state, run, stop, reset };
}
