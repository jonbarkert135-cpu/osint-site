/**
 * Username watchlist scheduling (13_SHERLOCK.md §6.6).
 *
 * A watch re-runs a username-enumeration tool for one handle on a cadence. Everything that decides *whether* and
 * *when* a watch runs lives here as pure functions, so the API (quota checks at create time) and
 * the worker tick (due list, consent re-check, next slot) cannot drift apart.
 *
 * Two rules from the spec are load-bearing:
 *  - a standing consent expires after 90 days and the watch then **auto-pauses** instead of running;
 *  - a scheduled result is a *pending* diff for review, never an auto-applied change (N4). That is
 *    enforced by the caller, but `planWatchTick` never returns anything stronger than 'run'.
 */

export const WATCH_CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type WatchCadence = (typeof WATCH_CADENCES)[number];

export type WatchNotifyOn = 'appeared' | 'disappeared' | 'becameUnknown';

/** Spec §6.6: 25 watches per project, 100 per instance. */
export const WATCH_QUOTA_PROJECT = 25;
export const WATCH_QUOTA_INSTANCE = 100;

/** A standing consent is good for 90 days (§6.6, §7.2). */
export const WATCH_CONSENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const CADENCE_MS: Record<WatchCadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export interface UsernameWatch {
  id: string;
  nodeId: string;
  handle: string;
  projectId: string;
  createdBy: string;
  cadence: WatchCadence;
  /** null = the tool's full site list. */
  sites: string[] | null;
  notifyOn: WatchNotifyOn[];
  consentId: string;
  pausedAt: Date | null;
  lastRunId: string | null;
  nextRunAt: Date;
}

/**
 * The next slot, jittered ±10% so a hundred watches created by one import do not all fire in the
 * same second. `random` is injectable purely so tests are not flaky.
 */
export function nextRunAt(
  cadence: WatchCadence,
  from: Date,
  random: () => number = Math.random,
): Date {
  const base = CADENCE_MS[cadence];
  const jitter = base * 0.1 * (random() * 2 - 1);
  return new Date(from.getTime() + base + Math.round(jitter));
}

/** True once the standing consent is older than 90 days. */
export function consentExpired(acceptedAt: Date, now: Date): boolean {
  return now.getTime() - acceptedAt.getTime() > WATCH_CONSENT_MAX_AGE_MS;
}

export interface WatchQuotaCounts {
  project: number;
  instance: number;
}

export type QuotaVerdict = { ok: true } | { ok: false; reason: string };

/** Checked before a watch is created; the message is user-facing. */
export function checkWatchQuota(counts: WatchQuotaCounts): QuotaVerdict {
  if (counts.instance >= WATCH_QUOTA_INSTANCE) {
    return {
      ok: false,
      reason: `This instance already has ${String(WATCH_QUOTA_INSTANCE)} watches. Remove one before adding another.`,
    };
  }
  if (counts.project >= WATCH_QUOTA_PROJECT) {
    return {
      ok: false,
      reason: `This project already has ${String(WATCH_QUOTA_PROJECT)} watches. Remove one before adding another.`,
    };
  }
  return { ok: true };
}

export interface WatchTickInput {
  watch: Pick<UsernameWatch, 'id' | 'handle' | 'cadence' | 'pausedAt' | 'nextRunAt'>;
  /** When the standing consent was accepted; null when the record is gone or revoked. */
  consentAcceptedAt: Date | null;
  now: Date;
}

export type WatchTickPlan =
  | { action: 'skip'; reason: 'paused' | 'not-due' }
  | { action: 'pause'; reason: 'consent-expired'; notification: string }
  | { action: 'run'; nextRunAt: Date };

/**
 * What the worker should do with one watch right now. Ordering matters: a paused watch is never
 * looked at again, and consent is re-checked *before* dueness so an expired watch pauses at the
 * next tick rather than at its next slot.
 */
export function planWatchTick(
  input: WatchTickInput,
  random: () => number = Math.random,
): WatchTickPlan {
  const { watch, consentAcceptedAt, now } = input;
  if (watch.pausedAt !== null) return { action: 'skip', reason: 'paused' };
  if (consentAcceptedAt === null || consentExpired(consentAcceptedAt, now)) {
    return {
      action: 'pause',
      reason: 'consent-expired',
      notification: `Re-confirm authorization to keep monitoring @${watch.handle}`,
    };
  }
  if (watch.nextRunAt.getTime() > now.getTime()) return { action: 'skip', reason: 'not-due' };
  return { action: 'run', nextRunAt: nextRunAt(watch.cadence, now, random) };
}
