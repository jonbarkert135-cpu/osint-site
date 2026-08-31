import { describe, expect, it } from 'vitest';

import { ageLabel, cacheKey, createResultCache, isCacheable } from '../src/cache.ts';
import type { RunEntity } from '../src/history.ts';

import { makeEngine, makeProvider, makeTransform } from './fixtures.ts';

const transform = makeTransform({
  id: 'domain-to-ip',
  capability: 'dns',
  cacheable: true,
  cacheTtlSeconds: 60,
});
const engine = makeEngine({ id: 'strong', capability: 'dns', provider: 'free' });
const provider = makeProvider({ id: 'free' });
const subject = {
  transform,
  engine,
  provider,
  input: { kind: 'domain', value: 'Example.COM ' } as const,
};
const results: readonly RunEntity[] = [
  { kind: 'ip', value: '1.1.1.1', confidence: 0.9, evidence: ['artifact://a'] },
];

describe('cacheKey', () => {
  it('includes transform, engine, provider versions and the normalized input', () => {
    expect(cacheKey(subject)).toBe('domain-to-ip|1.0.0|strong|1.0.0|free|domain:example.com');
  });

  it('changes when the transform version changes', () => {
    expect(cacheKey({ ...subject, transform: { ...transform, version: '2.0.0' } })).not.toBe(
      cacheKey(subject),
    );
  });

  it('separates the same value under a different entity kind', () => {
    expect(cacheKey({ ...subject, input: { kind: 'hostname', value: 'example.com' } })).not.toBe(
      cacheKey(subject),
    );
  });
});

describe('isCacheable', () => {
  it('requires the manifest to opt in with a TTL', () => {
    expect(isCacheable(transform, provider)).toBe(true);
    expect(isCacheable(makeTransform({ id: 't', capability: 'dns' }), provider)).toBe(false);
  });

  it('refuses when the provider forbids storing results', () => {
    expect(isCacheable(transform, makeProvider({ id: 'free', storeResults: false }))).toBe(false);
  });
});

describe('createResultCache', () => {
  it('misses on an empty cache', () => {
    expect(createResultCache().get(subject, 0)).toBeUndefined();
  });

  it('returns a hit with the age of the data', () => {
    const cache = createResultCache();
    cache.set(subject, results, 'r1', 1_000);
    const hit = cache.get(subject, 1_000 + 30_000);
    expect(hit?.entry.results).toEqual(results);
    expect(hit?.entry.runId).toBe('r1');
    expect(hit?.ageMs).toBe(30_000);
    expect(hit?.ageLabel).toBe('just now');
  });

  it('drops an entry once its TTL has passed', () => {
    const cache = createResultCache();
    cache.set(subject, results, 'r1', 0);
    expect(cache.get(subject, 60_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('does not store results the provider forbids storing', () => {
    const cache = createResultCache();
    const forbidden = { ...subject, provider: makeProvider({ id: 'free', storeResults: false }) };
    cache.set(forbidden, results, 'r1', 0);
    expect(cache.get(forbidden, 0)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('records what §51 asks for: query, input, engine version, timestamps', () => {
    const cache = createResultCache();
    cache.set({ ...subject, query: 'example.com' }, results, 'r1', 1_000);
    const [entry] = cache.entries();
    expect(entry).toMatchObject({
      query: 'example.com',
      input: { kind: 'domain', value: 'Example.COM ' },
      transform: 'domain-to-ip',
      engine: 'strong',
      engineVersion: '1.0.0',
      provider: 'free',
      storedAt: 1_000,
      expiresAt: 61_000,
    });
  });

  it('invalidates entries left behind by an older engine version', () => {
    const cache = createResultCache();
    cache.set(subject, results, 'r1', 0);
    expect(cache.invalidateEngineVersion('strong', '2.0.0')).toBe(1);
    expect(cache.size).toBe(0);
    // A different engine, and the current version, are left alone.
    cache.set(subject, results, 'r2', 0);
    expect(cache.invalidateEngineVersion('other', '9.9.9')).toBe(0);
    expect(cache.invalidateEngineVersion('strong', '1.0.0')).toBe(0);
    expect(cache.size).toBe(1);
  });

  it('deletes an entry on demand', () => {
    const cache = createResultCache();
    cache.set(subject, results, 'r1', 0);
    cache.delete(subject);
    expect(cache.size).toBe(0);
  });
});

describe('ageLabel', () => {
  it('labels each magnitude, singular and plural', () => {
    expect(ageLabel(0)).toBe('just now');
    expect(ageLabel(60_000)).toBe('1 minute ago');
    expect(ageLabel(5 * 60_000)).toBe('5 minutes ago');
    expect(ageLabel(3_600_000)).toBe('1 hour ago');
    expect(ageLabel(5 * 3_600_000)).toBe('5 hours ago');
    expect(ageLabel(86_400_000)).toBe('1 day ago');
    expect(ageLabel(3 * 86_400_000)).toBe('3 days ago');
  });
});
