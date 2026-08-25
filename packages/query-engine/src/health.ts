/**
 * Engine health and runtime policy (Part 2 §27, §29, §30, §31).
 *
 * An analyst has to be able to answer "is the tool broken, or is the target clean?" without
 * reading logs. Health is therefore *derived from run history* — never self-reported by an
 * engine — so a service that lies about itself still shows up as failing here.
 *
 * Policy (§30/§31) lives next to it because the two are read together: the health row shows what
 * happened, the policy row shows the ceilings that shaped it and the actions available now.
 * Nothing in this module executes anything; `executePlan` remains the only runner (N5/U5).
 */

import type { EngineId, RunRecord } from '@nexus/transforms';

/** What the status dot means. `unknown` = never run in this session, not "broken". */
export type HealthState = 'online' | 'degraded' | 'offline' | 'disabled' | 'ignored' | 'unknown';

export const HEALTH_LABEL: Record<HealthState, string> = {
  online: 'Online',
  degraded: 'Degraded',
  offline: 'Offline',
  disabled: 'Disabled',
  ignored: 'Ignored',
  unknown: 'Not run yet',
};

/** §30: what the analyst may do with one engine. `ignore` keeps it running but drops its noise. */
export type EngineAction = 'retry' | 'retry-failed' | 'restart' | 'disable' | 'enable' | 'ignore';

/** §31 ceilings. Every engine has them; there is no "unlimited" option on purpose. */
export interface EngineLimits {
  readonly startupTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly memoryLimitMb: number;
  readonly concurrency: number;
}

export interface EnginePolicy {
  readonly limits: EngineLimits;
  /** Disabled engines are not planned at all; ignored ones run but never surface warnings. */
  readonly disabled: boolean;
  readonly ignored: boolean;
  readonly maxRetries: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  startupTimeoutMs: 5_000,
  executionTimeoutMs: 30_000,
  memoryLimitMb: 256,
  concurrency: 2,
};

export const DEFAULT_POLICY: EnginePolicy = {
  limits: DEFAULT_LIMITS,
  disabled: false,
  ignored: false,
  maxRetries: 1,
};

export interface EngineHealth {
  readonly engine: EngineId;
  readonly state: HealthState;
  readonly runs: number;
  readonly failures: number;
  /** Failures since the last success — one flake is noise, four in a row is an outage. */
  readonly consecutiveFailures: number;
  readonly successRate: number;
  /** Mean wall-clock of the runs we have, in ms. 0 when nothing ran. */
  readonly responseMs: number;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  /** Steps handed to this engine and not finished yet (§27 "queue"). */
  readonly queued: number;
  readonly timeouts: number;
}

/** A run that ended in `partial` still produced data: it is degraded, not a failure. */
const FAILED: ReadonlySet<string> = new Set(['failed', 'cancelled']);
const DEGRADED_RUN: ReadonlySet<string> = new Set(['partial']);

const TIMEOUT_HINT = /timed? ?out|deadline/i;

/** Four failures with no success in between is an outage, not a bad target. */
const OFFLINE_STREAK = 3;
const DEGRADED_RATE = 0.8;

export interface HealthInput {
  readonly runs: readonly RunRecord[];
  readonly policy?: EnginePolicy;
  /** Steps dispatched but not yet recorded, per engine. */
  readonly queued?: number;
}

export const engineHealth = (engine: EngineId, input: HealthInput): EngineHealth => {
  const policy = input.policy ?? DEFAULT_POLICY;
  const runs = input.runs.filter((run) => run.engine === engine);
  const queued = input.queued ?? 0;

  let failures = 0;
  let timeouts = 0;
  let degraded = 0;
  let totalMs = 0;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;

  for (const run of runs) {
    totalMs += Math.max(0, run.finishedAt - run.startedAt);
    const failed = FAILED.has(run.status);
    if (failed) {
      failures += 1;
      lastFailureAt = Math.max(lastFailureAt ?? 0, run.finishedAt);
      if (run.errors.some((error) => TIMEOUT_HINT.test(error))) timeouts += 1;
    } else {
      if (DEGRADED_RUN.has(run.status)) degraded += 1;
      lastSuccessAt = Math.max(lastSuccessAt ?? 0, run.finishedAt);
    }
  }

  const ordered = [...runs].sort((a, b) => a.finishedAt - b.finishedAt);
  let consecutiveFailures = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const run = ordered[i];
    if (run === undefined || !FAILED.has(run.status)) break;
    consecutiveFailures += 1;
  }

  const successRate = runs.length === 0 ? 0 : (runs.length - failures) / runs.length;
  const state = ((): HealthState => {
    if (policy.disabled) return 'disabled';
    if (policy.ignored) return 'ignored';
    if (runs.length === 0) return queued > 0 ? 'online' : 'unknown';
    if (consecutiveFailures > OFFLINE_STREAK) return 'offline';
    if (failures > 0 || degraded > 0 || successRate < DEGRADED_RATE) return 'degraded';
    return 'online';
  })();

  return {
    engine,
    state,
    runs: runs.length,
    failures,
    consecutiveFailures,
    successRate,
    responseMs: runs.length === 0 ? 0 : Math.round(totalMs / runs.length),
    lastSuccessAt,
    lastFailureAt,
    queued,
    timeouts,
  };
};

export const healthReport = (
  engines: readonly EngineId[],
  runs: readonly RunRecord[],
  policies: Readonly<Partial<Record<EngineId, EnginePolicy>>> = {},
  queued: Readonly<Partial<Record<EngineId, number>>> = {},
): readonly EngineHealth[] =>
  engines.map((engine) =>
    engineHealth(engine, {
      runs,
      ...(policies[engine] ? { policy: policies[engine] } : {}),
      ...(queued[engine] === undefined ? {} : { queued: queued[engine] }),
    }),
  );

/** §29: one dead engine degrades the answer, it never fails the query. */
export const runIsUsable = (report: readonly EngineHealth[]): boolean =>
  report.some((row) => row.state === 'online' || row.state === 'degraded');

/**
 * §30: which runs an action would re-execute. `retry-failed` picks only the broken ones;
 * `restart` replays everything the engine did, because a restarted service has no warm state.
 */
export const retryTargets = (
  runs: readonly RunRecord[],
  engine: EngineId,
  action: EngineAction,
): readonly RunRecord[] => {
  const mine = runs.filter((run) => run.engine === engine);
  if (action === 'retry-failed') return mine.filter((run) => FAILED.has(run.status));
  if (action === 'retry' || action === 'restart') return mine;
  return [];
};

/** Applies a §30 action to a policy. Retries do not change policy; they change what runs. */
export const applyAction = (policy: EnginePolicy, action: EngineAction): EnginePolicy => {
  switch (action) {
    case 'disable':
      return { ...policy, disabled: true };
    case 'enable':
      return { ...policy, disabled: false, ignored: false };
    case 'ignore':
      return { ...policy, ignored: true };
    default:
      return policy;
  }
};
