/**
 * Discovery watchers — Part 2 §7, designed in `26_OPEN_SOURCE_REGISTRY.md` §5.1.
 *
 * Three rules make these safe to run unattended:
 *  - **read-only**: a watcher raises a drift finding, it never edits a passport. A human merges.
 *  - **never guess**: anything the watcher could not read is recorded as `unverified`, not assumed
 *    unchanged. An unverified result is never written as a fact.
 *  - **pure checks**: fetching is injected, so every rule below is testable without a network and
 *    without a GitHub token.
 */

import type { WatchedEngine } from './watched.ts';

export type WatcherName = 'release-watch' | 'liveness-watch' | 'license-watch';

export type DriftSeverity = 'info' | 'review' | 'block';

export interface DriftFinding {
  readonly watcher: WatcherName;
  readonly engine: string;
  /** ISO date of the check. The record is dated so a future reader can judge its freshness. */
  readonly at: string;
  readonly status: 'ok' | 'drift' | 'unverified';
  readonly severity: DriftSeverity;
  readonly detail: string;
  /** The primary source the finding was read from, so it can be re-checked by hand. */
  readonly source: string;
}

/** Injected: a read-only GitHub GET returning parsed JSON, or undefined when it could not read. */
export type GithubGet = (path: string) => Promise<unknown>;

export interface WatcherDeps {
  readonly github: GithubGet;
  readonly now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const unverified = (
  watcher: WatcherName,
  engine: WatchedEngine,
  at: string,
  source: string,
  detail: string,
): DriftFinding => ({
  watcher,
  engine: engine.id,
  at,
  status: 'unverified',
  severity: 'info',
  detail,
  source,
});

/** No push in this long means the project is dormant, per §5.1. */
export const DORMANT_MS = 365 * 24 * 60 * 60 * 1000;

export const releaseWatch = async (
  engine: WatchedEngine,
  deps: WatcherDeps,
): Promise<DriftFinding> => {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const source = `https://api.github.com/repos/${engine.repo}/releases/latest`;
  if (engine.pinnedVersion === undefined) {
    return unverified('release-watch', engine, at, source, 'no version is pinned for this engine');
  }

  const body = await deps.github(`/repos/${engine.repo}/releases/latest`);
  const latest = isRecord(body) ? str(body['tag_name']) : undefined;
  if (latest === undefined) {
    return unverified('release-watch', engine, at, source, 'the latest release could not be read');
  }

  return latest === engine.pinnedVersion
    ? {
        watcher: 'release-watch',
        engine: engine.id,
        at,
        status: 'ok',
        severity: 'info',
        detail: `pinned at ${engine.pinnedVersion}, which is still the latest release`,
        source,
      }
    : {
        watcher: 'release-watch',
        engine: engine.id,
        at,
        status: 'drift',
        severity: 'review',
        detail: `upstream released ${latest}; this repository pins ${engine.pinnedVersion}`,
        source,
      };
};

export const livenessWatch = async (
  engine: WatchedEngine,
  deps: WatcherDeps,
): Promise<DriftFinding> => {
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const source = `https://api.github.com/repos/${engine.repo}`;

  const body = await deps.github(`/repos/${engine.repo}`);
  if (!isRecord(body)) {
    return unverified(
      'liveness-watch',
      engine,
      at,
      source,
      'repository metadata could not be read',
    );
  }

  if (body['archived'] === true) {
    return {
      watcher: 'liveness-watch',
      engine: engine.id,
      at,
      status: 'drift',
      severity: 'review',
      detail: 'upstream repository is archived — propose a tier demotion',
      source,
    };
  }

  const pushedAt = str(body['pushed_at']);
  const pushed = pushedAt === undefined ? Number.NaN : Date.parse(pushedAt);
  if (Number.isNaN(pushed)) {
    return unverified('liveness-watch', engine, at, source, 'no readable `pushed_at` timestamp');
  }

  const idleMs = now.getTime() - pushed;
  return idleMs > DORMANT_MS
    ? {
        watcher: 'liveness-watch',
        engine: engine.id,
        at,
        status: 'drift',
        severity: 'review',
        detail: `no push since ${pushedAt} — propose a tier demotion`,
        source,
      }
    : {
        watcher: 'liveness-watch',
        engine: engine.id,
        at,
        status: 'ok',
        severity: 'info',
        detail: `last push ${pushedAt}`,
        source,
      };
};

/**
 * A licence change is a blocking finding, not a note: adoption rests on the licence that was read,
 * so any change means the engine is unadopted until someone reads the new text (§5.3 veto gate).
 */
export const licenseWatch = async (
  engine: WatchedEngine,
  deps: WatcherDeps,
): Promise<DriftFinding> => {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const source = `https://api.github.com/repos/${engine.repo}/license`;

  const body = await deps.github(`/repos/${engine.repo}/license`);
  const spdx =
    isRecord(body) && isRecord(body['license']) ? str(body['license']['spdx_id']) : undefined;
  if (spdx === undefined || spdx === 'NOASSERTION') {
    return unverified(
      'license-watch',
      engine,
      at,
      source,
      spdx === 'NOASSERTION' ? 'GitHub cannot identify the licence' : 'licence could not be read',
    );
  }

  return spdx === engine.licence
    ? {
        watcher: 'license-watch',
        engine: engine.id,
        at,
        status: 'ok',
        severity: 'info',
        detail: `licence is still ${spdx}`,
        source,
      }
    : {
        watcher: 'license-watch',
        engine: engine.id,
        at,
        status: 'drift',
        severity: 'block',
        detail: `licence changed from ${engine.licence} (recorded ${engine.verifiedOn}) to ${spdx} — re-review before any further use`,
        source,
      };
};

export const WATCHERS: Readonly<
  Record<WatcherName, (engine: WatchedEngine, deps: WatcherDeps) => Promise<DriftFinding>>
> = {
  'release-watch': releaseWatch,
  'liveness-watch': livenessWatch,
  'license-watch': licenseWatch,
};

/**
 * Runs one watcher over every engine. Sequential on purpose: watchers are rate-limit-aware and this
 * is a background job with no deadline — hammering GitHub to finish four checks faster is how the
 * anonymous 60 req/h limit gets hit.
 */
export const runWatcher = async (
  name: WatcherName,
  engines: readonly WatchedEngine[],
  deps: WatcherDeps,
): Promise<readonly DriftFinding[]> => {
  const check = WATCHERS[name];
  const findings: DriftFinding[] = [];
  for (const engine of engines) {
    findings.push(await check(engine, deps));
  }
  return findings;
};
