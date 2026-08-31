/** Result cache with TTL and age labelling (21_TRANSFORM_SYSTEM.md §10). Pure, no I/O. */

import type { RunEntity, RunInput } from './history.ts';
import type { EngineManifest, ProviderManifest, TransformManifest } from './types.ts';

export interface CacheSubject {
  readonly transform: TransformManifest;
  readonly engine: EngineManifest;
  readonly provider: ProviderManifest;
  readonly input: RunInput;
  /** The question the analyst asked, if this step came from one. Recorded, never part of the key. */
  readonly query?: string;
}

/** Case and whitespace are not part of a selector's identity; nothing else is normalized here. */
const normalizeInput = (input: RunInput): string =>
  `${input.kind}:${input.value.trim().toLowerCase()}`;

/** `transform+version + engine+version + provider + normalized input` (§10). */
export const cacheKey = ({ transform, engine, provider, input }: CacheSubject): string =>
  [
    transform.id,
    transform.version,
    engine.id,
    engine.version,
    provider.id,
    normalizeInput(input),
  ].join('|');

/**
 * Cacheable only when the manifest says so *and* the provider's terms allow storing results
 * (`storeResults: false` opts a provider out); credentials never enter the key.
 */
export const isCacheable = (transform: TransformManifest, provider: ProviderManifest): boolean =>
  transform.cacheable && transform.cacheTtlSeconds !== undefined && provider.storeResults !== false;

/**
 * What an entry records (Part 2 §51): query, input, engine, engine version, timestamp, result and
 * expiry. The key alone would be enough to *find* an entry; these fields are what makes a cached
 * answer auditable — and what lets a version change invalidate the entries it invalidates.
 */
export interface CacheEntry {
  readonly key: string;
  readonly query?: string;
  readonly input: RunInput;
  readonly transform: string;
  readonly transformVersion: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly provider: string;
  readonly results: readonly RunEntity[];
  readonly runId: string;
  readonly storedAt: number;
  readonly expiresAt: number;
}

export interface CacheHit {
  readonly entry: CacheEntry;
  readonly ageMs: number;
  /** What the UI must show next to a cached answer: "cached 2 hours ago". */
  readonly ageLabel: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (value: number, unit: string): string =>
  `${value} ${unit}${value === 1 ? '' : 's'} ago`;

/** Coarse on purpose: an analyst needs the order of magnitude, not the seconds. */
export const ageLabel = (ageMs: number): string => {
  if (ageMs < MINUTE) return 'just now';
  if (ageMs < HOUR) return plural(Math.floor(ageMs / MINUTE), 'minute');
  if (ageMs < DAY) return plural(Math.floor(ageMs / HOUR), 'hour');
  return plural(Math.floor(ageMs / DAY), 'day');
};

export interface ResultCache {
  /** Undefined on a miss and on an expired entry, which is dropped in passing. */
  get(subject: CacheSubject, now: number): CacheHit | undefined;
  /** No-op when the transform or the provider forbids storing results. */
  set(subject: CacheSubject, results: readonly RunEntity[], runId: string, now: number): void;
  delete(subject: CacheSubject): void;
  /**
   * Drops every entry produced by `engine` on a version other than `version` (§51). The key already
   * carries the version, so a new version simply misses; this is the housekeeping that stops the
   * superseded entries from sitting there until their TTL runs out. Returns how many were dropped.
   */
  invalidateEngineVersion(engine: string, version: string): number;
  /** Everything currently stored, newest first — the audit view behind the cache. */
  entries(): readonly CacheEntry[];
  readonly size: number;
}

/** In-memory cache; durable storage is the repository's job (ADR-001), not this package's. */
export const createResultCache = (): ResultCache => {
  const entries = new Map<string, CacheEntry>();

  return {
    get: (subject, now) => {
      const key = cacheKey(subject);
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      const ageMs = now - entry.storedAt;
      return { entry, ageMs, ageLabel: ageLabel(ageMs) };
    },
    set: (subject, results, runId, now) => {
      if (!isCacheable(subject.transform, subject.provider)) return;
      const key = cacheKey(subject);
      entries.set(key, {
        key,
        ...(subject.query === undefined ? {} : { query: subject.query }),
        input: subject.input,
        transform: subject.transform.id,
        transformVersion: subject.transform.version,
        engine: subject.engine.id,
        engineVersion: subject.engine.version,
        provider: subject.provider.id,
        results,
        runId,
        storedAt: now,
        expiresAt: now + (subject.transform.cacheTtlSeconds ?? 0) * 1_000,
      });
    },
    delete: (subject) => void entries.delete(cacheKey(subject)),
    invalidateEngineVersion: (engine, version) => {
      const stale = [...entries.values()].filter(
        (entry) => entry.engine === engine && entry.engineVersion !== version,
      );
      for (const entry of stale) entries.delete(entry.key);
      return stale.length;
    },
    entries: () => [...entries.values()].sort((a, b) => b.storedAt - a.storedAt),
    get size() {
      return entries.size;
    },
  };
};
