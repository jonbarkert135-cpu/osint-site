/**
 * The watcher queue (§5.1: "scheduled jobs in `apps/worker`").
 *
 * Cadences come straight from the design table: releases and advisories move daily, liveness and
 * licences move slowly. Repeatable jobs carry a fixed id so a redeploy re-registers the same
 * schedule instead of stacking a second one.
 */

import type { Queue } from 'bullmq';

import { runWatcher, type DriftFinding, type WatcherDeps, type WatcherName } from './checks.ts';
import { appendFindings } from './store.ts';
import { WATCHED_ENGINES } from './watched.ts';

export const WATCHER_QUEUE = 'registry.watch';

/** UTC crons, off the hour: nothing else in this deployment runs at 04:40. */
export const WATCHER_SCHEDULE: Readonly<Record<WatcherName, string>> = {
  'release-watch': '40 4 * * *',
  'liveness-watch': '40 5 * * 1',
  'license-watch': '10 6 * * 1',
};

/** Anonymous, read-only GitHub JSON. A token lifts the 60 req/h limit when one is configured. */
export const githubGet = async (path: string): Promise<unknown> => {
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'raven-registry-watcher',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    // A rate-limited or missing resource is "could not verify", which the checks record as such.
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
};

export const processWatcherJob = async (
  name: WatcherName,
  deps: WatcherDeps,
  options: { readonly dir?: string } = {},
): Promise<readonly DriftFinding[]> => {
  const findings = await runWatcher(name, WATCHED_ENGINES, deps);
  await appendFindings(findings, options);
  return findings;
};

export const registerWatcherSchedule = async (queue: Queue): Promise<void> => {
  for (const [name, pattern] of Object.entries(WATCHER_SCHEDULE)) {
    await queue.add(name, {}, { repeat: { pattern }, jobId: `schedule:${name}` });
  }
};
