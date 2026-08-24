import { describe, expect, it } from 'vitest';

import { canonicalValue, identityKey } from '../src/normalize.ts';
import { corroborate, createGraphBuilder, type Provenance } from '../src/resolve.ts';

const source = (provider: string, confidence: number): Provenance => ({
  runId: `run-${provider}`,
  transform: 't',
  engine: `${provider}-engine`,
  provider,
  input: { kind: 'domain', value: 'example.com' },
  observedAt: '2026-08-24T00:00:00Z',
  cached: false,
  confidence,
  evidence: [`${provider} said so`],
});

describe('canonicalValue', () => {
  it('makes host names, e-mail domains and URLs comparable', () => {
    expect(canonicalValue('domain', ' Example.COM. ')).toBe('example.com');
    expect(canonicalValue('email', 'Alice+tag@Example.com')).toBe('Alice+tag@example.com');
    expect(canonicalValue('url', 'https://Example.com:443/a?utm_source=x&b=1#top')).toBe(
      'https://example.com/a?b=1',
    );
    expect(canonicalValue('ip', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
      '2001:db8:0:0:0:0:0:1',
    );
    expect(canonicalValue('username', '@Alice')).toBe('Alice');
  });
});

describe('identityKey', () => {
  it('never gives a person one: a shared name is not a shared identity', () => {
    expect(identityKey('person', 'John Smith')).toBeUndefined();
    expect(identityKey('domain', 'EXAMPLE.com')).toBe('domain:example.com');
  });
});

describe('corroborate', () => {
  it('raises confidence when independent providers agree, and caps it below certainty', () => {
    expect(corroborate([source('a', 0.8)])).toBeCloseTo(0.8, 4);
    expect(corroborate([source('a', 0.8), source('b', 0.8)])).toBeCloseTo(0.96, 4);
    expect(corroborate(Array.from({ length: 20 }, (_, i) => source(`p${String(i)}`, 0.9)))).toBe(
      0.99,
    );
  });

  it('does not let one provider corroborate itself', () => {
    expect(corroborate([source('a', 0.8), source('a', 0.8), source('a', 0.5)])).toBeCloseTo(0.8, 4);
  });
});

describe('createGraphBuilder', () => {
  const proposal = (value: string, confidence: number) => ({
    entities: [{ key: 'e1', kind: 'hostname' as const, value, confidence }],
    relationships: [{ from: 'e1', to: '$input', kind: 'subdomain_of', confidence }],
    evidence: [{ entity: 'e1', observedAt: '2026-08-24T00:00:00Z', excerpt: 'seen', chunk: 0 }],
  });

  it('merges equal entities across engines and records both sources', () => {
    const builder = createGraphBuilder();
    const seedId = builder.seed('domain', 'example.com', source('intake', 1));

    const first = builder.absorb(seedId, proposal('WWW.example.com', 0.8), source('a', 0.8));
    const second = builder.absorb(seedId, proposal('www.example.com.', 0.7), source('b', 0.7));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // already known: an observation, not a new node
    const host = builder.byKind('hostname')[0]!;
    expect(host.value).toBe('www.example.com');
    expect(host.sources).toHaveLength(2);
    expect(host.confidence).toBeCloseTo(0.94, 2);
    expect(builder.relations).toHaveLength(1);
    expect(builder.relations[0]!.from).toBe(host.id);
  });

  it('drops a relationship to an entity the engine never produced instead of inventing it', () => {
    const builder = createGraphBuilder();
    const seedId = builder.seed('domain', 'example.com', source('intake', 1));
    builder.absorb(
      seedId,
      {
        ...proposal('www.example.com', 0.8),
        relationships: [{ from: 'e1', to: 'ghost', kind: 'related_to', confidence: 0.9 }],
      },
      source('a', 0.8),
    );
    expect(builder.relations).toEqual([]);
  });

  it('keeps two people with the same name apart', () => {
    const builder = createGraphBuilder();
    const seedId = builder.seed('domain', 'example.com', source('intake', 1));
    const one = {
      entities: [{ key: 'p', kind: 'person' as const, value: 'John Smith', confidence: 0.6 }],
      relationships: [],
      evidence: [{ entity: 'p', observedAt: 'now' }],
    };
    builder.absorb(seedId, one, source('a', 0.6));
    builder.absorb(seedId, one, source('b', 0.6));
    expect(builder.byKind('person')).toHaveLength(2);
  });
});

describe('evidence refs (Part 2 §18, §19)', () => {
  const seedSource = {
    runId: 'r1',
    transform: 'query.intake' as const,
    engine: 'intake' as const,
    provider: 'local-runtime' as const,
    input: { kind: 'domain' as const, value: 'example.com' },
    observedAt: '2026-08-24T00:00:00.000Z',
    cached: false,
    confidence: 1,
    evidence: [],
  };

  it('carries the source url and the raw chunk payload onto the entity', () => {
    const builder = createGraphBuilder();
    const seedId = builder.seed('domain', 'example.com', seedSource);
    builder.absorb(
      seedId,
      {
        entities: [{ key: 'e1', kind: 'hostname', value: 'a.example.com', confidence: 0.8 }],
        relationships: [],
        evidence: [{ entity: 'e1', observedAt: 'now', excerpt: 'crt.sh row', chunk: 0 }],
        chunks: [{ at: 'now', url: 'https://crt.sh/?q=example.com', payload: { rows: [1] } }],
      },
      { ...seedSource, confidence: 0.8 },
    );

    const [ref] = builder.byKind('hostname')[0]!.sources[0]!.refs ?? [];
    expect(ref?.url).toBe('https://crt.sh/?q=example.com');
    expect(ref?.raw).toEqual({ rows: [1] });
    expect(ref?.excerpt).toBe('crt.sh row');
  });

  it('leaves the ref bare when the engine offered no chunk, rather than inventing a source', () => {
    const builder = createGraphBuilder();
    const seedId = builder.seed('domain', 'example.com', seedSource);
    builder.absorb(
      seedId,
      {
        entities: [{ key: 'e1', kind: 'hostname', value: 'b.example.com', confidence: 0.5 }],
        relationships: [],
        evidence: [{ entity: 'e1', observedAt: 'now' }],
      },
      { ...seedSource, confidence: 0.5 },
    );
    const [ref] = builder.byKind('hostname')[0]!.sources[0]!.refs ?? [];
    expect(ref).toEqual({ observedAt: 'now' });
  });
});
