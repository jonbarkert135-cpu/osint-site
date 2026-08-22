/** The pure mapping the analysis container does before the panel renders. */

import type { IntegrationProposal } from '@nexus/integrations/github/proposal';
import { describe, expect, it } from 'vitest';

import { repoKeyOf, toProposalView } from './RepositoryAnalysisSection.tsx';

describe('repoKeyOf', () => {
  it('builds the stored key from a repository URL', () => {
    expect(repoKeyOf('https://github.com/smicallef/spiderfoot')).toBe(
      'github.com/smicallef/spiderfoot',
    );
    expect(repoKeyOf('https://GitHub.com/Smicallef/SpiderFoot.git')).toBe(
      'github.com/smicallef/spiderfoot',
    );
  });

  it('returns null for anything that is not a repository URL', () => {
    expect(repoKeyOf('https://github.com/smicallef')).toBeNull();
    expect(repoKeyOf('not a url')).toBeNull();
  });
});

describe('toProposalView', () => {
  const proposal = {
    id: 'p-1',
    repoKey: 'github.com/o/r',
    analysisId: 'a-1',
    generatedAt: '2026-08-22T20:00:00.000Z',
    executionMode: 'container',
    confidence: 0.5,
    requiresHumanReview: true,
    blockers: ['license'],
    draftManifest: {
      id: 'draft',
      name: 'Draft',
      version: '0.1.0-draft',
      repository: 'https://github.com/o/r',
      execution: {
        kind: 'container',
        image: 'ghcr.io/o/r:latest',
        build: null,
        command: [],
        timeoutMs: 1000,
        network: 'none',
        egressAllowlist: [],
      },
      inputs: [],
      outputs: { format: 'json', path: null, flag: null },
      parserHint: 'json lines',
      proposedNodeKinds: ['domain'],
      proposedEdgeKinds: ['related_to'],
    },
    rationale: 'Because.',
  } as unknown as IntegrationProposal;

  it('prefers the container image as the adapter, and falls back to the parser hint', () => {
    expect(toProposalView(proposal).adapter).toBe('ghcr.io/o/r:latest');
    const noImage = {
      ...proposal,
      draftManifest: {
        ...proposal.draftManifest,
        execution: { ...proposal.draftManifest.execution, image: null },
      },
    };
    expect(toProposalView(noImage).adapter).toBe('json lines');
  });

  it('carries blockers and proposed node kinds to the panel', () => {
    const view = toProposalView(proposal);
    expect(view.blockers).toEqual(['license']);
    expect(view.nodeKinds).toEqual(['domain']);
  });
});
