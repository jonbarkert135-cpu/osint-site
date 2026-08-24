/**
 * Canonicalization and identity keys (24_UNIFIED_QUERY.md §7.1, §7.2).
 *
 * Pure and deterministic. Canonicalization lives here rather than in an engine because two engines
 * must never disagree about whether `EXAMPLE.com.` and `example.com` are the same node — that
 * disagreement is what turns one investigation into two half-investigations.
 */

import type { EntityKind } from '@nexus/transforms';

const stripTrailingDot = (value: string): string =>
  value.endsWith('.') && value.length > 1 ? value.slice(0, -1) : value;

/** Tracking parameters are noise, but removing them is a transformation the caller may want to see. */
const TRACKING_PARAMS = /^(?:utm_[a-z]+|fbclid|gclid|mc_[ce]id|igshid|ref_src)$/iu;

const canonicalUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
};

/** IPv6 in compressed lower-case form; IPv4 untouched. Invalid input is returned trimmed. */
const canonicalIp = (raw: string): string => {
  const value = raw.trim().toLowerCase();
  if (!value.includes(':')) return value;
  const [head = '', tail = ''] = value.split('::', 2);
  const groups = value.includes('::')
    ? [
        ...head.split(':').filter((part) => part !== ''),
        ...Array<string>(
          Math.max(
            0,
            8 - head.split(':').filter(Boolean).length - tail.split(':').filter(Boolean).length,
          ),
        ).fill('0'),
        ...tail.split(':').filter((part) => part !== ''),
      ]
    : value.split(':');
  if (groups.length !== 8) return value;
  return groups.map((group) => group.replace(/^0+(?=.)/u, '')).join(':');
};

/**
 * The `+tag` in an e-mail local part is evidence, not noise: it stays. Only the domain is
 * lower-cased, because the local part is case-sensitive per RFC 5321 even where nobody honours it.
 */
const canonicalEmail = (raw: string): string => {
  const value = raw.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0) return value.toLowerCase();
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
};

const LOWERCASED: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'domain',
  'hostname',
  'certificate',
  'hash',
  'repo',
  'asn',
  'dns_record',
  'crypto_address',
  'language',
]);

/** The canonical form of a selector value for its kind. Never throws. */
export const canonicalValue = (kind: EntityKind, raw: string): string => {
  const value = raw.trim();
  if (value === '') return value;
  switch (kind) {
    case 'url':
      return canonicalUrl(value);
    case 'email':
      return canonicalEmail(value);
    case 'ip':
      return canonicalIp(value);
    case 'phone':
      return value.replace(/[\s()-]/gu, '');
    case 'username':
    case 'profile':
      return stripTrailingDot(value.replace(/^@/u, ''));
    default:
      return LOWERCASED.has(kind) ? stripTrailingDot(value.toLowerCase()) : value;
  }
};

/**
 * Deterministic identity key. Entities with the same key are the same thing and merge silently
 * (§7.2); a person never gets one, because merging people on a name alone is how OSINT tools
 * manufacture false accusations.
 */
export const identityKey = (kind: EntityKind, value: string): string | undefined => {
  if (kind === 'person' || kind === 'note' || kind === 'fact') return undefined;
  const canonical = canonicalValue(kind, value);
  return canonical === '' ? undefined : `${kind}:${canonical}`;
};
