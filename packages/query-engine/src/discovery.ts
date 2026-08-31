/**
 * Automatic discovery of new tools (Part 2 §56).
 *
 * Periodically something looks at the outside world — new repositories, new open-source projects,
 * releases, alternatives — and this module decides which of those findings are worth a sentence in
 * the UI. Fetching is the host's job (a release feed, a registry index, an agent); judging is this
 * module's, so it is pure, offline and testable.
 *
 * Three honest rules keep the notifications rare enough to still be read:
 *   - never propose what is already installed at that version or newer;
 *   - never propose what the user has ignored;
 *   - never propose what this host could not run anyway (reported as `review`, not `install`).
 * Nothing installs itself: every finding ends in the user's hands — Review / Install / Ignore.
 */

import type { CatalogEntry } from './catalog.ts';

export interface ToolCandidate {
  /** Stable id of the project, e.g. `github:sherlock-project/sherlock`. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capability: string;
  readonly runtime: string;
  readonly url: string;
  readonly licence?: string;
  /** ISO timestamp of the release or first sighting; used only for ordering. */
  readonly seenAt: string;
  readonly summary?: string;
}

export type FindingKind = 'new-tool' | 'alternative' | 'update';
export type DiscoveryAction = 'review' | 'install' | 'ignore';

export interface DiscoveryFinding {
  readonly candidate: ToolCandidate;
  readonly kind: FindingKind;
  /** The engine this would replace or update; absent for a genuinely new capability. */
  readonly replaces?: string;
  /** The one line shown in the activity feed. */
  readonly headline: string;
  /** Offered buttons, in order. `install` is missing when this host cannot run the candidate. */
  readonly actions: readonly DiscoveryAction[];
}

export interface DiscoveryContext {
  readonly catalog: readonly CatalogEntry[];
  /** Candidate ids the user has already dismissed. */
  readonly ignored?: ReadonlySet<string>;
  /** Runtimes this build has an adapter for; a candidate outside it can be read, not installed. */
  readonly supportedRuntimes: ReadonlySet<string>;
}

/** Numeric-aware comparison; anything unparseable sorts as 0 rather than throwing. */
const compareVersions = (a: string, b: string): number => {
  const parts = (value: string): number[] => value.split(/[.-]/).map((part) => Number(part) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const headlineFor = (
  kind: FindingKind,
  candidate: ToolCandidate,
  replaces: string | undefined,
): string => {
  if (kind === 'update')
    return `${candidate.name} ${candidate.version} is out — the installed ${replaces ?? candidate.name} is older.`;
  if (kind === 'alternative')
    return `A supported alternative to ${replaces ?? 'an unusable engine'} was found: ${candidate.name}.`;
  return `New tool for ${candidate.capability}: ${candidate.name}.`;
};

/** Classify one candidate against what is already in the catalogue. Undefined = nothing to say. */
const classify = (
  candidate: ToolCandidate,
  catalog: readonly CatalogEntry[],
): { readonly kind: FindingKind; readonly replaces?: string } | undefined => {
  const sameEngine = catalog.find((entry) => entry.engine === candidate.name);
  if (sameEngine) {
    if (compareVersions(candidate.version, sameEngine.version) <= 0) return undefined;
    return { kind: 'update', replaces: sameEngine.engine };
  }
  // An engine the user cannot actually use is the strongest reason to surface a substitute.
  const stranded = catalog.find(
    (entry) =>
      entry.capabilities.includes(candidate.capability) &&
      (entry.state === 'deprecated' || entry.state === 'incompatible'),
  );
  if (stranded) return { kind: 'alternative', replaces: stranded.engine };
  const covered = catalog.some(
    (entry) => entry.capabilities.includes(candidate.capability) && entry.state === 'installed',
  );
  // Something already covers this capability and works: not news.
  return covered ? undefined : { kind: 'new-tool' };
};

/** Newest first, because a discovery list is read from the top and abandoned halfway. */
export const discoverTools = (
  candidates: readonly ToolCandidate[],
  ctx: DiscoveryContext,
): readonly DiscoveryFinding[] =>
  candidates
    .filter((candidate) => ctx.ignored?.has(candidate.id) !== true)
    .flatMap((candidate) => {
      const verdict = classify(candidate, ctx.catalog);
      if (!verdict) return [];
      const installable = ctx.supportedRuntimes.has(candidate.runtime);
      return [
        {
          candidate,
          kind: verdict.kind,
          ...(verdict.replaces === undefined ? {} : { replaces: verdict.replaces }),
          headline: headlineFor(verdict.kind, candidate, verdict.replaces),
          actions: installable
            ? (['review', 'install', 'ignore'] as const)
            : (['review', 'ignore'] as const),
        },
      ];
    })
    .sort((a, b) => b.candidate.seenAt.localeCompare(a.candidate.seenAt));

/** Whether the periodic scan is due. Kept here so the schedule is one fact, not one per caller. */
export const DISCOVERY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export const isScanDue = (lastScanAt: number | undefined, now: number): boolean =>
  lastScanAt === undefined || now - lastScanAt >= DISCOVERY_INTERVAL_MS;
