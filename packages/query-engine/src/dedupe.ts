/**
 * Possible-duplicate detection (Part 2 §16, §17).
 *
 * Exact duplicates already merge silently: two observations that share an `identityKey` become one
 * entity in `resolve.ts`. What is left is the harder half — `example.com`, `www.example.com` and
 * `https://example.com/` are three identity keys and, to a human, one thing.
 *
 * This module never merges. It reports pairs and lets the analyst decide (§17: at doubt, show
 * "possible duplicate" instead of hiding one of them). Suppressing a real second entity is a worse
 * failure than showing one extra row.
 */

import type { EntityKind } from '@nexus/transforms';

import { canonicalValue } from './normalize.ts';

/** Kinds that describe a place on the web and can therefore collide across kinds. */
const WEBBISH: ReadonlySet<EntityKind> = new Set<EntityKind>(['url', 'domain', 'hostname']);

const stripWww = (host: string): string => (host.startsWith('www.') ? host.slice(4) : host);

/**
 * A deliberately lossier key than `identityKey`: scheme, `www.`, a trailing slash and an empty
 * query are dropped, and the web-ish kinds share one namespace so `domain:example.com` can meet
 * `url:https://www.example.com/`. Two entities with the same loose key are *candidates*, not facts.
 */
export const looseKey = (kind: EntityKind, value: string): string | undefined => {
  const canonical = canonicalValue(kind, value);
  if (canonical === '') return undefined;
  if (WEBBISH.has(kind)) {
    try {
      const url = new URL(canonical.includes('://') ? canonical : `https://${canonical}`);
      const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
      return `web:${stripWww(url.hostname)}${path}${url.search}`;
    } catch {
      return `web:${stripWww(canonical.toLowerCase())}`;
    }
  }
  if (kind === 'email' || kind === 'username' || kind === 'profile') {
    return `${kind}:${canonical.toLowerCase()}`;
  }
  // Everything else is already as canonical as it gets; a loose key would only invent collisions.
  return undefined;
};

export interface DuplicateHint {
  /** Entity ids, lowest first, so the same pair always reports the same way. */
  readonly a: string;
  readonly b: string;
  /** `same` is reserved for exact identity — those never reach here — so hints are always likely. */
  readonly verdict: 'likely_duplicate';
  /** Shown verbatim next to the pair. */
  readonly reason: string;
}

interface Candidate {
  readonly id: string;
  readonly kind: EntityKind;
  readonly value: string;
}

/**
 * Pairs that are probably the same thing. O(n) over entities, pairs only inside a bucket, so a
 * bucket with k members yields k-1 hints against its representative rather than k² noise.
 */
export const possibleDuplicates = (entities: readonly Candidate[]): readonly DuplicateHint[] => {
  const buckets = new Map<string, Candidate[]>();
  for (const entity of entities) {
    const key = looseKey(entity.kind, entity.value);
    if (key === undefined) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entity);
    else buckets.set(key, [entity]);
  }

  const hints: DuplicateHint[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((x, y) => (x.id < y.id ? -1 : 1));
    const [head, ...rest] = sorted as [Candidate, ...Candidate[]];
    for (const other of rest) {
      hints.push({
        a: head.id,
        b: other.id,
        verdict: 'likely_duplicate',
        reason:
          head.kind === other.kind
            ? `same ${head.kind} in a different notation`
            : `${head.kind} and ${other.kind} point at the same place`,
      });
    }
  }
  return hints;
};
