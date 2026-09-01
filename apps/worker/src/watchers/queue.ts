/**
 * The watcher queue (§5.1: "scheduled jobs in `apps/worker`").
 *
 * Cadences come straight from the design table: releases and advisories move daily, liveness and
 * licences move slowly. Repeatable jobs carry a fixed id so a redeploy re-registers the same
 * schedule instead of stacking a second one.
 */

import type { Queue } from 'bullmq';

import {
  runWatcher,
  type DriftFinding,
  type JsonFetch,
  type WatcherName,
  type WatcherReaders,
} from './checks.ts';
import { appendFindings } from './store.ts';
import { WATCHED_ENGINES } from './watched.ts';

export const WATCHER_QUEUE = 'registry.watch';

/** UTC crons, off the hour: nothing else in this deployment runs at 04:40. */
export const WATCHER_SCHEDULE: Readonly<Record<WatcherName, string>> = {
  'release-watch': '40 4 * * *',
  'vuln-watch': '10 5 * * *',
  'definition-watch': '40 5 * * *',
  'liveness-watch': '40 6 * * 1',
  'license-watch': '10 7 * * 1',
  'endpoint-watch': '40 7 * * 1',
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

/** Read-only JSON over the network, used by the advisory and definition watchers. */
export const jsonFetch: JsonFetch = async (url, init) => {
  try {
    const response = await fetch(url, {
      ...(init === undefined
        ? {}
        : {
            method: init.method,
            body: init.body,
            headers: { 'content-type': 'application/json' },
          }),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
};

/** Read-only page text for the vendor-page watcher. */
export const textFetch = async (url: string): Promise<string | undefined> => {
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'raven-registry-watcher' } });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
};

export const processWatcherJob = async (
  name: WatcherName,
  deps: WatcherReaders,
  options: { readonly dir?: string } = {},
): Promise<readonly DriftFinding[]> => {
  const findings = await runWatcher(name, WATCHED_ENGINES, deps);
  await appendFindings(findings, { ...options, at: deps.now?.() ?? new Date() });
  return findings;
};

export const registerWatcherSchedule = async (queue: Queue): Promise<void> => {
  for (const [name, pattern] of Object.entries(WATCHER_SCHEDULE)) {
    await queue.add(name, {}, { repeat: { pattern }, jobId: `schedule:${name}` });
  }
};
