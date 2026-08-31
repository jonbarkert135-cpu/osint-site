import { describe, expect, it } from 'vitest';

import { conformanceCoverage, formatConformance, runConformance } from '../src/sdk/conformance.ts';
import { createDohResolver } from '../src/sdk/engines/doh-resolver.ts';
import { createTestHost } from '../src/sdk/testkit.ts';
import type { TransformEngine } from '../src/sdk/types.ts';
import { createCatalogRegistry } from '../src/catalog/index.ts';

const url = (type: string): string => `https://dns.google/resolve?name=example.com&type=${type}`;

const NET = {
  [url('A')]: { status: 200, body: { Answer: [{ data: '93.184.216.34', TTL: 300, type: 1 }] } },
  [url('AAAA')]: {
    status: 200,
    body: { Answer: [{ data: '2606:2800:220:1:248:1893:25c8:1946' }] },
  },
  [url('MX')]: { status: 200, body: { Answer: [{ data: '10 mail.example.com.', TTL: 60 }] } },
  [url('NS')]: { status: 200, body: { Answer: [{ data: 'a.iana-servers.net.' }] } },
  'https://dns.google/resolve?name=dns.google&type=A': {
    status: 200,
    body: { Answer: [{ data: '8.8.8.8' }] },
  },
} as const;

const MANIFEST = createCatalogRegistry().engine('doh-resolver');

describe('doh-resolver conformance', () => {
  it('passes the harness against its shipped manifest', async () => {
    expect(MANIFEST).toBeDefined();

    const report = await runConformance(createDohResolver(), {
      manifest: MANIFEST!,
      fixtures: [
        {
          name: 'example.com',
          input: { kind: 'domain', value: 'example.com', entityId: 'n1' },
          net: NET,
          expect: { minEntities: 4, kinds: ['ip', 'dns_record'] },
        },
      ],
      invalidInputs: [
        { kind: 'email', value: 'a@example.com' },
        { kind: 'domain', value: 'not a domain' },
      ],
    });

    expect(formatConformance(report)).toBe(`doh-resolver: ${report.checks.length} checks passed`);
    expect(report.passed).toBe(true);

    // Part 2 §62: the harness is the evidence behind the governance ledger's `tests` field.
    const coverage = conformanceCoverage(report);
    expect(coverage.missing).toEqual([]);
    expect(coverage.covered).toEqual([
      'unit',
      'integration',
      'adapter',
      'health',
      'timeout',
      'failure',
      'normalization',
      'duplicates',
    ]);
  });

  it('resolves records into entities, relationships and evidence', async () => {
    const outcome = await createTestHost({ net: NET }).run(createDohResolver(), {
      kind: 'domain',
      value: 'Example.com.',
      entityId: 'n1',
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.entities.map((entity) => [entity.kind, entity.value])).toEqual([
      ['ip', '93.184.216.34'],
      ['ip', '2606:2800:220:1:248:1893:25c8:1946'],
      ['dns_record', 'mail.example.com'],
      ['dns_record', 'a.iana-servers.net'],
    ]);
    expect(outcome.entities[0]?.props).toEqual({ recordType: 'A', ttl: 300 });
    expect(outcome.relationships.every((rel) => rel.to === '$input')).toBe(true);
    expect(outcome.evidence[0]).toEqual({
      entity: 'A:93.184.216.34',
      observedAt: expect.any(String),
      excerpt: 'A 93.184.216.34',
      chunk: 0,
    });
  });

  it('keeps going but reports non-exhaustive when one record type errors', async () => {
    const outcome = await createTestHost({
      net: { ...NET, [url('MX')]: { status: 502, body: null } },
    }).run(createDohResolver(), { kind: 'domain', value: 'example.com' });

    expect(outcome.status).toBe('completed');
    expect(outcome.exhaustive).toBe(false);
    expect(outcome.entities.map((entity) => entity.value)).not.toContain('mail.example.com');
  });

  it('reports an unhealthy provider instead of throwing', async () => {
    const engine = createDohResolver();
    const ctx = {
      mode: 'zero-credential' as const,
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      maxResults: 1,
      credential: () => undefined,
      log: () => undefined,
    };

    const down = await engine.healthCheck!({
      ...ctx,
      fetch: async () => ({ status: 503, body: null }),
    });
    const missing = await engine.healthCheck!({
      ...ctx,
      fetch: async () => {
        throw new Error('offline');
      },
    });

    expect(down).toMatchObject({ ok: false, detail: 'HTTP 503' });
    expect(missing).toMatchObject({ ok: false, detail: 'offline' });
  });
});

describe('the harness catches a broken engine', () => {
  const broken = (over: Partial<TransformEngine>): TransformEngine => ({
    ...createDohResolver(),
    ...over,
  });

  const check = async (engine: TransformEngine): Promise<readonly string[]> => {
    const report = await runConformance(engine, {
      manifest: MANIFEST!,
      fixtures: [
        { name: 'example.com', input: { kind: 'domain', value: 'example.com' }, net: NET },
      ],
      invalidInputs: [{ kind: 'email', value: 'a@example.com' }],
    });
    return report.checks.filter((entry) => !entry.ok).map((entry) => entry.id);
  };

  it('flags metadata that disagrees with the manifest', async () => {
    const failed = await check(
      broken({
        metadata: () => ({ ...createDohResolver().metadata(), version: '9.9.9' }),
      }),
    );
    expect(failed).toContain('metadata-matches-manifest');
  });

  it('flags an engine that accepts an input it cannot handle', async () => {
    const failed = await check(broken({ validateInput: () => ({ ok: true }) }));
    expect(failed).toContain('rejects-invalid-input:email/a@example.com');
  });

  it('flags a non-deterministic normalize', async () => {
    let seq = 0;
    const failed = await check(
      broken({
        normalize: () => ({
          entities: [{ key: `k${(seq += 1)}`, kind: 'ip', value: '1.1.1.1', confidence: 1 }],
          relationships: [],
          evidence: [{ entity: `k${seq}`, observedAt: '2026-08-19T10:00:00.000Z' }],
        }),
      }),
    );
    expect(failed).toContain('normalize-is-pure:example.com');
  });

  it('flags an engine producing kinds it never declared', async () => {
    const failed = await check(
      broken({
        normalize: () => ({
          entities: [{ key: 'p1', kind: 'person', value: 'Ada', confidence: 1 }],
          relationships: [],
          evidence: [{ entity: 'p1', observedAt: '2026-08-19T10:00:00.000Z' }],
        }),
      }),
    );
    expect(failed).toContain('outputs-within-declared-kinds:example.com');
  });

  it('flags an engine that never checks its abort signal', async () => {
    const failed = await check(
      broken({
        execute: async function* () {
          yield { at: new Date().toISOString(), payload: { recordType: 'A', answers: [] } };
          await new Promise((resolve) => setTimeout(resolve, 300));
          yield { at: new Date().toISOString(), payload: { recordType: 'AAAA', answers: [] } };
        },
      }),
    );
    expect(failed).toContain('reacts-to-abort:example.com');
  });

  it('reports the failing checks in one line', async () => {
    const report = await runConformance(createDohResolver(), {
      manifest: MANIFEST!,
      fixtures: [],
      invalidInputs: [],
    });
    expect(report.passed).toBe(false);
    expect(formatConformance(report)).toContain('has-fixtures');
  });
});
