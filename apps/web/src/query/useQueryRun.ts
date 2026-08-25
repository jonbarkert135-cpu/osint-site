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
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  readonly detail: string;
  /** 0..1 — drives the per-service progress bar (Part 2 §14). */
  readonly fraction: number;
  readonly produced: number;
}

/**
 * One line of the run console (Part 2 §24). The console exists so the app is never a black box:
 * every line answers one of *what is running, why, on what data, what came back*.
 */
export interface ConsoleLine {
  readonly seq: number;
  readonly level: 'info' | 'good' | 'warn' | 'error';
  readonly text: string;
}

export interface QueryRunState {
  readonly phase: RunPhase;
  readonly steps: readonly StepProgress[];
  /** Whole-run completion, 0..1. */
  readonly progress: number;
  /** How many steps are executing right now — the visible proof of parallel execution. */
  readonly inFlight: number;
  readonly found: number;
  readonly result: InvestigationResult | null;
  readonly error: string | null;
  /** Newest last; capped, because a long run must not grow the tab without bound. */
  readonly log: readonly ConsoleLine[];
}

const LOG_LIMIT = 500;

const say = (
  state: QueryRunState,
  level: ConsoleLine['level'],
  text: string,
): readonly ConsoleLine[] => {
  const line: ConsoleLine = { seq: (state.log.at(-1)?.seq ?? 0) + 1, level, text };
  return [...state.log, line].slice(-LOG_LIMIT);
};

const on = (input: { readonly kind: string; readonly value: string }): string =>
  `${input.kind} ${input.value}`;

const EMPTY: QueryRunState = {
  phase: 'idle',
  steps: [],
  progress: 0,
  inFlight: 0,
  found: 0,
  result: null,
  error: null,
  log: [],
};

const upsert = (
  steps: readonly StepProgress[],
  transform: string,
  next: Partial<Omit<StepProgress, 'transform'>>,
): StepProgress[] => {
  const index = steps.findIndex((step) => step.transform === transform);
  const base: StepProgress = steps[index] ?? {
    transform,
    state: 'queued',
    detail: '',
    fraction: 0,
    produced: 0,
  };
  // A bar never walks backwards: a late event with a smaller fraction is noise, not progress.
  const fraction = Math.max(base.fraction, next.fraction ?? base.fraction);
  const row: StepProgress = { ...base, ...next, transform, fraction };
  if (index < 0) return [...steps, row];
  return steps.map((step, i) => (i === index ? row : step));
};

/** Folds one event into the snapshot. Exported because the reducer is the part worth unit-testing. */
export function reduceEvent(state: QueryRunState, event: QueryEvent): QueryRunState {
  switch (event.type) {
    case 'plan.started':
      return {
        ...EMPTY,
        phase: 'running',
        log: say(
          EMPTY,
          'info',
          `plan started · ${String(event.steps)} step(s) in ${String(event.stages)} stage(s)`,
        ),
      };
    case 'plan.graph':
      return {
        ...state,
        log: say(
          state,
          'info',
          `plan graph · depth ${String(event.depth)} · up to ${String(event.width)} in parallel${
            event.warnings.length > 0 ? ` · ${event.warnings.join('; ')}` : ''
          }`,
        ),
        steps: event.nodes.reduce<readonly StepProgress[]>(
          (steps, node) =>
            upsert(steps, node.transform, {
              state: 'queued',
              detail:
                node.dependsOn.length === 0 ? 'ready' : `waits for ${node.dependsOn.join(', ')}`,
            }),
          state.steps,
        ),
      };
    case 'step.started':
      return {
        ...state,
        log: say(
          state,
          'info',
          `run ${event.step.transform} via ${event.engine} on ${on(event.step.input)}`,
        ),
        steps: upsert(state.steps, event.step.transform, {
          state: 'running',
          detail: `via ${event.engine}`,
        }),
      };
    case 'step.progress':
      return {
        ...state,
        steps: upsert(state.steps, event.step.transform, {
          state: 'running',
          fraction: event.fraction,
          produced: event.produced,
        }),
      };
    case 'run.progress':
      return { ...state, progress: event.fraction, inFlight: event.inFlight };
    case 'step.skipped':
      return {
        ...state,
        log: say(state, 'warn', `skip ${event.step.transform} · ${event.reason}`),
        steps: upsert(state.steps, event.step.transform, {
          state: 'skipped',
          detail: event.reason,
          fraction: 1,
        }),
      };
    case 'entity.found':
      return {
        ...state,
        found: state.found + 1,
        log: say(
          state,
          'good',
          `found ${event.entity.kind} ${event.entity.value} · ${event.entity.confidence.toFixed(2)} · ${event.step.transform}`,
        ),
      };
    case 'relation.found':
      return {
        ...state,
        log: say(
          state,
          'good',
          `link ${event.relation.kind} · ${event.relation.derived ? 'derived' : 'observed'} · ${event.relation.confidence.toFixed(2)}`,
        ),
      };
    case 'step.done':
      return {
        ...state,
        log: say(
          state,
          event.status === 'completed' ? 'good' : 'warn',
          `done ${event.step.transform} · ${String(event.produced)} result(s)${event.cached ? ' · cached' : ''}`,
        ),
        steps: upsert(state.steps, event.step.transform, {
          state: 'done',
          detail: `${String(event.produced)} result(s)${event.cached ? ' · cached' : ''}`,
          fraction: 1,
          produced: event.produced,
        }),
      };
    case 'step.failed':
      return {
        ...state,
        log: say(
          state,
          event.fallback ? 'warn' : 'error',
          `${event.fallback ? 'retry' : 'fail'} ${event.step.transform} · ${event.message}`,
        ),
        steps: upsert(state.steps, event.step.transform, {
          state: event.fallback ? 'running' : 'failed',
          detail: event.fallback ? `retrying after: ${event.message}` : event.message,
          ...(event.fallback ? {} : { fraction: 1 }),
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
            setState((current) => ({
              ...current,
              phase: 'done',
              progress: 1,
              inFlight: 0,
              result,
              log: say(
                current,
                'good',
                `run finished · ${String(result.entities.length)} entities · ${String(result.relations.length)} relationships · ${String(result.provenance.length)} sources`,
              ),
            }));
            return;
          }
          const event = step.value;
          setState((current) => reduceEvent(current, event));
        }
      } catch (cause) {
        setState((current) => {
          const message = cause instanceof Error ? cause.message : 'The run failed.';
          return {
            ...current,
            phase: 'failed',
            error: message,
            log: say(current, 'error', message),
          };
        });
      }
    },
    [registry, engines, cache, options.fetch, options.mode],
  );

  return { ...state, run, stop, reset };
}
