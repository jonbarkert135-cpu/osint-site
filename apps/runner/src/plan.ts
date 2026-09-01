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
  createPacer,
  executePlan,
  planQuery,
  prioritise,
  type EngineLibrary,
  type ExecuteDeps,
  type InvestigationResult,
  type QueryEvent,
  type QueryPlan,
} from '@nexus/query-engine';
import { createEngineAdapters, type EngineAdapterDeps } from './executors/engineAdapters.ts';
import { zPlanJob } from './protocol.ts';

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

/**
 * The trigger (§36/§37): a queue message asks this host for a plan. Until now the host was called
 * by tests and by an embedder only; this is the entry point the product uses.
 *
 * The plan is derived here rather than carried in the message, so a message that sat in Redis over
 * a deploy cannot execute a plan built by the previous release (the reason `zRunJob` carries ids
 * only). Permissions come from the caller and are never widened: an engine that needs `subprocess`
 * is simply not planned when the org did not grant it (N4).
 */
export const runPlanJob = async (
  raw: unknown,
  deps: Omit<HostPlanDeps, 'mode'>,
): Promise<InvestigationResult> => {
  const job = zPlanJob.parse(raw);
  const registry = deps.registry ?? createCatalogRegistry();
  const planned = planQuery(
    registry,
    job.query,
    {
      mode: job.mode,
      configuredProviders: new Set<string>(),
      grantedPermissions: new Set(job.permissions),
    },
    job.depth === undefined ? {} : { depth: job.depth },
  );

  // §65: the catalogue is a menu, not a to-do list. Steps are priced and the ones that will not
  // change the answer inside this run's ceiling are dropped with a reason, and every provider gets
  // its own interval so one run does not spend an hour's quota in two seconds.
  const plan = prioritise(registry, planned);

  return runHostPlan(plan, {
    pacer: createPacer(),
    ...deps,
    registry,
    mode: job.mode,
    runId: () => job.runId,
  });
};
