import { describe, expect, it } from 'vitest';

import { assessEntity, assessRelation, confidenceBand, type Assessment } from '../src/assurance.ts';
import type { Provenance, ResolvedEntity, ResolvedRelation } from '../src/resolve.ts';

const source = (provider: string, over: Partial<Provenance> = {}): Provenance => ({
  runId: 'run-1',
  transform: 't',
  engine: `${provider}-engine`,
  provider,
  input: { kind: 'domain', value: 'example.com' },
  observedAt: '2026-08-25T00:00:00Z',
  cached: false,
  confidence: 0.8,
  evidence: [],
  ...over,
});

const withEvidence = (provider: string): Provenance =>
  source(provider, { refs: [{ url: `https://${provider}/x`, observedAt: '2026-08-25' }] });

const entity = (sources: readonly Provenance[], confidence = 0.8): ResolvedEntity =>
  ({
    id: 'e1',
    kind: 'domain',
    value: 'example.com',
    props: {},
    confidence,
    sources,
    seed: false,
  }) as ResolvedEntity;

const relation = (
  sources: readonly Provenance[],
  derived: boolean,
  confidence = 0.6,
): ResolvedRelation => ({
  id: 'r1',
  from: 'a',
  to: 'b',
  kind: 'resolves_to',
  confidence,
  derived,
  sources,
});

describe('confidenceBand', () => {
  it('splits the scale where the wording changes', () => {
    expect(confidenceBand(0.9)).toBe('high');
    expect(confidenceBand(0.75)).toBe('high');
    expect(confidenceBand(0.5)).toBe('medium');
    expect(confidenceBand(0.44)).toBe('low');
  });
});

describe('assessEntity', () => {
  it('calls a finding observed when a provider stated it and left evidence', () => {
    const assessment: Assessment = assessEntity(entity([withEvidence('crt.sh')]));
    expect(assessment.assurance).toBe('observed');
    expect(assessment.sourceCount).toBe(1);
    expect(assessment.evidenceCount).toBe(1);
    expect(assessment.why).toContain('crt.sh');
  });

  it('calls it derived when nothing backs it up directly', () => {
    expect(assessEntity(entity([source('dns.google')])).assurance).toBe('derived');
  });

  it('counts independent providers, not repeated observations', () => {
    const assessment = assessEntity(
      entity([withEvidence('crt.sh'), withEvidence('crt.sh'), withEvidence('dns.google')]),
    );
    expect(assessment.sourceCount).toBe(2);
    expect(assessment.evidenceCount).toBe(3);
  });

  it('marks a model suggestion as an inference and says so', () => {
    const assessment = assessEntity(entity([withEvidence('openai')], 0.9));
    expect(assessment.assurance).toBe('observed');
    const modelled = assessEntity(
      entity([source('openai', { engine: 'ai-extract', refs: [{ observedAt: 'x' }] })], 0.9),
    );
    expect(modelled.assurance).toBe('inference');
    expect(modelled.band).toBe('high');
    expect(modelled.why).toContain('hypothesis');
  });
});

describe('assessRelation', () => {
  it('never presents a resolver-inferred edge as observed', () => {
    expect(assessRelation(relation([withEvidence('crt.sh')], true)).assurance).toBe('derived');
    expect(assessRelation(relation([withEvidence('crt.sh')], false)).assurance).toBe('observed');
  });

  it('reports the confidence band with the sources that earned it', () => {
    const assessment = assessRelation(
      relation([withEvidence('crt.sh'), withEvidence('dns.google')], false, 0.92),
    );
    expect(assessment.band).toBe('high');
    expect(assessment.sourceCount).toBe(2);
  });
});
