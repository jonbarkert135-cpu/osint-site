/**
 * Session-scoped runtime state behind the System page (Part 2 §27–§31).
 *
 * Health is derived from what actually ran, so something has to keep the run records after a run
 * ends: this store. It is deliberately in-memory and per session — run history that survives a
 * reload belongs in `@nexus/db`, and pretending otherwise would put a stale "Online" next to a
 * service that died yesterday.
 *
 * Policies (§30/§31) live here too so a disabled engine stays disabled across panels, and a retry
 * request raised on the System page is visible to the Ask panel that will actually execute it —
 * this module never runs an engine itself (N5).
 */

import {
  applyAction,
  DEFAULT_POLICY,
  type EngineAction,
  type EnginePolicy,
} from '@nexus/query-engine';
import type { RunRecord } from '@nexus/transforms';
import { useSyncExternalStore } from 'react';

export interface RetryRequest {
  readonly engine: string;
  readonly action: EngineAction;
  readonly runs: number;
  readonly at: number;
}

export interface RuntimeState {
  readonly runs: readonly RunRecord[];
  readonly policies: Readonly<Record<string, EnginePolicy>>;
  /** Newest first; the page shows the last one as the outcome of the button just pressed. */
  readonly retries: readonly RetryRequest[];
}

/** One session cannot need more than this to judge health, and the page must stay cheap to render. */
const MAX_RUNS = 200;
const MAX_RETRIES = 20;

let state: RuntimeState = { runs: [], policies: {}, retries: [] };
const listeners = new Set<() => void>();

const publish = (next: RuntimeState): void => {
  state = next;
  for (const listener of listeners) listener();
};

export const runtimeSnapshot = (): RuntimeState => state;

export const recordRuns = (runs: readonly RunRecord[]): void => {
  if (runs.length === 0) return;
  const known = new Set(state.runs.map((run) => run.id));
  const added = runs.filter((run) => !known.has(run.id));
  if (added.length === 0) return;
  publish({ ...state, runs: [...state.runs, ...added].slice(-MAX_RUNS) });
};

export const policyFor = (engine: string): EnginePolicy => state.policies[engine] ?? DEFAULT_POLICY;

export const setLimits = (engine: string, limits: EnginePolicy['limits']): void => {
  publish({
    ...state,
    policies: { ...state.policies, [engine]: { ...policyFor(engine), limits } },
  });
};

/** Records the intent. Retries change what the next run does; enable/disable change policy. */
export const requestAction = (engine: string, action: EngineAction, runs: number): void => {
  const policies = { ...state.policies, [engine]: applyAction(policyFor(engine), action) };
  const retries =
    action === 'retry' || action === 'retry-failed' || action === 'restart'
      ? [{ engine, action, runs, at: Date.now() }, ...state.retries].slice(0, MAX_RETRIES)
      : state.retries;
  publish({ ...state, policies, retries });
};

export const resetRuntime = (): void => {
  publish({ runs: [], policies: {}, retries: [] });
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useRuntime = (): RuntimeState =>
  useSyncExternalStore(subscribe, runtimeSnapshot, runtimeSnapshot);
