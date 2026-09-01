/**
 * Provider pacing (§65 performance architecture).
 *
 * Parallelism is bounded by *our* box (`resources.ts`) and by the plan's `maxParallel` — neither of
 * which knows that crt.sh answers ten requests a minute and then starts returning 502s. A provider
 * limit is not our resource, it is theirs, and the polite way to respect it is to space requests
 * out rather than to burn the quota in the first two seconds of a run and call the rest "failed".
 *
 * So this is a per-provider clock, fed by `ProviderManifest.limits`:
 *  - `requestsPerMinute` becomes a minimum interval between two calls to that provider, shared by
 *    every step running concurrently in the process;
 *  - `requestsPerDay` becomes a hard stop that refuses instead of waiting — a run that would sit
 *    for six hours is not a slow run, it is a wrong answer to give an analyst (U5).
 *
 * It never opens a socket. It grants the right to make one, later.
 */

import type { ProviderId, ProviderManifest } from '@nexus/transforms';

export type PaceVerdict =
  | { readonly ok: true; readonly waitedMs: number }
  | { readonly ok: false; readonly reason: 'daily-quota'; readonly message: string };

export interface Pacer {
  /** Resolves when the caller may call this provider; refuses when the daily quota is gone. */
  readonly take: (provider: ProviderManifest) => Promise<PaceVerdict>;
  /** Calls charged to this provider in the current day window — for the run report. */
  readonly used: (provider: ProviderId) => number;
}

export interface PacerOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Longest a single step is willing to sit in the queue. Beyond it the pacer still grants the
   * slot: refusing here would drop coverage for a limit that is merely inconvenient, and the run's
   * own wall-clock budget is what ends a run that has waited too long.
   */
  readonly maxWaitMs?: number;
}

const DAY_MS = 86_400_000;

interface ProviderClock {
  nextFreeAt: number;
  windowStart: number;
  used: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createPacer = (options: PacerOptions = {}): Pacer => {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const clocks = new Map<ProviderId, ProviderClock>();

  const clockFor = (id: ProviderId, at: number): ProviderClock => {
    const existing = clocks.get(id);
    if (existing === undefined) {
      const fresh: ProviderClock = { nextFreeAt: at, windowStart: at, used: 0 };
      clocks.set(id, fresh);
      return fresh;
    }
    if (at - existing.windowStart >= DAY_MS) {
      existing.windowStart = at;
      existing.used = 0;
    }
    return existing;
  };

  return {
    take: async (provider: ProviderManifest): Promise<PaceVerdict> => {
      const at = now();
      const clock = clockFor(provider.id, at);
      const perDay = provider.limits.requestsPerDay;
      if (perDay !== undefined && clock.used >= perDay) {
        return {
          ok: false,
          reason: 'daily-quota',
          message: `${provider.name}: daily quota of ${String(perDay)} requests is spent; the step was skipped rather than queued for tomorrow`,
        };
      }
      clock.used += 1;

      const perMinute = provider.limits.requestsPerMinute;
      if (perMinute === undefined || perMinute <= 0) return { ok: true, waitedMs: 0 };

      const interval = 60_000 / perMinute;
      const slot = Math.max(at, clock.nextFreeAt);
      clock.nextFreeAt = slot + interval;
      const waitMs = Math.min(slot - at, maxWaitMs);
      if (waitMs > 0) await sleep(waitMs);
      return { ok: true, waitedMs: Math.max(0, waitMs) };
    },
    used: (provider: ProviderId): number => clocks.get(provider)?.used ?? 0,
  };
};
