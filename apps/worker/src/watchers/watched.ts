/**
 * What the watchers watch (26_OPEN_SOURCE_REGISTRY.md §5.1).
 *
 * The passports live in prose; this is the machine-readable slice of them — the few fields a
 * read-only watcher needs to notice drift. Every row states where its facts came from and when, so
 * a stale row is visible rather than silently trusted.
 */

export interface WatchedEngine {
  readonly id: string;
  /** `owner/repo` on GitHub. Watchers do nothing for an engine without an upstream repo. */
  readonly repo: string;
  /** The version this repository pins, exactly as the manifest states it. */
  readonly pinnedVersion?: string;
  /** SPDX id recorded at adoption; a change is a re-review trigger, never an auto-update. */
  readonly licence: string;
  /** ISO date the two facts above were last read from a primary source. */
  readonly verifiedOn: string;
}

export const WATCHED_ENGINES: readonly WatchedEngine[] = [
  {
    id: 'sherlock',
    repo: 'sherlock-project/sherlock',
    pinnedVersion: 'v0.16.0',
    licence: 'MIT',
    verifiedOn: '2026-08-23',
  },
  {
    id: 'subfinder',
    repo: 'projectdiscovery/subfinder',
    licence: 'MIT',
    verifiedOn: '2026-08-24',
  },
  {
    id: 'amass',
    repo: 'owasp-amass/amass',
    licence: 'Apache-2.0',
    verifiedOn: '2026-08-24',
  },
  {
    id: 'spiderfoot',
    repo: 'smicallef/spiderfoot',
    licence: 'MIT',
    verifiedOn: '2026-08-24',
  },
];
