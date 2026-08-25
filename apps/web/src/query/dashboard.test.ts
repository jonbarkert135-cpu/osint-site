/** The dashboard is derived from the run, so the run is the only fixture these tests need. */

import type { InvestigationResult, Provenance, ResolvedEntity } from '@nexus/query-engine';
import { describe, expect, it } from 'vitest';

import { buildDashboard, sourceOf } from './dashboard.ts';

const source = (provider: string, extra: Partial<Provenance> = {}): Provenance => ({
  runId: 'r1',
  transform: 't1',
  engine: 'e1',
  provider,
  input: { kind: 'domain', value: 'example.com' },
  observedAt: '2026-08-25T10:00:00.000Z',
  cached: false,
  confidence: 0.8,
  evidence: [],
  ...extra,
});

const entity = (
  id: string,
  kind: string,
  sources: readonly Provenance[],
  confidence = 0.8,
): ResolvedEntity =>
  ({ id, kind, value: id, props: {}, confidence, sources, seed: false }) as ResolvedEntity;

const withUrl = (provider: string): Provenance =>
  source(provider, {
    refs: [{ url: 'https://crt.sh/?q=example.com', raw: { ok: true }, observedAt: '2026-08-25' }],
  });

const run = (over: Partial<InvestigationResult> = {}): InvestigationResult => ({
  summary: {
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    stepsPlanned: 2,
    stepsCompleted: 2,
    stepsFailed: 0,
    stepsSkipped: 0,
    cacheHits: 0,
    entities: 0,
    relations: 0,
    warnings: [],
  },
  entities: [],
  relations: [],
  runs: [],
  provenance: [],
  duplicates: [],
  ...over,
});

describe('buildDashboard', () => {
  it('counts what the run produced, not a fixed set of tiles', () => {
    const a = withUrl('crt.sh');
    const b = source('dns.google');
    const dashboard = buildDashboard(
      run({
        entities: [
          entity('example.com', 'domain', [a]),
          entity('mail.example.com', 'hostname', [a]),
          entity('93.184.216.34', 'ip', [b]),
          { ...entity('seed', 'domain', [a]), seed: true },
        ],
        relations: [{ id: 'r' } as never],
        provenance: [a, b],
      }),
    );

    expect(dashboard.counters[0]).toEqual({ label: 'Entities', value: '3' });
    expect(dashboard.counters).toContainEqual({ label: 'Relationships', value: '1' });
    expect(dashboard.counters).toContainEqual({
      label: 'Service results',
      value: '2/2 complete',
    });
    // Kinds appear only because the run produced them.
    expect(dashboard.counters.map((counter) => counter.label)).toContain('hostname');
  });

  it('gives every service its own panel, including one that found nothing', () => {
    const a = withUrl('crt.sh');
    const quiet = source('sherlock');
    const dashboard = buildDashboard(
      run({ entities: [entity('example.com', 'domain', [a])], provenance: [a, quiet] }),
    );

    expect(dashboard.services.map((panel) => panel.provider)).toEqual(['crt.sh', 'sherlock']);
    expect(dashboard.services[0]?.state).toBe('complete');
    expect(dashboard.services[1]?.state).toBe('empty');
  });

  it('marks a service failed when its run failed', () => {
    const a = source('crt.sh');
    const dashboard = buildDashboard(
      run({
        entities: [],
        provenance: [a],
        runs: [{ provider: 'crt.sh', status: 'failed' } as never],
      }),
    );

    expect(dashboard.services[0]?.state).toBe('failed');
  });

  it('recommends what to do next instead of only reporting', () => {
    const a = source('crt.sh');
    const dashboard = buildDashboard(
      run({
        entities: [entity('weak.example', 'domain', [a], 0.3)],
        provenance: [a],
        duplicates: [
          { a: 'x', b: 'y', verdict: 'likely_duplicate', reason: 'same place' } as never,
        ],
        summary: { ...run().summary, stepsFailed: 1 },
      }),
    );

    const text = dashboard.recommendations.join(' ');
    expect(text).toContain('1 possible duplicate');
    expect(text).toContain('1 service failed');
    expect(text).toContain('below 0.5 confidence');
    expect(text).toContain('no source URL');
  });

  it('orders the timeline by observation time and lists evidence with its source', () => {
    const early = withUrl('crt.sh');
    const late = source('dns.google', { observedAt: '2026-08-25T12:00:00.000Z', cached: true });
    const dashboard = buildDashboard(
      run({
        entities: [entity('example.com', 'domain', [late, early])],
        provenance: [late, early],
      }),
    );

    expect(dashboard.timeline.map((item) => item.provider)).toEqual(['crt.sh', 'dns.google']);
    expect(dashboard.timeline[1]?.label).toContain('cached');
    expect(dashboard.evidence).toHaveLength(1);
    expect(dashboard.evidence[0]?.ref.url).toContain('crt.sh');
  });
});

describe('sourceOf', () => {
  it('returns nothing rather than inventing a link when no ref carries one', () => {
    expect(sourceOf(entity('x', 'domain', [source('crt.sh')]))).toEqual({});
    expect(sourceOf(entity('x', 'domain', [withUrl('crt.sh')])).url).toContain('crt.sh');
  });
});
