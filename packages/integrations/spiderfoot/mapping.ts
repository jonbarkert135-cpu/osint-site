/**
 * SpiderFoot event type → Raven record type (12_SPIDERFOOT.md §6.2).
 *
 * The table is data, not code branches: SpiderFoot's event types are strings we do not control, so
 * an exact match is tried first, then the prefix rules of §6.2, then the `observation` fallback.
 * An unknown type is never dropped — it is imported as an observation with its type and data kept
 * verbatim, because a silently discarded finding is worse than an unlabelled one.
 */

import type { EntityKind } from '../src/manifest.ts';

/** The record types the manifest's `entityMappings` switch on. */
export const SF_RECORD_TYPES = [
  'domain',
  'url',
  'email',
  'username',
  'ip',
  'repo',
  'observation',
] as const;

export type SpiderFootRecordType = (typeof SF_RECORD_TYPES)[number];

export interface SpiderFootMapping {
  readonly recordType: SpiderFootRecordType;
  readonly kind: EntityKind;
  /** §6.2's base confidence; the pipeline lowers it further per record. */
  readonly baseConfidence: number;
}

const M = (
  recordType: SpiderFootRecordType,
  kind: EntityKind,
  baseConfidence: number,
): SpiderFootMapping => ({ recordType, kind, baseConfidence });

/** Exact event types (§6.2), limited to the six entity families Raven imports today. */
const EXACT: Readonly<Record<string, SpiderFootMapping>> = {
  DOMAIN_NAME: M('domain', 'domain', 0.9),
  DOMAIN_NAME_PARENT: M('domain', 'domain', 0.9),
  SIMILARDOMAIN: M('domain', 'domain', 0.45),
  CO_HOSTED_SITE_DOMAIN: M('domain', 'domain', 0.45),
  INTERNET_NAME: M('domain', 'domain', 0.85),
  INTERNET_NAME_UNRESOLVED: M('domain', 'domain', 0.6),
  IP_ADDRESS: M('ip', 'ip', 0.9),
  IPV6_ADDRESS: M('ip', 'ip', 0.9),
  EMAILADDR: M('email', 'email', 0.75),
  EMAILADDR_GENERIC: M('email', 'email', 0.4),
  USERNAME: M('username', 'username', 0.6),
  ACCOUNT_EXTERNAL_OWNED: M('url', 'url', 0.55),
  SOCIAL_MEDIA: M('url', 'url', 0.55),
  LINKED_URL_INTERNAL: M('url', 'url', 0.8),
  LINKED_URL_EXTERNAL: M('url', 'url', 0.5),
  PUBLIC_CODE_REPO: M('repo', 'repo', 0.8),
};

/** §6.2's prefix rules, applied in order before the fallback. */
const PREFIXES: readonly (readonly [string, SpiderFootMapping])[] = [
  ['RAW_', M('observation', 'note', 0.3)],
  ['URL_', M('url', 'url', 0.5)],
  ['LINKED_URL_', M('url', 'url', 0.5)],
  ['SOCIAL_', M('url', 'url', 0.55)],
  ['ACCOUNT_', M('url', 'url', 0.55)],
  ['EMAILADDR', M('email', 'email', 0.4)],
  ['DOMAIN_NAME', M('domain', 'domain', 0.6)],
  ['INTERNET_NAME', M('domain', 'domain', 0.6)],
];

/** Anything unmapped becomes an observation, keeping its raw type and data (§6.1). */
export const SF_FALLBACK: SpiderFootMapping = M('observation', 'note', 0.3);

export function classifyEvent(eventType: string): SpiderFootMapping {
  const type = eventType.trim().toUpperCase();
  const exact = EXACT[type];
  if (exact !== undefined) return exact;
  for (const [prefix, mapping] of PREFIXES) {
    if (type.startsWith(prefix)) return mapping;
  }
  return SF_FALLBACK;
}

/**
 * `RAW_*` payloads are page bodies and search-engine dumps: they stay in the run artifacts and are
 * never proposed as nodes (§6.2), so the parser skips them instead of importing megabytes of text.
 */
export function isArtifactOnly(eventType: string): boolean {
  const type = eventType.trim().toUpperCase();
  return type.startsWith('RAW_') || type.endsWith('_CONTENT');
}
