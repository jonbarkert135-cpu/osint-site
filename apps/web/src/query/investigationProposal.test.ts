import type { InvestigationResult, Provenance } from '@nexus/query-engine';
import { describe, expect, it } from 'vitest';

import { nodeTypeFor, toImportProposal } from './investigationProposal.ts';

const source = (provider: string, confidence: number): Provenance => ({
  runId: 'run-1',
  transform: 'domain.certificates',
  engine: 'ct-log-search',
  provider,
  input: { kind: 'domain', value: 'example.com' },
  observedAt: '2026-01-01T00:00:00.000Z',
  cached: false,
  confidence,
  evidence: ['crt.sh id 1'],
});

const result = (): InvestigationResult => ({
  summary: {
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    stepsPlanned: 1,
    stepsCompleted: 1,
    stepsFailed: 0,
    stepsSkipped: 0,
    cacheHits: 0,
    entities: 3,
    relations: 1,
    warnings: ['one provider was unreachable'],
  },
  entities: [
    {
      id: 'domain:example.com',
      kind: 'domain',
      value: 'example.com',
      props: {},
      confidence: 1,
      sources: [source('crt.sh', 1)],
      seed: true,
    },
    {
      id: 'hostname:api.example.com',
      kind: 'hostname',
      value: 'api.example.com',
      props: {},
      confidence: 0.9,
      sources: [source('crt.sh', 0.8), source('rdap.org', 0.7)],
      seed: false,
    },
    {
      id: 'crypto_address:0xabc',
      kind: 'crypto_address',
      value: '0xabc',
      props: {},
      confidence: 0.2,
      sources: [source('crt.sh', 0.2)],
      seed: false,
    },
  ],
  relations: [
    {
      id: 'rel-1',
      from: 'hostname:api.example.com',
      to: 'crypto_address:0xabc',
      kind: 'mentions',
      confidence: 0.6,
      derived: false,
      sources: [source('crt.sh', 0.6)],
    },
    {
      id: 'rel-2',
      from: 'hostname:api.example.com',
      to: 'domain:example.com',
      kind: 'subdomain_of',
      confidence: 0.9,
      derived: true,
      derivedBy: 'suffix',
      sources: [],
    },
  ],
  runs: [],
  provenance: [],
});

describe('toImportProposal', () => {
  it('maps entity kinds onto real node types', () => {
    expect(nodeTypeFor('domain')).toBe('website');
    expect(nodeTypeFor('repo')).toBe('repo');
    expect(nodeTypeFor('crypto_address')).toBe('unknown');
  });

  it('proposes every non-seed entity and never re-adds what the analyst typed', () => {
    const proposal = toImportProposal(result(), { boardId: 'b1', runId: 'r1' });

    expect(proposal.summary.newNodes).toBe(2);
    expect(proposal.summary.skippedDuplicates).toBe(1);
    expect(proposal.items.filter((item) => item.kind === 'new_node')).toHaveLength(2);
  });

  it('starts low-confidence results unselected', () => {
    const items = toImportProposal(result(), { boardId: 'b1', runId: 'r1' }).items;
    const strong = items.find((item) => item.id === 'node-q-0');
    const weak = items.find((item) => item.id === 'node-q-1');

    expect(strong?.selectedByDefault).toBe(true);
    expect(weak?.selectedByDefault).toBe(false);
  });

  it('carries provenance and corroboration into the explanation', () => {
    const items = toImportProposal(result(), { boardId: 'b1', runId: 'r1' }).items;
    const strong = items.find((item) => item.id === 'node-q-0');

    expect(strong?.explain).toContain('2 independent providers');
    expect(strong?.kind === 'new_node' ? strong.node.provenance.runId : '').toBe('r1');
  });

  it('drops edges whose endpoints are not both in the proposal', () => {
    const proposal = toImportProposal(result(), { boardId: 'b1', runId: 'r1' });

    // rel-2 points at the seed, which is not proposed: a dangling ref must not be applied.
    expect(proposal.summary.newEdges).toBe(1);
    const edge = proposal.items.find((item) => item.kind === 'new_edge');
    expect(edge?.kind === 'new_edge' ? edge.edge.edgeType : '').toBe('mentions');
  });

  it('surfaces run warnings as proposal issues', () => {
    expect(toImportProposal(result(), { boardId: 'b1', runId: 'r1' }).issues).toEqual([
      { level: 'warn', message: 'one provider was unreachable' },
    ]);
  });
});
