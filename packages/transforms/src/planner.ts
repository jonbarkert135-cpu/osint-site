/**
 * Contextual menu and expand planner (21_TRANSFORM_SYSTEM.md §8).
 *
 * Pure: the planner decides *what would run* and returns it for approval. Nothing here executes,
 * so a plan can always be shown before a single byte leaves the machine.
 */

import { costProfile, costVerdict, type CostCeiling } from './cost.ts';
import type { ModeContext } from './modes.ts';
import type { TransformRegistry } from './registry.ts';
import { routeForInput, routeTransform, type RoutedTransform } from './router.ts';
import type {
  Budget,
  CapabilityId,
  EntityKind,
  PlanExclusion,
  PlanStep,
  TransformPlan,
} from './types.ts';

/** A menu longer than this is a catalogue, not a decision (brief §8). */
export const MENU_LIMIT = 7;

export const DEFAULT_BUDGET: Budget = {
  maxNewNodes: 250,
  maxDepth: 2,
  maxRuntimeMs: 60_000,
  maxParallel: 4,
  maxTransforms: 12,
};

export interface PlannerContext extends ModeContext {
  readonly budget: Budget;
  /** Capabilities already run against this entity: offered last, never re-run automatically. */
  readonly coveredCapabilities?: ReadonlySet<CapabilityId>;
  /**
   * Resource ceiling for one step (§42). Omitted means "do not price steps at all" — the planner
   * stays the pure capability planner it was, which is what the transform-layer tests assume.
   */
  readonly costCeiling?: CostCeiling;
}

export type ExpandDepth = 1 | 2 | 'deep';

/**
 * The contextual menu: at most `MENU_LIMIT` transforms, one per capability, best first.
 * Unusable transforms are included (with their reason from the router) but never before usable
 * ones — the analyst should see "requires configuration" instead of a mysteriously short menu.
 */
export const actionsFor = (
  registry: TransformRegistry,
  kind: EntityKind,
  ctx: PlannerContext,
  limit: number = MENU_LIMIT,
): readonly RoutedTransform[] => {
  const covered = ctx.coveredCapabilities ?? new Set<CapabilityId>();
  const seen = new Set<CapabilityId>();
  const picked: RoutedTransform[] = [];

  const ranked = [...routeForInput(registry, kind, ctx)].sort((a, b) => {
    const aCovered = covered.has(a.transform.capability) ? 1 : 0;
    const bCovered = covered.has(b.transform.capability) ? 1 : 0;
    if (aCovered !== bCovered) return aCovered - bCovered;
    const aUsable = a.reason ? 1 : 0;
    const bUsable = b.reason ? 1 : 0;
    if (aUsable !== bUsable) return aUsable - bUsable;
    return b.score - a.score;
  });

  for (const routed of ranked) {
    if (picked.length >= limit) break;
    if (seen.has(routed.transform.capability)) continue;
    if (routed.transform.priority === 'deprecated') continue;
    seen.add(routed.transform.capability);
    picked.push(routed);
  }
  return picked;
};

const layerRuntimeMs = (steps: readonly PlanStep[], maxParallel: number): number => {
  if (steps.length === 0) return 0;
  const batches = Math.ceil(steps.length / Math.max(1, maxParallel));
  const slowest = Math.max(...steps.map((step) => step.estimatedRuntimeMs));
  return batches * slowest;
};

interface Candidate {
  readonly routed: RoutedTransform;
  readonly inputKind: EntityKind;
  readonly dependsOn: readonly string[];
  readonly depth: number;
}

const candidatesForKind = (
  registry: TransformRegistry,
  kind: EntityKind,
  ctx: PlannerContext,
  depth: number,
  dependsOn: readonly string[],
): Candidate[] =>
  routeForInput(registry, kind, ctx)
    .filter((routed) => routed.transform.priority !== 'deprecated')
    .map((routed) => ({ routed, inputKind: kind, dependsOn, depth }));

/**
 * Builds the plan behind the Expand button. Everything that did not make it in is reported in
 * `excluded` with a reason — a silently shortened plan is the failure mode this layer exists to
 * avoid (see docs/ecosystem/MALTEGO_AUDIT.md §3).
 */
export const expand = (
  registry: TransformRegistry,
  kind: EntityKind,
  ctx: PlannerContext,
  depth: ExpandDepth = 1,
): TransformPlan => {
  const { budget } = ctx;
  const maxDepth = depth === 'deep' ? budget.maxDepth : Math.min(depth, budget.maxDepth);
  const covered = new Set<CapabilityId>(ctx.coveredCapabilities ?? []);
  const excluded: PlanExclusion[] = [];
  const steps: PlanStep[] = [];
  const usedTransforms = new Set<string>();

  let nodeBudget = budget.maxNewNodes;
  let runtimeBudget = budget.maxRuntimeMs;

  const consider = (candidates: readonly Candidate[]): PlanStep[] => {
    const accepted: PlanStep[] = [];
    for (const { routed, inputKind, dependsOn, depth: stepDepth } of candidates) {
      const { transform } = routed;
      if (usedTransforms.has(transform.id)) continue;

      if (routed.reason) {
        excluded.push({ transform: transform.id, reason: routed.reason });
        usedTransforms.add(transform.id);
        continue;
      }
      if (covered.has(transform.capability)) {
        excluded.push({ transform: transform.id, reason: 'already-covered' });
        usedTransforms.add(transform.id);
        continue;
      }
      if (ctx.costCeiling) {
        const primary = routed.chain.find((entry) => !entry.engine.terminal);
        const verdict = primary
          ? costVerdict(
              costProfile(transform, primary.engine, primary.provider),
              routed.score,
              ctx.costCeiling,
            )
          : undefined;
        if (verdict && !verdict.ok) {
          excluded.push({ transform: transform.id, reason: verdict.reason, note: verdict.note });
          usedTransforms.add(transform.id);
          continue;
        }
      }
      if (steps.length + accepted.length >= budget.maxTransforms) {
        excluded.push({ transform: transform.id, reason: 'budget-exhausted' });
        usedTransforms.add(transform.id);
        continue;
      }
      const results = Math.min(transform.limits.maxResults, nodeBudget);
      if (results <= 0 || transform.limits.expectedRuntimeMs > runtimeBudget) {
        excluded.push({ transform: transform.id, reason: 'budget-exhausted' });
        usedTransforms.add(transform.id);
        continue;
      }

      usedTransforms.add(transform.id);
      covered.add(transform.capability);
      nodeBudget -= results;
      accepted.push({
        transform: transform.id,
        inputKind,
        dependsOn,
        depth: stepDepth,
        chain: routed.chain.map((entry) => entry.engine.id),
        estimatedRuntimeMs: transform.limits.expectedRuntimeMs,
        maxResults: results,
      });
    }
    return accepted;
  };

  const firstLayer = consider(candidatesForKind(registry, kind, ctx, 1, []));
  steps.push(...firstLayer);
  runtimeBudget -= layerRuntimeMs(firstLayer, budget.maxParallel);

  if (maxDepth >= 2 && runtimeBudget > 0) {
    // Second layer: transforms that consume what the first layer is expected to produce.
    const producers = new Map<EntityKind, string[]>();
    for (const step of firstLayer) {
      const manifest = registry.transform(step.transform);
      if (!manifest) continue;
      for (const output of manifest.outputs) {
        const bucket = producers.get(output);
        if (bucket) bucket.push(manifest.id);
        else producers.set(output, [manifest.id]);
      }
    }
    const secondLayer = consider(
      [...producers.entries()].flatMap(([outputKind, dependsOn]) =>
        candidatesForKind(registry, outputKind, ctx, 2, dependsOn),
      ),
    );
    steps.push(...secondLayer);
    runtimeBudget -= layerRuntimeMs(secondLayer, budget.maxParallel);
  }

  const providersUsed = new Set<string>();
  const credentialsNeeded = new Set<string>();
  let requiresNetwork = false;
  for (const step of steps) {
    const manifest = registry.transform(step.transform);
    if (!manifest) continue;
    const routed = routeTransform(registry, manifest, ctx);
    const primary = routed.chain.find((entry) => !entry.engine.terminal);
    if (!primary) continue;
    providersUsed.add(primary.provider.id);
    if (primary.engine.dataFlow !== 'local') requiresNetwork = true;
    if (primary.provider.credentials === 'required') credentialsNeeded.add(primary.provider.id);
  }

  const byDepth = new Map<number, PlanStep[]>();
  for (const step of steps) {
    const bucket = byDepth.get(step.depth);
    if (bucket) bucket.push(step);
    else byDepth.set(step.depth, [step]);
  }
  const runtimeMs = [...byDepth.values()].reduce(
    (total, layer) => total + layerRuntimeMs(layer, budget.maxParallel),
    0,
  );

  return {
    // Already topological: depth 1 before depth 2, and a step only depends on earlier ones.
    steps,
    estimate: {
      runtimeMs,
      minEntities: steps.filter((step) => step.depth === 1).length,
      maxEntities: Math.min(
        steps.reduce((total, step) => total + step.maxResults, 0),
        budget.maxNewNodes,
      ),
    },
    requiresNetwork,
    providersUsed: [...providersUsed],
    credentialsNeeded: [...credentialsNeeded],
    excluded,
  };
};
