/**
 * One question → one plan (24_UNIFIED_QUERY.md §1, §4, §7).
 *
 * The layer proposes, the analyst commits: `planQuery` never executes anything. It types the
 * input, picks the entity to route on, and asks the transform layer what *would* run under the
 * current mode, credentials and budget — including what was dropped and why, because a silently
 * shortened plan is the failure mode this layer exists to avoid.
 */

import {
  DEFAULT_BUDGET,
  expand,
  type EntityKind,
  type ExclusionReason,
  type ExpandDepth,
  type PlannerContext,
  type TransformPlan,
  type TransformRegistry,
} from '@nexus/transforms';

import { isAmbiguous, typeQuery, type EntityCandidate } from './selectors.ts';

export interface QueryOptions {
  /** The analyst overrode the detected type; routing uses this candidate. */
  readonly kind?: EntityKind;
  readonly depth?: ExpandDepth;
}

export interface QueryPlan {
  readonly input: string;
  readonly candidates: readonly EntityCandidate[];
  /** The candidate the plan was built for; absent when the input types to nothing routable. */
  readonly chosen?: EntityCandidate;
  /** The top two candidates are close: the UI asks once instead of guessing. */
  readonly ambiguous: boolean;
  /** Absent when there is no candidate to route. */
  readonly plan?: TransformPlan;
  /** Why capabilities were dropped, grouped for the "12 hidden: 7 need a key" line. */
  readonly hidden: readonly HiddenGroup[];
}

export interface HiddenGroup {
  readonly reason: ExclusionReason;
  readonly count: number;
}

export const groupExclusions = (plan: TransformPlan): readonly HiddenGroup[] => {
  const counts = new Map<ExclusionReason, number>();
  for (const exclusion of plan.excluded) {
    counts.set(exclusion.reason, (counts.get(exclusion.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
};

const pick = (
  candidates: readonly EntityCandidate[],
  kind: EntityKind | undefined,
): EntityCandidate | undefined =>
  kind === undefined ? candidates[0] : candidates.find((candidate) => candidate.kind === kind);

/** Sorted best first, so the caller can render the list without re-sorting it. */
const ranked = (raw: string): readonly EntityCandidate[] =>
  [...typeQuery(raw)].sort((a, b) => b.confidence - a.confidence);

export const planQuery = (
  registry: TransformRegistry,
  raw: string,
  ctx: Omit<PlannerContext, 'budget'> & Partial<Pick<PlannerContext, 'budget'>>,
  options: QueryOptions = {},
): QueryPlan => {
  const candidates = ranked(raw);
  const chosen = pick(candidates, options.kind);
  const ambiguous = isAmbiguous(candidates);

  if (chosen === undefined) {
    return { input: raw.trim(), candidates, ambiguous, hidden: [] };
  }

  const plan = expand(
    registry,
    chosen.kind,
    { ...ctx, budget: ctx.budget ?? DEFAULT_BUDGET },
    options.depth ?? 1,
  );

  return {
    input: raw.trim(),
    candidates,
    chosen,
    ambiguous,
    plan,
    hidden: groupExclusions(plan),
  };
};
