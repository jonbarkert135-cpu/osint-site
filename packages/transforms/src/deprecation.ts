/**
 * Deprecation detection (Part 2 §57).
 *
 * An engine stops being maintained upstream long before anybody edits its manifest, so the manifest
 * alone cannot answer "is this still alive". This module judges an engine against *signals the host
 * collected* — the last release date, an archive flag, upstream advisories, the observed failure
 * rate — and, when the verdict is bad, names a replacement candidate from the registry with the
 * reasons Maks listed: active maintenance, newer runtime, better API, higher compatibility.
 *
 * Pure and offline: fetching release feeds is the worker's job (`apps/worker/src/watchers/`), and an
 * engine with no signals is reported `unverified`, never "fine". A silent default here would be the
 * worst outcome of all — a dead engine that keeps being planned because nobody looked.
 */

import { engineDocument, type EngineDocument } from './document.ts';
import type { TransformRegistry } from './registry.ts';
import type { EngineId, EngineManifest } from './types.ts';

/** What a watcher can find out about an engine's upstream. Every field is optional on purpose. */
export interface DeprecationSignals {
  /** ISO date of the newest upstream release. */
  readonly lastReleaseAt?: string;
  /** Upstream repository is archived or read-only. */
  readonly archived?: boolean;
  /** Upstream says so itself: a README notice, a deprecation banner, a sunset date. */
  readonly upstreamNotice?: string;
  /** Newest upstream version, when it is ahead of the installed one. */
  readonly latestVersion?: string;
  /** Share of failed runs observed by the host, 0..1. */
  readonly failureRate?: number;
  /** Unfixed advisories against the current version. */
  readonly openAdvisories?: number;
}

export type DeprecationVerdict = 'active' | 'suspected' | 'deprecated' | 'unverified';

export interface ReplacementCandidate {
  readonly engine: EngineId;
  readonly version: string;
  /** Why this one, in the vocabulary of §57. */
  readonly reasons: readonly string[];
}

export interface DeprecationAssessment {
  readonly engine: EngineId;
  readonly verdict: DeprecationVerdict;
  /** The observations behind the verdict, in words; empty only for `unverified`. */
  readonly evidence: readonly string[];
  readonly replacement?: ReplacementCandidate;
  /** Ready-to-show warning; empty string when the verdict is `active` or `unverified`. */
  readonly warning: string;
}

/** Older than this without a release is stale; two of these years is abandoned. */
const STALE_DAYS = 540;
const ABANDONED_DAYS = 1_095;

const daysSince = (iso: string, now: Date): number | undefined => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return Math.floor((now.getTime() - then) / 86_400_000);
};

/**
 * Is `candidate` a better home for this capability than `current`? Only the four §57 reasons count;
 * an engine that is merely different is not a replacement.
 */
const replacementReasons = (
  current: EngineDocument,
  candidate: EngineDocument,
  currentSignals: DeprecationSignals,
): readonly string[] => {
  const reasons: string[] = [];
  const currentEngine = current;
  if (candidate.status === 'stable' && currentEngine.status !== 'stable') {
    reasons.push('Active maintenance');
  }
  // "Newer runtime" is not "a different runtime": it only counts when the candidate's runtime is one
  // this build can actually dispatch and the current one's is not.
  if (
    candidate.execution.adapter === 'implemented' &&
    currentEngine.execution.adapter !== 'implemented'
  ) {
    reasons.push('Newer runtime');
  }
  if (
    candidate.provider.credentials !== 'required' &&
    currentEngine.provider.credentials === 'required'
  ) {
    reasons.push('Better API');
  }
  if (candidate.execution.hostCompatible && !currentEngine.execution.hostCompatible) {
    reasons.push('Higher compatibility');
  }
  if (currentSignals.archived === true && candidate.status === 'stable' && reasons.length === 0) {
    reasons.push('Active maintenance');
  }
  return reasons;
};

const pickReplacement = (
  registry: TransformRegistry,
  current: EngineDocument,
  signals: DeprecationSignals,
): ReplacementCandidate | undefined => {
  const covers = (document: EngineDocument): boolean =>
    document.capabilities.some((capability) => current.capabilities.includes(capability));

  const candidates = registry.engines
    .filter((engine) => engine.id !== current.name && engine.status !== 'deprecated')
    .map((engine) => engineDocument(registry, engine))
    .filter(
      (document) =>
        covers(document) &&
        document.execution.hostCompatible &&
        document.execution.adapter === 'implemented' &&
        !document.execution.terminal,
    )
    .map((document) => ({ document, reasons: replacementReasons(current, document, signals) }))
    .sort(
      (a, b) =>
        b.reasons.length - a.reasons.length || a.document.name.localeCompare(b.document.name),
    );

  const best = candidates[0];
  if (!best) return undefined;
  // A candidate with no stated advantage is not offered: "use this other thing, no idea why" is
  // worse than saying nothing (U5).
  if (best.reasons.length === 0) return undefined;
  return { engine: best.document.name, version: best.document.version, reasons: best.reasons };
};

const formatWarning = (
  engine: EngineId,
  evidence: readonly string[],
  replacement: ReplacementCandidate | undefined,
): string => {
  const lines = [`Warning`, ``, `Engine ${engine} appears to be deprecated.`, ``];
  lines.push(`Evidence:`, ...evidence.map((line) => `- ${line}`), ``);
  if (replacement) {
    lines.push(
      `Replacement candidate:`,
      replacement.engine,
      ``,
      `Reason:`,
      ...replacement.reasons,
      ``,
    );
  } else {
    lines.push(`Replacement candidate:`, 'none in this registry', ``);
  }
  return lines.join('\n').trimEnd();
};

/**
 * One engine, one verdict. `deprecated` needs a hard fact (the manifest, an archived upstream, an
 * upstream notice, or no release for three years); `suspected` collects the softer signals.
 */
export const assessDeprecation = (
  registry: TransformRegistry,
  engine: EngineManifest,
  signals: DeprecationSignals = {},
  now: Date = new Date(),
): DeprecationAssessment => {
  const document = engineDocument(registry, engine);
  const hard: string[] = [];
  const soft: string[] = [];

  if (engine.status === 'deprecated') hard.push('the manifest declares status "deprecated"');
  if (signals.archived === true) hard.push('the upstream repository is archived');
  if (signals.upstreamNotice) hard.push(`upstream says: ${signals.upstreamNotice}`);

  const age =
    signals.lastReleaseAt === undefined ? undefined : daysSince(signals.lastReleaseAt, now);
  if (age !== undefined && age >= ABANDONED_DAYS) {
    hard.push(`no release for ${age} days (last ${signals.lastReleaseAt})`);
  } else if (age !== undefined && age >= STALE_DAYS) {
    soft.push(`no release for ${age} days (last ${signals.lastReleaseAt})`);
  }
  if (signals.openAdvisories !== undefined && signals.openAdvisories > 0) {
    soft.push(`${signals.openAdvisories} unfixed advisory(ies) against the installed version`);
  }
  if (signals.failureRate !== undefined && signals.failureRate >= 0.5) {
    soft.push(`${Math.round(signals.failureRate * 100)}% of observed runs failed`);
  }
  if (signals.latestVersion !== undefined && signals.latestVersion !== engine.version) {
    soft.push(`installed ${engine.version}, upstream ${signals.latestVersion}`);
  }
  if (document.provider.licence === 'unknown') {
    soft.push('no licence is stated for its provider');
  }

  const verdict: DeprecationVerdict =
    hard.length > 0
      ? 'deprecated'
      : soft.length > 1
        ? 'suspected'
        : Object.keys(signals).length === 0 && engine.status !== 'deprecated'
          ? 'unverified'
          : soft.length === 1
            ? 'suspected'
            : 'active';

  const evidence = [...hard, ...soft];
  if (verdict === 'unverified') {
    return {
      engine: engine.id,
      verdict,
      evidence: ['no upstream signals have been collected for this engine'],
      warning: '',
    };
  }
  if (verdict === 'active') {
    return { engine: engine.id, verdict, evidence, warning: '' };
  }

  const replacement = pickReplacement(registry, document, signals);
  return {
    engine: engine.id,
    verdict,
    evidence,
    ...(replacement ? { replacement } : {}),
    warning: formatWarning(engine.id, evidence, replacement),
  };
};

/**
 * Every engine the host has signals for, worst first. Engines without signals are included as
 * `unverified` so the gap is visible instead of looking like a clean bill of health.
 */
export const deprecationReport = (
  registry: TransformRegistry,
  signals: Readonly<Record<EngineId, DeprecationSignals>> = {},
  now: Date = new Date(),
): readonly DeprecationAssessment[] => {
  const rank: Record<DeprecationVerdict, number> = {
    deprecated: 0,
    suspected: 1,
    unverified: 2,
    active: 3,
  };
  return registry.engines
    .map((engine) => assessDeprecation(registry, engine, signals[engine.id] ?? {}, now))
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.engine.localeCompare(b.engine));
};
