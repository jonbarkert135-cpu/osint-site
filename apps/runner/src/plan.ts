/**
 * The host that owns both an adapter registry and the plan executor — Part 2 §37.
 *
 * Until now the two halves lived in different processes: the browser executes plans but has no
 * adapter (by design, N2), the runner has the adapters but never executed a plan. This file is the
 * seam. It registers the host's cli/python/go/rust adapters, asks `registryEngines` which engines
 * that makes real, and hands the resulting library to `executePlan`.
 *
 * It spawns nothing itself: every process still goes through `ExecutionLayer` (N5), and the network
 * stays the host's business — `fetch` is injected, so a deployment routes it through the egress
 * proxy exactly like any other run.
 */

import { AdapterRegistry, createCatalogRegistry, type TransformRegistry } from '@nexus/transforms';
import { BUILTIN_ENGINES, registryEngines } from '@nexus/transforms/sdk';
import {
  createEngineLibrary,
  executePlan,
  type EngineLibrary,
  type ExecuteDeps,
  type InvestigationResult,
  type QueryEvent,
  type QueryPlan,
} from '@nexus/query-engine';
import { createEngineAdapters, type EngineAdapterDeps } from './executors/engineAdapters.ts';

/** The adapters this process can serve, registered by runtime. */
export const createHostAdapters = (deps: EngineAdapterDeps): AdapterRegistry => {
  const registry = new AdapterRegistry();
  for (const adapter of createEngineAdapters(deps)) registry.register(adapter);
  return registry;
};

/**
 * Builtin engines plus every adapter-backed engine this host can actually dispatch. An engine whose
 * runtime has no adapter here is absent rather than broken: the executor skips its step with
 * `engine-unavailable` and says so (U5).
 */
export const createHostEngines = (
  adapters: AdapterRegistry,
  catalog: TransformRegistry = createCatalogRegistry(),
  enabled?: ReadonlySet<string>,
): EngineLibrary => {
  const registered = registryEngines(adapters, catalog);
  // Part 2 §61: an engine that governance has not enabled is simply not dispatchable here. It stays
  // in the catalogue with its reason (§55/§58); the executor reports `engine-unavailable` for it,
  // which is the same honest outcome as a missing adapter.
  const allowed = enabled
    ? Object.fromEntries(Object.entries(registered).filter(([id]) => enabled.has(id)))
    : registered;
  return createEngineLibrary({ ...BUILTIN_ENGINES, ...allowed });
};

export interface HostPlanDeps extends Omit<ExecuteDeps, 'engines' | 'registry'> {
  readonly adapters: AdapterRegistry;
  readonly registry?: TransformRegistry;
  /** §61: engine ids governance has enabled. Omitted means "every adapter-backed engine". */
  readonly enabledEngines?: ReadonlySet<string>;
  /** Called for each event, so a caller can stream progress without re-implementing the drain. */
  readonly onEvent?: (event: QueryEvent) => void;
}

/**
 * Runs one plan on this host and returns the investigation. The generator is drained here because
 * a runner has no UI to stream into; a caller that wants the events passes `onEvent`.
 */
export const runHostPlan = async (
  plan: QueryPlan,
  deps: HostPlanDeps,
): Promise<InvestigationResult> => {
  const { adapters, registry = createCatalogRegistry(), onEvent, enabledEngines, ...rest } = deps;
  const stream = executePlan(plan, {
    ...rest,
    registry,
    engines: createHostEngines(adapters, registry, enabledEngines),
  });
  for (;;) {
    const step = await stream.next();
    if (step.done === true) return step.value;
    onEvent?.(step.value);
  }
};
