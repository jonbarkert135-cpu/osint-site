/**
 * Query intake: one raw string typed by the analyst → ranked entity candidates
 * (24_UNIFIED_QUERY.md §3).
 *
 * Pure, offline and deterministic: no network, no model, no clock. Ambiguity is normal, so the
 * intake returns a ranked list instead of guessing silently — `raven.io` is a domain and possibly
 * a company, `alice` is a username and possibly a person.
 */

import type { EntityKind } from '@nexus/transforms';

export interface EntityCandidate {
  readonly kind: EntityKind;
  /** The normalized value the router should be given, not the raw string. */
  readonly value: string;
  /** 0..1, higher is more likely. Ties are broken by the order of the selector table. */
  readonly confidence: number;
  /** Why this candidate was offered, shown in the plan UI. */
  readonly why: string;
}

interface Selector {
  readonly kind: EntityKind;
  /** Base58 and name selectors carry meaning in their case, so they see the raw string. */
  readonly caseSensitive?: boolean;
  readonly confidence: number;
  readonly why: string;
  readonly match: (raw: string) => string | undefined;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/u;
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/u;
const EMAIL = /^[^\s@]{1,64}@(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/u;
const PHONE = /^\+[1-9]\d{7,14}$/u;
const HANDLE = /^@?[a-z0-9](?:[a-z0-9._-]{1,38})$/u;
const BTC = /^(?:[13][A-HJ-NP-Za-km-z1-9]{25,34}|bc1[a-z0-9]{11,71})$/u;
const ETH = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^[0-9a-f]{32}(?:[0-9a-f]{8})?(?:[0-9a-f]{24})?$/u;
const REPO = /^[a-z0-9._-]{1,39}\/[a-z0-9._-]{1,100}$/u;

/** A URL is the only selector allowed to use the platform parser: everything else is a regex. */
const asUrl = (raw: string): string | undefined => {
  if (!/^https?:\/\//iu.test(raw)) return undefined;
  try {
    return new URL(raw).toString();
  } catch {
    return undefined;
  }
};

const digitsOnly = (raw: string): string => raw.replace(/[\s()-]/gu, '');

const SELECTORS: readonly Selector[] = [
  { kind: 'url', confidence: 0.98, why: 'looks like a URL', match: asUrl },
  {
    kind: 'email',
    confidence: 0.97,
    why: 'has a local part and a domain',
    match: (raw) => (EMAIL.test(raw) ? raw : undefined),
  },
  {
    kind: 'ip',
    confidence: 0.96,
    why: 'valid IP address',
    match: (raw) => (IPV4.test(raw) || IPV6.test(raw) ? raw : undefined),
  },
  {
    kind: 'phone',
    confidence: 0.9,
    why: 'E.164 phone number',
    match: (raw) => {
      const digits = digitsOnly(raw);
      return PHONE.test(digits) ? digits : undefined;
    },
  },
  {
    kind: 'crypto_address',
    caseSensitive: true,
    confidence: 0.9,
    why: 'wallet address shape',
    match: (raw) => (BTC.test(raw) || ETH.test(raw) ? raw : undefined),
  },
  {
    kind: 'repo',
    confidence: 0.85,
    why: 'owner/name pair',
    match: (raw) => (REPO.test(raw) && !DOMAIN.test(raw) ? raw : undefined),
  },
  {
    kind: 'domain',
    confidence: 0.8,
    why: 'registrable domain name',
    match: (raw) => (DOMAIN.test(raw) ? raw : undefined),
  },
  {
    kind: 'hash',
    confidence: 0.75,
    why: 'hex digest length',
    match: (raw) => (HASH.test(raw) ? raw : undefined),
  },
  {
    kind: 'username',
    confidence: 0.7,
    why: 'handle shape',
    // A handle may contain dots, but `example.com` is a domain the analyst typed, not a handle.
    match: (raw) => (HANDLE.test(raw) && !DOMAIN.test(raw) ? raw.replace(/^@/u, '') : undefined),
  },
  {
    kind: 'company',
    confidence: 0.35,
    why: 'could also be an organisation name',
    match: (raw) =>
      DOMAIN.test(raw) || /^[\p{L}][\p{L}\s.&-]{1,60}$/u.test(raw) ? raw : undefined,
  },
  {
    kind: 'person',
    caseSensitive: true,
    confidence: 0.3,
    why: 'could also be a person name',
    match: (raw) => (/^\p{Lu}[\p{L}'-]+(?:\s\p{Lu}[\p{L}'-]+)+$/u.test(raw) ? raw : undefined),
  },
];

/** Free text is never a silent guess: it falls through to its own kind. */
export const FREE_TEXT_KIND: EntityKind = 'fact';

/** Two candidates this close are treated as genuinely ambiguous by the UI. */
export const AMBIGUITY_DELTA = 0.15;

/**
 * Type one raw string. Returns candidates best first; an unrecognized string yields a single
 * free-text candidate so the caller never has to handle an empty list.
 */
export const typeQuery = (raw: string): readonly EntityCandidate[] => {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  const lower = trimmed.toLowerCase();
  const found: EntityCandidate[] = [];
  for (const selector of SELECTORS) {
    const value = selector.match(selector.caseSensitive === true ? trimmed : lower);
    if (value === undefined) continue;
    found.push({
      kind: selector.kind,
      value,
      confidence: selector.confidence,
      why: selector.why,
    });
  }

  if (found.length === 0) {
    return [
      {
        kind: FREE_TEXT_KIND,
        value: trimmed,
        confidence: 0.2,
        why: 'free text: no selector matched',
      },
    ];
  }
  return found;
};

/** True when the top two candidates are close enough that the analyst should be asked once. */
export const isAmbiguous = (candidates: readonly EntityCandidate[]): boolean => {
  const [first, second] = candidates;
  if (first === undefined || second === undefined) return false;
  return first.confidence - second.confidence < AMBIGUITY_DELTA;
};
