/**
 * License classification for integrations (§60 LEGAL / LICENSE CHECK).
 *
 * The rule this file exists to enforce: "on GitHub" is not a license. An adapter declares an SPDX
 * id in its manifest; this table says what that id actually permits for *our* two uses —
 * running the tool as a sandboxed container/HTTP call, and shipping the adapter code inside the
 * product. Anything not in the table is `unknown`, and unknown is never treated as permissive.
 *
 * This is a deliberately small, reviewable table, not a license engine. It answers four questions
 * the spec asks (commercial use, attribution, redistribution restrictions, dependency licenses)
 * and marks everything else as needing a human.
 */

export type LicenseCategory =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'source-available'
  | 'non-commercial'
  | 'proprietary'
  | 'unknown';

/** Can we use it in a commercial product? `conditional` means "yes, if the conditions are met". */
export type CommercialUse = 'yes' | 'conditional' | 'no' | 'unknown';

export interface LicenseFacts {
  /** The id as declared, normalised to the canonical SPDX spelling when we recognise it. */
  readonly spdx: string;
  readonly category: LicenseCategory;
  readonly commercialUse: CommercialUse;
  /** Must the notice/copyright be reproduced in the product? */
  readonly attributionRequired: boolean;
  /**
   * True when *bundling the tool's code* into our distribution carries obligations beyond
   * attribution (source offer, same-license, etc.). Running an unmodified upstream container over
   * the network is a different act from redistributing code, and the note says which is which.
   */
  readonly redistributionRestricted: boolean;
  /** One sentence a reviewer can act on; never marketing, never legal advice. */
  readonly note: string;
}

const TABLE: Readonly<Record<string, Omit<LicenseFacts, 'spdx'>>> = {
  MIT: {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: true,
    redistributionRestricted: false,
    note: 'Permissive; keep the copyright notice in the distributed build.',
  },
  'Apache-2.0': {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: true,
    redistributionRestricted: false,
    note: 'Permissive with a patent grant; keep NOTICE and state significant changes.',
  },
  'BSD-2-Clause': {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: true,
    redistributionRestricted: false,
    note: 'Permissive; reproduce the copyright notice.',
  },
  'BSD-3-Clause': {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: true,
    redistributionRestricted: false,
    note: 'Permissive; reproduce the notice and do not imply endorsement.',
  },
  ISC: {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: true,
    redistributionRestricted: false,
    note: 'Permissive; reproduce the copyright notice.',
  },
  Unlicense: {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: false,
    redistributionRestricted: false,
    note: 'Public-domain dedication; no obligations.',
  },
  'CC0-1.0': {
    category: 'permissive',
    commercialUse: 'yes',
    attributionRequired: false,
    redistributionRestricted: false,
    note: 'Public-domain dedication; no obligations.',
  },
  'MPL-2.0': {
    category: 'weak-copyleft',
    commercialUse: 'yes',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'File-level copyleft: modified MPL files stay MPL, the rest of the product does not.',
  },
  'LGPL-3.0-only': {
    category: 'weak-copyleft',
    commercialUse: 'conditional',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Dynamic linking only, and relinking must stay possible if we ship the binary.',
  },
  'GPL-2.0-only': {
    category: 'strong-copyleft',
    commercialUse: 'conditional',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Fine to run as a separate process/container; do not link or bundle its code.',
  },
  'GPL-3.0-only': {
    category: 'strong-copyleft',
    commercialUse: 'conditional',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Fine to run as a separate process/container; do not link or bundle its code.',
  },
  'AGPL-3.0-only': {
    category: 'network-copyleft',
    commercialUse: 'conditional',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Network use can trigger a source offer — needs an explicit legal decision before enabling.',
  },
  'SSPL-1.0': {
    category: 'source-available',
    commercialUse: 'no',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Offering it as a service requires releasing the service stack; not usable here.',
  },
  'BUSL-1.1': {
    category: 'source-available',
    commercialUse: 'no',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Production use is restricted until the change date; not usable without a licence.',
  },
  'Elastic-2.0': {
    category: 'source-available',
    commercialUse: 'no',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Forbids providing the product as a managed service; not usable here.',
  },
  'CC-BY-NC-4.0': {
    category: 'non-commercial',
    commercialUse: 'no',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Non-commercial only; cannot be shipped in a commercial product.',
  },
  'CC-BY-SA-4.0': {
    category: 'strong-copyleft',
    commercialUse: 'conditional',
    attributionRequired: true,
    redistributionRestricted: true,
    note: 'Share-alike applies to derived data/content, not just code.',
  },
  UNLICENSED: {
    category: 'proprietary',
    commercialUse: 'no',
    attributionRequired: false,
    redistributionRestricted: true,
    note: 'No licence granted. Being public on GitHub is not permission to use it.',
  },
};

/** Common spellings that mean the same licence; anything else stays unknown on purpose. */
const ALIASES: Readonly<Record<string, string>> = {
  'APACHE 2.0': 'Apache-2.0',
  'APACHE-2': 'Apache-2.0',
  APACHE2: 'Apache-2.0',
  BSD: 'BSD-3-Clause',
  'BSD-3': 'BSD-3-Clause',
  'BSD-2': 'BSD-2-Clause',
  'GPL-2.0': 'GPL-2.0-only',
  GPLV2: 'GPL-2.0-only',
  'GPL-3.0': 'GPL-3.0-only',
  GPLV3: 'GPL-3.0-only',
  'AGPL-3.0': 'AGPL-3.0-only',
  AGPLV3: 'AGPL-3.0-only',
  'LGPL-3.0': 'LGPL-3.0-only',
  'MPL2.0': 'MPL-2.0',
  'THE UNLICENSE': 'Unlicense',
  'PUBLIC DOMAIN': 'CC0-1.0',
  NONE: 'UNLICENSED',
  PROPRIETARY: 'UNLICENSED',
};

const CANONICAL_BY_UPPER = new Map(Object.keys(TABLE).map((id) => [id.toUpperCase(), id]));

/**
 * Resolves a declared licence string to a canonical SPDX id we know, or `undefined`.
 * `OR`/`AND` expressions are not parsed: a compound expression is a human decision, not a lookup.
 */
export function canonicalLicenseId(declared: string): string | undefined {
  const trimmed = declared.trim();
  if (trimmed === '') return undefined;
  const upper = trimmed.toUpperCase();
  if (upper.includes(' OR ') || upper.includes(' AND ')) return undefined;
  return CANONICAL_BY_UPPER.get(upper) ?? ALIASES[upper];
}

export function classifyLicense(declared: string): LicenseFacts {
  const canonical = canonicalLicenseId(declared);
  const facts = canonical === undefined ? undefined : TABLE[canonical];
  if (canonical === undefined || facts === undefined) {
    return {
      spdx: declared.trim() === '' ? '(none declared)' : declared.trim(),
      category: 'unknown',
      commercialUse: 'unknown',
      attributionRequired: true,
      redistributionRestricted: true,
      note: 'Not a licence we have reviewed. Being public on GitHub grants nothing — review it before enabling.',
    };
  }
  return { spdx: canonical, ...facts };
}

/** The licences an integration may declare and still be enabled without a human decision (§61). */
export function isLicenseAutoApprovable(declared: string): boolean {
  const facts = classifyLicense(declared);
  return facts.commercialUse === 'yes';
}
