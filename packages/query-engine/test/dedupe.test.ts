import { describe, expect, it } from 'vitest';

import { looseKey, possibleDuplicates } from '../src/dedupe.ts';

describe('looseKey', () => {
  it('collapses scheme, www and trailing slash across web kinds', () => {
    const keys = [
      looseKey('domain', 'example.com'),
      looseKey('url', 'https://example.com/'),
      looseKey('hostname', 'www.example.com'),
      looseKey('url', 'http://WWW.example.com'),
    ];
    expect(new Set(keys)).toEqual(new Set(['web:example.com']));
  });

  it('keeps a real path apart from the bare host', () => {
    expect(looseKey('url', 'https://example.com/login')).not.toBe(
      looseKey('domain', 'example.com'),
    );
  });

  it('lower-cases handles and e-mails but leaves other kinds alone', () => {
    expect(looseKey('username', 'Alice')).toBe(looseKey('username', 'alice'));
    expect(looseKey('ip', '1.1.1.1')).toBeUndefined();
    expect(looseKey('domain', '   ')).toBeUndefined();
  });
});

describe('possibleDuplicates', () => {
  it('flags one hint per extra member of a bucket, never merging', () => {
    const hints = possibleDuplicates([
      { id: 'domain:example.com', kind: 'domain', value: 'example.com' },
      { id: 'url:https://www.example.com/', kind: 'url', value: 'https://www.example.com/' },
      { id: 'hostname:www.example.com', kind: 'hostname', value: 'www.example.com' },
      { id: 'domain:other.com', kind: 'domain', value: 'other.com' },
    ]);
    expect(hints).toHaveLength(2);
    expect(hints.every((hint) => hint.verdict === 'likely_duplicate')).toBe(true);
    expect(new Set(hints.map((hint) => hint.a))).toEqual(new Set(['domain:example.com']));
    expect(hints[0]?.reason).toContain('same place');
  });

  it('says so plainly when two entities of one kind differ only in notation', () => {
    const [hint] = possibleDuplicates([
      { id: 'a', kind: 'username', value: 'Alice' },
      { id: 'b', kind: 'username', value: 'alice' },
    ]);
    expect(hint?.reason).toBe('same username in a different notation');
  });

  it('reports nothing for entities that are genuinely different', () => {
    expect(
      possibleDuplicates([
        { id: 'a', kind: 'domain', value: 'example.com' },
        { id: 'b', kind: 'domain', value: 'example.org' },
      ]),
    ).toEqual([]);
  });
});
