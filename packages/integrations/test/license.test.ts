/** Licence classification (§60): what a declared SPDX id actually permits. */

import { describe, expect, it } from 'vitest';

import { canonicalLicenseId, classifyLicense, isLicenseAutoApprovable } from '../src/license.ts';

describe('canonicalLicenseId', () => {
  it('accepts the canonical spelling regardless of case', () => {
    expect(canonicalLicenseId('apache-2.0')).toBe('Apache-2.0');
    expect(canonicalLicenseId('  MIT ')).toBe('MIT');
  });

  it('resolves common aliases', () => {
    expect(canonicalLicenseId('GPLv3')).toBe('GPL-3.0-only');
    expect(canonicalLicenseId('BSD')).toBe('BSD-3-Clause');
    expect(canonicalLicenseId('proprietary')).toBe('UNLICENSED');
  });

  it('refuses to guess at compound expressions or empty strings', () => {
    expect(canonicalLicenseId('MIT OR Apache-2.0')).toBeUndefined();
    expect(canonicalLicenseId('GPL-3.0 AND MIT')).toBeUndefined();
    expect(canonicalLicenseId('   ')).toBeUndefined();
  });
});

describe('classifyLicense', () => {
  it('classifies permissive licences as commercially usable with attribution', () => {
    const facts = classifyLicense('MIT');
    expect(facts.category).toBe('permissive');
    expect(facts.commercialUse).toBe('yes');
    expect(facts.attributionRequired).toBe(true);
    expect(facts.redistributionRestricted).toBe(false);
  });

  it('marks public-domain dedications as needing no attribution', () => {
    expect(classifyLicense('CC0-1.0').attributionRequired).toBe(false);
    expect(classifyLicense('The Unlicense').spdx).toBe('Unlicense');
  });

  it('treats copyleft as conditional, not free', () => {
    expect(classifyLicense('GPL-3.0').commercialUse).toBe('conditional');
    expect(classifyLicense('AGPL-3.0').category).toBe('network-copyleft');
    expect(classifyLicense('AGPL-3.0').redistributionRestricted).toBe(true);
  });

  it('rejects source-available and non-commercial licences', () => {
    expect(classifyLicense('BUSL-1.1').commercialUse).toBe('no');
    expect(classifyLicense('SSPL-1.0').commercialUse).toBe('no');
    expect(classifyLicense('CC-BY-NC-4.0').category).toBe('non-commercial');
  });

  it('never treats an unrecognised or missing licence as permissive', () => {
    const unknown = classifyLicense('Some Custom Terms v2');
    expect(unknown.category).toBe('unknown');
    expect(unknown.commercialUse).toBe('unknown');
    expect(unknown.redistributionRestricted).toBe(true);

    const none = classifyLicense('');
    expect(none.spdx).toBe('(none declared)');
    expect(none.category).toBe('unknown');
  });

  it('treats an unlicensed public repository as no permission at all', () => {
    const facts = classifyLicense('UNLICENSED');
    expect(facts.category).toBe('proprietary');
    expect(facts.commercialUse).toBe('no');
    expect(facts.note).toContain('not permission');
  });
});

describe('isLicenseAutoApprovable', () => {
  it('is true only for licences with unconditional commercial use', () => {
    expect(isLicenseAutoApprovable('Apache-2.0')).toBe(true);
    expect(isLicenseAutoApprovable('MPL-2.0')).toBe(true);
    expect(isLicenseAutoApprovable('GPL-3.0')).toBe(false);
    expect(isLicenseAutoApprovable('mystery-license')).toBe(false);
  });
});
