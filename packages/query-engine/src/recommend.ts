/**
 * Automatic service recommendation (Part 2 §41).
 *
 * A query does not fire every engine in the catalogue. It produces three tiers — Required,
 * Recommended, Optional — so the analyst can hit **Run all** or **Customize** without reading a
 * catalogue. The tiering is data-driven, not folklore: it reads the priority already declared on
 * each transform manifest, and the router's verdict on whether it can run at all.
 *
 * Rules, in order:
 *   1. anything the router refuses (no key, wrong mode, deprecated) → Optional, with the reason;
 *   2. `priority: core`        → Required;
 *   3. `priority: recommended` → Recommended;
 *   4. everything else (optional / experimental / external) → Optional;
 *   5. `priority: deprecated`  → not offered at all.
 * One entry per capability: the best-scoring transform wins, the rest are not shown twice.
 */

import type {
  EntityKind,
  ExclusionReason,
  PlannerContext,
  TransformManifest,
  TransformRegistry,
} from '@nexus/transforms';
import { routeForInput } from '@nexus/transforms';

import { isAmbiguous, typeQuery, type EntityCandidate } from './selectors.ts';

export const SERVICE_TIERS = ['required', 'recommended', 'optional'] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export interface ServiceOffer {
  readonly transform: TransformManifest;
  /** The engine that would actually run it; absent when nothing usable is left in the chain. */
  readonly engine?: string;
  readonly tier: ServiceTier;
  readonly usable: boolean;
  /** Present when `usable` is false: what the analyst would have to fix. */
  readonly reason?: ExclusionReason;
  /** One sentence, shown next to the row. */
  readonly why: string;
  readonly estimatedRuntimeMs: number;
}

export interface ServiceRecommendation {
  readonly input: string;
  readonly kind?: EntityKind;
  readonly ambiguous: boolean;
  readonly candidates: readonly EntityCandidate[];
  readonly tiers: Readonly<Record<ServiceTier, readonly ServiceOffer[]>>;
  /** "Run all": every offer that can actually run, required first. */
  readonly runAll: readonly string[];
  /** "Customize" starts here: required + recommended, the usable ones. */
  readonly defaultSelection: readonly string[];
}

const REASON_TEXT: Readonly<Record<ExclusionReason, string>> = {
  'requires-configuration': 'needs credentials before it can run',
  'paid-only': 'paid provider; the current mode allows free ones only',
  'blocked-by-mode': 'blocked by the current execution mode',
  'provider-rate-limited': 'provider is rate-limited right now',
  'provider-unavailable': 'provider is unavailable',
  'permission-denied': 'the workspace has not granted the permissions it needs',
  'provider-deprecated': 'provider is deprecated',
  'engine-unavailable': 'engine is unavailable',
  'not-executable': 'links out instead of executing',
  'no-engine': 'no engine implements it',
  'budget-exhausted': 'the run budget is already spent',
  'already-covered': 'already run against this entity',
  'over-capacity': 'no free capacity right now',
};

const tierFor = (transform: TransformManifest, usable: boolean): ServiceTier => {
  if (!usable) return 'optional';
  if (transform.priority === 'core') return 'required';
  if (transform.priority === 'recommended') return 'recommended';
  return 'optional';
};

const whyFor = (
  transform: TransformManifest,
  tier: ServiceTier,
  reason: ExclusionReason | undefined,
): string => {
  if (reason) return REASON_TEXT[reason];
  if (tier === 'required') return `core coverage for this entity: ${transform.description}`;
  if (tier === 'recommended') return `broadens coverage: ${transform.description}`;
  return `available if you want it: ${transform.description}`;
};

export interface RecommendOptions {
  /** The analyst overrode the detected entity type. */
  readonly kind?: EntityKind;
}

export const recommendServices = (
  registry: TransformRegistry,
  raw: string,
  ctx: PlannerContext,
  options: RecommendOptions = {},
): ServiceRecommendation => {
  const candidates = [...typeQuery(raw)].sort((a, b) => b.confidence - a.confidence);
  const chosen =
    options.kind === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.kind === options.kind);
  const empty = { required: [], recommended: [], optional: [] } as const;

  if (chosen === undefined) {
    return {
      input: raw.trim(),
      ambiguous: isAmbiguous(candidates),
      candidates,
      tiers: empty,
      runAll: [],
      defaultSelection: [],
    };
  }

  const seen = new Set<string>();
  const offers: ServiceOffer[] = [];

  for (const routed of routeForInput(registry, chosen.kind, ctx)) {
    const { transform } = routed;
    if (transform.priority === 'deprecated') continue;
    if (seen.has(transform.capability)) continue;
    seen.add(transform.capability);

    // The chain is sorted best-first with terminal engines last; a terminal engine executes
    // nothing, so it is not what "run" would use.
    const runner = routed.chain.find((entry) => !entry.engine.terminal);
    const usable = runner !== undefined;
    const tier = tierFor(transform, usable);
    offers.push({
      transform,
      ...(runner ? { engine: runner.engine.id } : {}),
      tier,
      usable,
      ...(routed.reason ? { reason: routed.reason } : {}),
      why: whyFor(transform, tier, routed.reason),
      estimatedRuntimeMs: transform.limits.expectedRuntimeMs,
    });
  }

  const inTier = (tier: ServiceTier): readonly ServiceOffer[] =>
    offers.filter((offer) => offer.tier === tier);

  const runAll = offers.filter((offer) => offer.usable).map((offer) => offer.transform.id);
  const defaultSelection = offers
    .filter((offer) => offer.usable && offer.tier !== 'optional')
    .map((offer) => offer.transform.id);

  return {
    input: raw.trim(),
    kind: chosen.kind,
    ambiguous: isAmbiguous(candidates),
    candidates,
    tiers: {
      required: inTier('required'),
      recommended: inTier('recommended'),
      optional: inTier('optional'),
    },
    runAll,
    defaultSelection,
  };
};
