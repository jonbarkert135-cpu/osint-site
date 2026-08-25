import { describe, expect, it } from 'vitest';

import {
  parseEngineManifest,
  parseProviderManifest,
  parseTransformManifest,
} from '../src/manifest.ts';

const transform = {
  id: 'domain-to-dns',
  version: '1.0.0',
  name: 'Discover DNS records',
  description: 'DNS records for a domain.',
  category: 'infrastructure',
  capability: 'dns-discovery',
  inputs: ['domain'],
  outputs: ['dns_record'],
  engines: ['doh-resolver'],
  priority: 'core',
  cost: 'fast',
  limits: { expectedRuntimeMs: 800, maxResults: 40, maxInputBatch: 50 },
  cacheable: false,
  documentation: 'docs/ecosystem/TRANSFORM_CATALOG.md',
  status: 'stable',
};

const engine = {
  id: 'doh-resolver',
  version: '1.0.0',
  capability: 'dns-discovery',
  provider: 'dns-google',
  dataFlow: 'network',
  permissions: ['network'],
  quality: { resultQuality: 0.9, reliability: 0.9, maintenance: 1 },
  cost: 'fast',
  terminal: false,
  status: 'stable',
};

const provider = {
  id: 'dns-google',
  name: 'Google Public DNS',
  credentialClass: 'A',
  credentials: 'none',
  pricing: 'free',
  licence: 'public endpoint',
  limits: {},
  lastVerified: '2026-08-19',
  status: 'configured',
  alternatives: [],
};

describe('transform manifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseTransformManifest(transform).id).toBe('domain-to-dns');
  });

  it('rejects a non-kebab-case id', () => {
    expect(() => parseTransformManifest({ ...transform, id: 'Domain_To_DNS' })).toThrow();
  });

  it('rejects an unknown entity kind', () => {
    expect(() => parseTransformManifest({ ...transform, outputs: ['ectoplasm'] })).toThrow();
  });

  it('rejects a cacheable transform without a TTL', () => {
    expect(() => parseTransformManifest({ ...transform, cacheable: true })).toThrow(
      /cacheTtlSeconds/,
    );
  });

  it('accepts a cacheable transform with a TTL', () => {
    const parsed = parseTransformManifest({ ...transform, cacheable: true, cacheTtlSeconds: 60 });
    expect(parsed.cacheTtlSeconds).toBe(60);
  });

  it('rejects unknown fields', () => {
    expect(() => parseTransformManifest({ ...transform, vendor: 'maltego' })).toThrow();
  });

  it('rejects an empty engine list: a transform with no engine cannot be routed', () => {
    expect(() => parseTransformManifest({ ...transform, engines: [] })).toThrow();
  });
});

describe('engine manifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseEngineManifest(engine).provider).toBe('dns-google');
  });

  it('rejects a networked engine that does not declare the network permission', () => {
    expect(() => parseEngineManifest({ ...engine, permissions: [] })).toThrow(/network/);
  });

  it('allows a local engine with no permissions', () => {
    const local = parseEngineManifest({ ...engine, dataFlow: 'local', permissions: [] });
    expect(local.permissions).toEqual([]);
  });

  it('rejects a quality signal outside 0..1', () => {
    expect(() =>
      parseEngineManifest({ ...engine, quality: { ...engine.quality, reliability: 1.4 } }),
    ).toThrow();
  });
});

describe('provider manifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseProviderManifest(provider).credentialClass).toBe('A');
  });

  it('rejects a malformed lastVerified date', () => {
    expect(() => parseProviderManifest({ ...provider, lastVerified: '19.08.2026' })).toThrow();
  });

  it('rejects a non-url endpoint', () => {
    expect(() => parseProviderManifest({ ...provider, endpoint: 'dns.google' })).toThrow();
  });
});

describe('engine runtime passport (Part 2 §39)', () => {
  const runtime = {
    runtime: 'python',
    deployment: 'containerized',
    requirements: { image: 'sherlock/sherlock:latest', memoryMb: 512, cpu: 1, persistent: false },
    hostCompatible: true,
  };

  it('accepts a complete passport', () => {
    expect(parseEngineManifest({ ...engine, runtime }).runtime?.runtime).toBe('python');
  });

  it('is optional, so existing manifests keep parsing', () => {
    expect(parseEngineManifest(engine).runtime).toBeUndefined();
  });

  it('rejects a containerized engine with no image', () => {
    const { image: _image, ...requirements } = runtime.requirements;
    expect(() => parseEngineManifest({ ...engine, runtime: { ...runtime, requirements } })).toThrow(
      /image/,
    );
  });

  it('rejects an unsupported engine with no fallback strategy', () => {
    expect(() =>
      parseEngineManifest({
        ...engine,
        runtime: { ...runtime, deployment: 'unsupported', hostCompatible: false },
      }),
    ).toThrow(/fallback/);
  });

  it('rejects an unknown runtime', () => {
    expect(() =>
      parseEngineManifest({ ...engine, runtime: { ...runtime, runtime: 'cobol' } }),
    ).toThrow();
  });
});
