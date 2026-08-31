/**
 * Cost and resource awareness for the planner (Part 2 §42).
 *
 * Some engines are expensive: amass walks a domain for a minute, sherlock is a containerized
 * python process, an external-api engine spends someone's quota. The planner already knew what
 * *could* run; this module tells it what a step would **cost** on this host, so an expensive run
 * only happens where it is actually worth it.
 *
 * Seven dimensions, all read off manifests that already exist — nothing here is folklore:
 * CPU and RAM (the engine's runtime passport, §34/§39), execution time (transform limits),
 * network requests (data flow + pagination), API limits (provider quota), queue (an `external`
 * deployment waits for a worker, §36) and service availability (provider status).
 *
 * It is a pure estimator plus a per-step gate. Concurrency-wide accounting stays where it
 * belongs — the runtime resource manager (§32) admits or refuses actual runs; a plan that fits
 * here can still be throttled there, and that is the correct division: this layer decides
 * whether asking is reasonable, that one decides whether the box can take it right now.
 */

import { resolveRuntime } from './runtime.ts';
import type {
  EngineId,
  EngineManifest,
  ExclusionReason,
  ExecutionClass,
  ProviderManifest,
  TransformManifest,
} from './types.ts';

/** How expensive one class is allowed to be, cheapest first. `optional` is the escape hatch. */
const CLASS_ORDER: readonly ExecutionClass[] = ['fast', 'standard', 'optional', 'deep'];

const classRank = (value: ExecutionClass): number => CLASS_ORDER.indexOf(value);

export type ServiceAvailability = 'ready' | 'degraded' | 'unavailable';

const AVAILABILITY: Readonly<Record<ProviderManifest['status'], ServiceAvailability>> = {
  configured: 'ready',
  'not-configured': 'ready', // keyless engines are the normal case (U3), not a degraded one
  'rate-limited': 'degraded',
  invalid: 'unavailable',
  disabled: 'unavailable',
  unavailable: 'unavailable',
  deprecated: 'unavailable',
};

export interface CostProfile {
  readonly engine: EngineId;
  /** The manifest's own verdict on how heavy a run is. */
  readonly executionClass: ExecutionClass;
  readonly cpu: number;
  readonly memoryMb: number;
  readonly runtimeMs: number;
  /** Expected outbound requests: 0 for a local engine, one per result page otherwise. */
  readonly networkRequests: number;
  /** Fraction of the provider's per-minute quota one run claims; absent when no quota is stated. */
  readonly quotaShare?: number;
  /**
   * How long the provider's rate limit alone would stretch this run. Reported, not gated: a rate
   * limit is a reason to pace a step (`EngineLimits`, §31), not a reason to refuse the answer.
   */
  readonly paceMs?: number;
  /** Requests the provider allows per day, when stated. */
  readonly dailyQuota?: number;
  /** True when the engine runs off-box and has to wait for a remote worker (§36). */
  readonly queued: boolean;
  readonly availability: ServiceAvailability;
}

/**
 * Pagination estimate: a transform that returns more results than it can take inputs per call is
 * assumed to page through them. Wrong by a page or two is fine; wrong by an order of magnitude —
 * which "one request per engine" would be for a subdomain sweep — is not.
 */
const requestCount = (engine: EngineManifest, transform: TransformManifest): number => {
  if (engine.dataFlow === 'local') return 0;
  const { maxResults, maxInputBatch } = transform.limits;
  return Math.max(1, Math.ceil(maxResults / Math.max(1, maxInputBatch)));
};

export const costProfile = (
  transform: TransformManifest,
  engine: EngineManifest,
  provider: ProviderManifest,
): CostProfile => {
  const runtime = resolveRuntime(engine);
  const networkRequests = requestCount(engine, transform);
  const perMinute = provider.limits.requestsPerMinute;
  const perDay = provider.limits.requestsPerDay;
  return {
    engine: engine.id,
    executionClass: engine.cost,
    cpu: runtime.requirements.cpu,
    memoryMb: runtime.requirements.memoryMb,
    runtimeMs: transform.limits.expectedRuntimeMs,
    networkRequests,
    ...(perMinute === undefined || perMinute <= 0
      ? {}
      : {
          quotaShare: networkRequests / perMinute,
          paceMs: Math.ceil((networkRequests / perMinute) * 60_000),
        }),
    ...(perDay === undefined ? {} : { dailyQuota: perDay }),
    queued: runtime.deployment === 'external',
    availability: AVAILABILITY[provider.status],
  };
};

export interface CostCeiling {
  /** The most expensive execution class a step may belong to. */
  readonly maxExecutionClass: ExecutionClass;
  readonly cpu: number;
  readonly memoryMb: number;
  readonly runtimeMs: number;
  readonly networkRequests: number;
  /** May a step sit in the remote queue instead of running here? */
  readonly allowQueued: boolean;
  /** May a rate-limited provider still be used? */
  readonly allowDegraded: boolean;
  /**
   * An expensive step (a class above `standard`) has to earn its place: the router score is the
   * planner's estimate of how good the answer will be, and below this it is not worth the minute.
   */
  readonly minValueForExpensive: number;
}

/** Conservative defaults, matched to the VPS profile in 29_RUNTIME_ENVIRONMENT.md §7. */
export const DEFAULT_COST_CEILING: CostCeiling = {
  maxExecutionClass: 'deep',
  cpu: 2,
  memoryMb: 1_024,
  runtimeMs: 120_000,
  networkRequests: 200,
  allowQueued: true,
  allowDegraded: false,
  minValueForExpensive: 0.35,
};

export type CostVerdict =
  | { readonly ok: true; readonly profile: CostProfile }
  | {
      readonly ok: false;
      readonly profile: CostProfile;
      readonly reason: ExclusionReason;
      /** One sentence an analyst can read; the plan shows it instead of silently shrinking. */
      readonly note: string;
    };

/**
 * The gate. `value` is the router score of the transform (0..1): the only place where "is this
 * expensive run useful?" can be answered, because usefulness is quality × priority, not a guess.
 */
export const costVerdict = (
  profile: CostProfile,
  value: number,
  ceiling: CostCeiling = DEFAULT_COST_CEILING,
): CostVerdict => {
  const no = (reason: ExclusionReason, note: string): CostVerdict => ({
    ok: false,
    profile,
    reason,
    note,
  });

  if (profile.availability === 'unavailable') {
    return no('engine-unavailable', `${profile.engine}: the service is not answering`);
  }
  if (profile.availability === 'degraded' && !ceiling.allowDegraded) {
    return no('provider-rate-limited', `${profile.engine}: the provider is rate limited`);
  }
  if (profile.queued && !ceiling.allowQueued) {
    return no('engine-unavailable', `${profile.engine} runs off-box and the queue is not enabled`);
  }
  if (classRank(profile.executionClass) > classRank(ceiling.maxExecutionClass)) {
    return no(
      'over-resource-budget',
      `${profile.engine} is a ${profile.executionClass} engine, this scan allows up to ${ceiling.maxExecutionClass}`,
    );
  }
  if (profile.cpu > ceiling.cpu) {
    return no(
      'over-resource-budget',
      `${profile.engine} wants ${String(profile.cpu)} CPU, the ceiling is ${String(ceiling.cpu)}`,
    );
  }
  if (profile.memoryMb > ceiling.memoryMb) {
    return no(
      'over-resource-budget',
      `${profile.engine} wants ${String(profile.memoryMb)} MB of RAM, the ceiling is ${String(ceiling.memoryMb)} MB`,
    );
  }
  if (profile.runtimeMs > ceiling.runtimeMs) {
    return no(
      'over-resource-budget',
      `${profile.engine} takes about ${String(Math.round(profile.runtimeMs / 1000))} s, the ceiling is ${String(Math.round(ceiling.runtimeMs / 1000))} s`,
    );
  }
  if (profile.networkRequests > ceiling.networkRequests) {
    return no(
      'over-resource-budget',
      `${profile.engine} would make about ${String(profile.networkRequests)} requests, the ceiling is ${String(ceiling.networkRequests)}`,
    );
  }
  if (profile.dailyQuota !== undefined && profile.networkRequests > profile.dailyQuota) {
    // The only quota case that is a refusal rather than a pacing problem: the run cannot finish
    // inside the provider's daily allowance no matter how patient the scheduler is.
    return no(
      'over-resource-budget',
      `${profile.engine} needs about ${String(profile.networkRequests)} requests, the provider allows ${String(profile.dailyQuota)} a day`,
    );
  }
  if (
    classRank(profile.executionClass) > classRank('standard') &&
    value < ceiling.minValueForExpensive
  ) {
    return no(
      'cost-not-justified',
      `${profile.engine} is expensive and this input scores ${value.toFixed(2)}: not worth the run`,
    );
  }
  return { ok: true, profile };
};
