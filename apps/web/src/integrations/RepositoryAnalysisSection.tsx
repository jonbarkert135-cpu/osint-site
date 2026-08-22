/**
 * Container for the Repository Analysis panel: turns the stored row into what the panel renders.
 *
 * Kept apart from the panel so the presentation stays testable without a tRPC provider, and so the
 * inspector can mount one component for a repository node and nothing at all for every other kind.
 */

import type { RepositoryAnalysis } from '@nexus/domain';
import type { IntegrationProposal } from '@nexus/integrations/github/proposal';

import { trpc } from '../lib/trpc.tsx';
import {
  RepositoryAnalysisPanel,
  type RepositoryProposalView,
} from './RepositoryAnalysisPanel.tsx';

/** `github.com/owner/name` — the key the analysis rows are stored under. */
export function repoKeyOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const [owner, name] = parsed.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/');
    if (owner === undefined || name === undefined || name === '') return null;
    return `${parsed.host}/${owner}/${name}`.toLowerCase();
  } catch {
    return null;
  }
}

export function toProposalView(proposal: IntegrationProposal): RepositoryProposalView {
  return {
    executionMode: proposal.executionMode,
    confidence: proposal.confidence,
    blockers: proposal.blockers,
    adapter: proposal.draftManifest.execution.image ?? proposal.draftManifest.parserHint,
    nodeKinds: proposal.draftManifest.proposedNodeKinds,
    rationale: proposal.rationale,
  };
}

export interface RepositoryAnalysisSectionProps {
  /** The repository node's URL; a URL the analyzer cannot key renders nothing. */
  repositoryUrl: string;
}

export function RepositoryAnalysisSection({ repositoryUrl }: RepositoryAnalysisSectionProps) {
  const repoKey = repoKeyOf(repositoryUrl);
  const query = trpc.repositories.latestAnalysis.useQuery(
    { repoKey: repoKey ?? '' },
    { enabled: repoKey !== null, retry: false },
  );

  if (repoKey === null) return null;

  const stored = query.data ?? null;
  const analysis: RepositoryAnalysis | null = stored?.analysis ?? null;
  const proposal =
    stored === null || stored.proposal === null ? null : toProposalView(stored.proposal);

  return (
    <RepositoryAnalysisPanel
      repoKey={repoKey}
      repositoryUrl={repositoryUrl}
      analysis={analysis}
      proposal={proposal}
      error={
        query.error === null
          ? null
          : {
              title: 'The analysis could not be loaded',
              detail:
                'The repository analysis is not available right now. Try again, open the repository on its host, or record what you find by hand.',
            }
      }
      onRetry={() => {
        void query.refetch();
      }}
      onAnalyzeManually={() => {
        window.open(repositoryUrl, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}
