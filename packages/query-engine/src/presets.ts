/**
 * Query presets (Part 2 §43).
 *
 * An analyst should not have to assemble a budget, a depth and a cost ceiling to ask a question.
 * A preset is exactly that bundle, named after the intent: *Quick Scan* answers in seconds,
 * *Deep Scan* uses every compatible engine, the four investigation presets lock the entity type
 * so a repository is never typed as a domain.
 *
 * Two paths into a preset, because the app has two: `planWithPreset` for a typed question, and
 * `applyPreset` + `expand()` for a node already on the board. *Document Analysis* only has the
 * second one — a dropped file is an entity, never a string that could be typed as one.
 *
 * Presets are data, not behaviour: each one is a set of overrides handed to `planQuery`, which
 * still does the routing, still reports what it dropped and still executes nothing. Anything the
 * caller passes explicitly wins over the preset — the analyst is never overruled by a template.
 */

import {
  DEFAULT_BUDGET,
  DEFAULT_COST_CEILING,
  type Budget,
  type CostCeiling,
  type EntityKind,
  type ExpandDepth,
  type PlannerContext,
  type TransformRegistry,
} from '@nexus/transforms';

import { planQuery, type QueryOptions, type QueryPlan } from './plan.ts';

export const PRESET_IDS = [
  'quick-scan',
  'deep-scan',
  'repository-analysis',
  'username-investigation',
  'domain-investigation',
  'document-analysis',
  'custom',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface QueryPreset {
  readonly id: PresetId;
  readonly name: string;
  readonly description: string;
  /** Absent for `custom`: the caller's own context and options are used unchanged. */
  readonly depth?: ExpandDepth;
  /** Locks the entity type, so an investigation preset cannot be pointed at the wrong thing. */
  readonly kind?: EntityKind;
  readonly budget?: Budget;
  readonly costCeiling?: CostCeiling;
}

const budget = (overrides: Partial<Budget>): Budget => ({ ...DEFAULT_BUDGET, ...overrides });
const ceiling = (overrides: Partial<CostCeiling>): CostCeiling => ({
  ...DEFAULT_COST_CEILING,
  ...overrides,
});

/**
 * The host is the binding limit for CPU and RAM in every preset: raising them here would only
 * plan steps the resource manager (§32) then refuses. What a preset really varies is breadth,
 * patience and how expensive an engine is allowed to be.
 */
export const QUERY_PRESETS: readonly QueryPreset[] = [
  {
    id: 'quick-scan',
    name: 'Quick Scan',
    description: 'Cheap, local-leaning engines only. First answers in seconds, one hop deep.',
    depth: 1,
    budget: budget({ maxDepth: 1, maxTransforms: 5, maxRuntimeMs: 20_000, maxNewNodes: 80 }),
    costCeiling: ceiling({
      maxExecutionClass: 'standard',
      runtimeMs: 10_000,
      networkRequests: 40,
      allowQueued: false,
    }),
  },
  {
    id: 'deep-scan',
    name: 'Deep Scan',
    description:
      'Every compatible engine, two hops, queued off-box engines included. Minutes, not seconds.',
    depth: 'deep',
    budget: budget({
      maxDepth: 2,
      maxTransforms: 24,
      maxRuntimeMs: 600_000,
      maxNewNodes: 1_000,
      maxParallel: 6,
    }),
    costCeiling: ceiling({
      maxExecutionClass: 'deep',
      runtimeMs: 300_000,
      networkRequests: 2_000,
      allowQueued: true,
      // Deep Scan is the case where breadth *is* the value: an engine is not skipped for scoring low.
      minValueForExpensive: 0,
    }),
  },
  {
    id: 'repository-analysis',
    name: 'Repository Analysis',
    description: 'Code, contributors and related repositories for one repository.',
    kind: 'repo',
    depth: 2,
    budget: budget({ maxDepth: 2, maxTransforms: 8, maxRuntimeMs: 180_000 }),
    costCeiling: ceiling({ runtimeMs: 120_000, allowQueued: true }),
  },
  {
    id: 'username-investigation',
    name: 'Username Investigation',
    description: 'Profiles, repositories and mentions behind one handle.',
    kind: 'username',
    depth: 2,
    budget: budget({ maxDepth: 2, maxTransforms: 10, maxRuntimeMs: 240_000 }),
    costCeiling: ceiling({ runtimeMs: 180_000, allowQueued: true }),
  },
  {
    id: 'domain-investigation',
    name: 'Domain Investigation',
    description: 'DNS, subdomains, certificates and registration for one domain.',
    kind: 'domain',
    depth: 2,
    budget: budget({ maxDepth: 2, maxTransforms: 12, maxRuntimeMs: 300_000, maxNewNodes: 600 }),
    costCeiling: ceiling({ runtimeMs: 180_000, allowQueued: true }),
  },
  {
    id: 'document-analysis',
    name: 'Document Analysis',
    description: 'Metadata, hashes and reputation for a file — nothing leaves the machine twice.',
    kind: 'file',
    depth: 2,
    budget: budget({ maxDepth: 2, maxTransforms: 6, maxRuntimeMs: 60_000, maxNewNodes: 120 }),
    costCeiling: ceiling({ maxExecutionClass: 'standard', runtimeMs: 30_000 }),
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Your own depth, budget and ceiling. Nothing is imposed.',
  },
];

export const queryPreset = (id: PresetId): QueryPreset => {
  const preset = QUERY_PRESETS.find((candidate) => candidate.id === id);
  // PresetId is closed, so this only fires if the table and the union drift apart.
  if (!preset) throw new Error(`unknown query preset: ${id}`);
  return preset;
};

export type PresetContext = Omit<PlannerContext, 'budget'> &
  Partial<Pick<PlannerContext, 'budget'>>;

/** Preset first, caller last: an explicit budget or ceiling from the caller always wins. */
export const applyPreset = (preset: QueryPreset, ctx: PresetContext): PresetContext => ({
  ...ctx,
  ...(ctx.budget === undefined && preset.budget ? { budget: preset.budget } : {}),
  ...(ctx.costCeiling === undefined && preset.costCeiling
    ? { costCeiling: preset.costCeiling }
    : {}),
});

export const planWithPreset = (
  registry: TransformRegistry,
  raw: string,
  ctx: PresetContext,
  id: PresetId,
  options: QueryOptions = {},
): QueryPlan => {
  const preset = queryPreset(id);
  return planQuery(registry, raw, applyPreset(preset, ctx), {
    ...(preset.kind ? { kind: preset.kind } : {}),
    ...(preset.depth === undefined ? {} : { depth: preset.depth }),
    ...options,
  });
};
