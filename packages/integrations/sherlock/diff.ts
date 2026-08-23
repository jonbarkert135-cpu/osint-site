/**
 * Re-run diff (13_SHERLOCK.md §6.5).
 *
 * Running the same handle twice is the normal way this tool is used, and the interesting part is
 * never the second result on its own — it is what moved. The one rule that matters here is §6.5.3:
 * a check that *failed* is not evidence that an account was removed. `claimed → error/unknown` is
 * `becameUnknown`, never `disappeared`; only `claimed → available` counts as gone, and even then
 * nothing is deleted (N8) — the caller marks the node instead.
 *
 * Pure: it reads two already-parsed tool payloads, so it works the same in the API, the worker and
 * a test.
 */

import { detectShape, readStatus, safeProfileUrl, type SherlockStatus } from './parser.ts';

export interface SherlockSiteResult {
  readonly site: string;
  readonly status: SherlockStatus;
  readonly url?: string;
}

export interface SherlockDiff {
  handle: string;
  previousRunId: string;
  currentRunId: string;
  previousAt: string;
  currentAt: string;
  digestChanged: boolean;
  /** Sites the tool itself gained or dropped between the two runs. */
  siteListDelta: { added: string[]; removed: string[] };
  appeared: SherlockSiteResult[];
  disappeared: SherlockSiteResult[];
  becameUnknown: SherlockSiteResult[];
  unchanged: number;
}

/**
 * Every site the run reported, claimed or not. The importer keeps only claimed profiles (§5.4),
 * but a diff needs the misses too: without them "appeared" cannot be told from "checked for the
 * first time".
 */
export function siteResults(payload: unknown): SherlockSiteResult[] {
  const { shape, rows } = detectShape(payload);
  if (shape === 'unknown') return [];
  const bySite = new Map<string, SherlockSiteResult>();
  for (const row of rows) {
    if (row.site === '') continue;
    const url = safeProfileUrl(
      row.record.url_user ?? row.record.url ?? row.record.profile_url ?? null,
    );
    bySite.set(row.site, {
      site: row.site,
      status: readStatus(row.record),
      ...(url === undefined ? {} : { url }),
    });
  }
  return [...bySite.values()];
}

export interface SherlockRunSnapshot {
  readonly runId: string;
  readonly at: string;
  readonly imageDigest?: string | undefined;
  /** The raw `--json` payload of that run. */
  readonly payload: unknown;
}

export function diffSherlockRuns(
  handle: string,
  previous: SherlockRunSnapshot,
  current: SherlockRunSnapshot,
): SherlockDiff {
  const before = new Map(siteResults(previous.payload).map((row) => [row.site, row]));
  const after = new Map(siteResults(current.payload).map((row) => [row.site, row]));

  const appeared: SherlockSiteResult[] = [];
  const disappeared: SherlockSiteResult[] = [];
  const becameUnknown: SherlockSiteResult[] = [];
  let unchanged = 0;

  for (const [site, now] of after) {
    const then = before.get(site);
    // A site the previous run never checked is only news when it is a hit.
    if (then === undefined) {
      if (now.status === 'claimed') appeared.push(now);
      continue;
    }
    if (then.status === now.status) {
      unchanged += 1;
      continue;
    }
    if (now.status === 'claimed') appeared.push(now);
    else if (then.status === 'claimed' && now.status === 'available') disappeared.push(now);
    else if (then.status === 'claimed') becameUnknown.push(now);
    else unchanged += 1; // available ↔ error and friends: no claim either way, nothing to report.
  }

  return {
    handle,
    previousRunId: previous.runId,
    currentRunId: current.runId,
    previousAt: previous.at,
    currentAt: current.at,
    digestChanged:
      previous.imageDigest !== undefined &&
      current.imageDigest !== undefined &&
      previous.imageDigest !== current.imageDigest,
    siteListDelta: {
      added: [...after.keys()].filter((site) => !before.has(site)).sort(),
      removed: [...before.keys()].filter((site) => !after.has(site)).sort(),
    },
    appeared,
    disappeared,
    becameUnknown,
    unchanged,
  };
}

/** One line of plain English for the review sheet header — no jargon, no counts of nothing. */
export function describeDiff(diff: SherlockDiff): string {
  const parts: string[] = [];
  if (diff.appeared.length > 0) parts.push(`${String(diff.appeared.length)} new`);
  if (diff.disappeared.length > 0) parts.push(`${String(diff.disappeared.length)} no longer found`);
  if (diff.becameUnknown.length > 0)
    parts.push(`${String(diff.becameUnknown.length)} could not be checked`);
  const head =
    parts.length === 0
      ? `No change for ${diff.handle} since the previous run`
      : `${parts.join(', ')} for ${diff.handle} since the previous run`;
  const digest = diff.digestChanged
    ? ' The tool image changed between the runs, which can itself explain differences.'
    : '';
  const dropped =
    diff.siteListDelta.removed.length > 0
      ? ` ${String(diff.siteListDelta.removed.length)} sites are no longer checked by this version.`
      : '';
  return `${head}.${digest}${dropped}`;
}
