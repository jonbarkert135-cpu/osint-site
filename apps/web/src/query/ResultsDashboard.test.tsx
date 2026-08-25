/** §25/§26 on screen: fact, derivation and hypothesis must never look alike. */

import type { InvestigationResult, Provenance, ResolvedEntity } from '@nexus/query-engine';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ResultsDashboard } from './ResultsDashboard.tsx';

const source = (provider: string, over: Partial<Provenance> = {}): Provenance => ({
  runId: 'r1',
  transform: 'domain.certificates',
  engine: `${provider}-engine`,
  provider,
  input: { kind: 'domain', value: 'example.com' },
  observedAt: '2026-08-25T10:00:00.000Z',
  cached: false,
  confidence: 0.9,
  evidence: [],
  ...over,
});

const entity = (id: string, sources: readonly Provenance[], confidence: number): ResolvedEntity =>
  ({ id, kind: 'hostname', value: id, props: {}, confidence, sources, seed: false }) as ResolvedEntity;

const observed = entity(
  'a.example.com',
  [source('crt.sh', { refs: [{ url: 'https://crt.sh/x', observedAt: '2026-08-25' }] })],
  0.9,
);
const derived = entity('b.example.com', [source('dns.google')], 0.4);

const run: InvestigationResult = {
  summary: {
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    stepsPlanned: 2,
    stepsCompleted: 2,
    stepsFailed: 0,
    stepsSkipped: 0,
    cacheHits: 0,
    entities: 2,
    relations: 1,
    warnings: [],
  },
  entities: [observed, derived],
  relations: [
    {
      id: 'rel-1',
      from: 'a.example.com',
      to: 'b.example.com',
      kind: 'resolves_to',
      confidence: 0.5,
      derived: true,
      sources: [source('dns.google')],
    },
  ],
  runs: [],
  provenance: [source('crt.sh'), source('dns.google')],
  duplicates: [],
} as unknown as InvestigationResult;

describe('ResultsDashboard assurance marks', () => {
  it('labels a sourced finding Observed and an unsourced one Derived', () => {
    render(<ResultsDashboard result={run} />);

    expect(screen.getAllByText('Observed')).toHaveLength(1);
    expect(screen.getAllByText('Derived').length).toBeGreaterThanOrEqual(1);
  });

  it('shows confidence with the source count that earns it', () => {
    render(<ResultsDashboard result={run} />);

    expect(screen.getByText(/High · 0.90 · 1 source\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/Low · 0.40 · 1 source\(s\)/)).toBeInTheDocument();
  });

  it('never presents a resolver-inferred relationship as observed', () => {
    render(<ResultsDashboard result={run} />);

    const relations = screen.getByTestId('ask-relations');
    expect(relations).toHaveTextContent('a.example.com → resolves_to → b.example.com');
    expect(relations).toHaveTextContent('Derived');
    expect(relations).not.toHaveTextContent('Observed');
  });

  it('explains in words why a finding is classified as it is', async () => {
    const user = userEvent.setup();
    render(<ResultsDashboard result={run} onBuildGraph={vi.fn()} />);

    await user.click(screen.getAllByRole('button', { name: 'Expand' })[0] as HTMLElement);
    expect(screen.getByText(/Stated directly by crt.sh/)).toBeInTheDocument();
  });
});
