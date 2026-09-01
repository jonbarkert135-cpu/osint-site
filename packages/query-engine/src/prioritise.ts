/**
 * Engine selection (§65 performance architecture).
 *
 * The planner's job is not to run every engine that exists — it is to run the ones that will
 * change the answer. A catalogue of two hundred capabilities is a reason to *choose*, not a reason
 * to open two hundred sockets: every extra step costs wall-clock, quota, memory and, when it
 * returns nothing, a line of noise in the analyst's graph.
 *
 * So this module prices each planned step by what it is likely to yield per second of runtime,
 * keeps the ones that earn their place under an explicit ceiling, and reports every drop with a
 * reason the UI already knows how to render (`cost-not-justified`, `over-resource-budget`).
 * Two rules keep it honest:
 *  - a step nobody else depends on is dropped alone; a step others consume is kept with them,
 *    or its dependents go too — a plan must never reference a step that will not run;
 *  - it is pure. Nothing is executed, no clock is read, no network is touched.
 */

import type {
  PlanExclusion,
  PlanStep,
  ProviderId,
  TransformId,
  TransformPlan,
  TransformPriority,
  TransformRegistry,
} from '@nexus/transforms';

import { groupExclusions, type QueryPlan } from './plan.ts';

export interface SelectionOptions {
  /** Hard cap on steps that survive selection. */
  readonly maxSteps?: number;
  /** Ceiling for the projected wall-clock of the selected plan. */
  readonly maxRuntimeMs?: number;
  /** How many steps the executor will run at once; used to project wall-clock. */
  readonly maxParallel?: number;
  /** Steps scoring below this are not worth their socket. */
  readonly minScore?: number;
}

export interface StepScore {
  readonly transform: TransformId;
  /** Expected results per second of engine time, weighted by how much we trust the transform. */
  readonly score: number;
  readonly kept: boolean;
}

export interface Selection {
  /** The plan the executor should run: same shape, fewer steps, exclusions extended. */
  readonly plan: TransformPlan;
  /** Steps this selection removed, with the reason each was removed. */
  readonly dropped: readonly PlanExclusion[];
  /** Every step's price, best first — the "why is X not running?" answer. */
  readonly scores: readonly StepScore[];
  /** Projected wall-clock of the selected plan at `maxParallel`. */
  readonly projectedRuntimeMs: number;
}

export const DEFAULT_SELECTION: Required<SelectionOptions> = {
  maxSteps: 12,
  maxRuntimeMs: 60_000,
  maxParallel: 4,
  minScore: 0.05,
};

/** How much a result from this transform is worth relative to a `core` one. */
const PRIORITY_WEIGHT: Readonly<Record<TransformPriority, number>> = {
  core: 1,
  recommended: 0.8,
  optional: 0.5,
  experimental: 0.3,
  external: 0.3,
  deprecated: 0,
};

/**
 * Results per second, weighted by trust and damped by depth: a step three hops from the seed
 * fires on entities that may never be produced, so its expected yield is a fraction of its
 * advertised one.
 */
const scoreOf = (registry: TransformRegistry, step: PlanStep): number => {
  const manifest = registry.transform(step.transform);
  const weight = manifest ? PRIORITY_WEIGHT[manifest.priority] : 0.3;
  const seconds = Math.max(0.1, step.estimatedRuntimeMs / 1_000);
  const depthDamping = 1 / Math.max(1, step.depth);
  return (step.maxResults * weight * depthDamping) / seconds;
};

/** Layered projection: steps at one depth run together, depths run after each other. */
export const projectRuntimeMs = (steps: readonly PlanStep[], maxParallel: number): number => {
  const lanes = Math.max(1, maxParallel);
  const byDepth = new Map<number, PlanStep[]>();
  for (const step of steps) {
    const bucket = byDepth.get(step.depth);
    if (bucket) bucket.push(step);
    else byDepth.set(step.depth, [step]);
  }
  let total = 0;
  for (const bucket of byDepth.values()) {
    const batches = Math.ceil(bucket.length / lanes);
    const slowest = Math.max(...bucket.map((step) => step.estimatedRuntimeMs));
    total += batches * slowest;
  }
  return total;
};

/** Steps this one needs, transitively, restricted to steps that exist in the plan. */
const ancestorsOf = (
  step: PlanStep,
  byId: ReadonlyMap<TransformId, PlanStep>,
  seen: Set<TransformId> = new Set(),
): readonly PlanStep[] => {
  for (const parentId of step.dependsOn) {
    if (seen.has(parentId)) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    seen.add(parentId);
    ancestorsOf(parent, byId, seen);
  }
  return [...seen].flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
};

const providersOf = (
  registry: TransformRegistry,
  steps: readonly PlanStep[],
): readonly ProviderId[] => {
  const ids = new Set<ProviderId>();
  for (const step of steps) {
    for (const engineId of step.chain) {
      const provider = registry.engine(engineId)?.provider;
      if (provider !== undefined) ids.add(provider);
    }
  }
  return [...ids].sort();
};

/**
 * Prices every step and keeps the ones that fit the ceiling, best first. A step is admitted
 * together with the ancestors it needs; if that whole bundle does not fit, the step waits for
 * another run rather than half-running now.
 */
export const selectSteps = (
  registry: TransformRegistry,
  plan: TransformPlan,
  options: SelectionOptions = {},
): Selection => {
  const limits = { ...DEFAULT_SELECTION, ...options };
  const byId = new Map(plan.steps.map((step) => [step.transform, step]));
  const priced = plan.steps
    .map((step) => ({ step, score: scoreOf(registry, step) }))
    .sort((a, b) => b.score - a.score || a.step.transform.localeCompare(b.step.transform));

  const kept = new Map<TransformId, PlanStep>();
  const dropped: PlanExclusion[] = [];
  const drop = (step: PlanStep, reason: PlanExclusion['reason'], note: string): void => {
    dropped.push({ transform: step.transform, reason, note });
  };

  for (const { step, score } of priced) {
    if (kept.has(step.transform)) continue;
    if (score < limits.minScore) {
      drop(
        step,
        'cost-not-justified',
        `expected yield ${score.toFixed(2)}/s is below the ${String(limits.minScore)}/s floor`,
      );
      continue;
    }
    const bundle = [...ancestorsOf(step, byId), step].filter(
      (candidate) => !kept.has(candidate.transform),
    );
    if (bundle.some((candidate) => dropped.some((out) => out.transform === candidate.transform))) {
      drop(step, 'over-resource-budget', 'a step it depends on did not fit this run');
      continue;
    }
    const projected = projectRuntimeMs([...kept.values(), ...bundle], limits.maxParallel);
    if (kept.size + bundle.length > limits.maxSteps) {
      drop(step, 'over-resource-budget', `over the ${String(limits.maxSteps)}-step ceiling`);
      continue;
    }
    if (projected > limits.maxRuntimeMs) {
      drop(
        step,
        'over-resource-budget',
        `would push the run to ~${String(Math.round(projected / 1_000))}s, past the ${String(
          Math.round(limits.maxRuntimeMs / 1_000),
        )}s ceiling`,
      );
      continue;
    }
    for (const candidate of bundle) kept.set(candidate.transform, candidate);
  }

  const steps = plan.steps.filter((step) => kept.has(step.transform));
  const projectedRuntimeMs = projectRuntimeMs(steps, limits.maxParallel);
  const providersUsed = providersOf(registry, steps);
  const credentialsNeeded = plan.credentialsNeeded.filter((provider) =>
    providersUsed.includes(provider),
  );

  return {
    plan: {
      ...plan,
      steps,
      estimate: {
        runtimeMs: projectedRuntimeMs,
        minEntities: steps.length === 0 ? 0 : Math.min(steps.length, plan.estimate.minEntities),
        maxEntities: steps.reduce((sum, step) => sum + step.maxResults, 0),
      },
      requiresNetwork: steps.some((step) =>
        step.chain.some((engineId) => registry.engine(engineId)?.dataFlow !== 'local'),
      ),
      providersUsed,
      credentialsNeeded,
      excluded: [...plan.excluded, ...dropped],
    },
    dropped,
    scores: priced.map(({ step, score }) => ({
      transform: step.transform,
      score,
      kept: kept.has(step.transform),
    })),
    projectedRuntimeMs,
  };
};

/**
 * Selection applied to a planned query, so a caller can hand the result straight to the executor:
 * `executePlan(prioritise(registry, planQuery(...)), deps)`.
 */
export const prioritise = (
  registry: TransformRegistry,
  query: QueryPlan,
  options: SelectionOptions = {},
): QueryPlan => {
  if (query.plan === undefined) return query;
  const selection = selectSteps(registry, query.plan, options);
  return { ...query, plan: selection.plan, hidden: groupExclusions(selection.plan) };
};
