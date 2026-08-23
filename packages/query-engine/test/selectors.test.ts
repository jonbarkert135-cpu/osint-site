import { describe, expect, it } from 'vitest';

import { isAmbiguous, typeQuery } from '../src/selectors.ts';

const kinds = (raw: string): readonly string[] => typeQuery(raw).map((candidate) => candidate.kind);

describe('typeQuery', () => {
  it('returns nothing for an empty input', () => {
    expect(typeQuery('   ')).toEqual([]);
  });

  it('types the common selectors', () => {
    expect(kinds('https://example.com/a')).toContain('url');
    expect(kinds('john.doe@example.com')).toContain('email');
    expect(kinds('8.8.8.8')).toContain('ip');
    expect(kinds('2001:db8::1')).toContain('ip');
    expect(kinds('+1 (555) 123-4567')).toContain('phone');
    expect(kinds('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toContain('crypto_address');
    expect(kinds('0x52908400098527886e0f7030069857d2e4169ee7')).toContain('crypto_address');
    expect(kinds('torvalds/linux')).toContain('repo');
    expect(kinds('example.com')).toContain('domain');
    expect(kinds('d41d8cd98f00b204e9800998ecf8427e')).toContain('hash');
    expect(kinds('@alice')).toContain('username');
    expect(kinds('Ada Lovelace')).toContain('person');
  });

  it('normalizes the value instead of routing on the raw string', () => {
    const [phone] = typeQuery('+1 (555) 123-4567');
    expect(phone?.value).toBe('+15551234567');
    const username = typeQuery('@Alice').find((candidate) => candidate.kind === 'username');
    expect(username?.value).toBe('alice');
  });

  it('does not read a domain as a handle', () => {
    expect(kinds('example.com')).not.toContain('username');
  });

  it('keeps ambiguity instead of guessing: a domain is also a possible company', () => {
    const candidates = typeQuery('raven.io');
    expect(candidates.map((candidate) => candidate.kind)).toEqual(
      expect.arrayContaining(['domain', 'company']),
    );
  });

  it('falls through to free text when no selector matches', () => {
    const candidates = typeQuery('who owns the pier?');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('fact');
  });

  it('flags a close race between the top two candidates', () => {
    expect(isAmbiguous([])).toBe(false);
    expect(
      isAmbiguous([
        { kind: 'domain', value: 'a', confidence: 0.8, why: '' },
        { kind: 'company', value: 'a', confidence: 0.35, why: '' },
      ]),
    ).toBe(false);
    expect(
      isAmbiguous([
        { kind: 'domain', value: 'a', confidence: 0.8, why: '' },
        { kind: 'hostname', value: 'a', confidence: 0.75, why: '' },
      ]),
    ).toBe(true);
  });
});
