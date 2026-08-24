/**
 * Container for the Repository Analysis panel: turns the stored row into what the panel renders.
 *
 * Kept apart from the panel so the presentation stays testable without a tRPC provider, and so the
 * inspector can mount one component for a repository node and nothing at all for every other kind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

/** How long the panel keeps polling for a result before it says the analysis did not arrive. */
export const ANALYSIS_POLL_INTERVAL_MS = 3_000;
export const ANALYSIS_POLL_TIMEOUT_MS = 5 * 60_000;

export function RepositoryAnalysisSection({ repositoryUrl }: RepositoryAnalysisSectionProps) {
  const repoKey = repoKeyOf(repositoryUrl);
  /** Set when the user asks for an analysis; cleared by a newer result, a failure or the timeout. */
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const analyzing = requestedAt !== null;

  const query = trpc.repositories.latestAnalysis.useQuery(
    { repoKey: repoKey ?? '' },
    {
      enabled: repoKey !== null,
      retry: false,
      // Polling exists only while a run is in flight: an idle panel makes one request, not a stream.
      refetchInterval: analyzing ? ANALYSIS_POLL_INTERVAL_MS : false,
    },
  );

  const analyze = trpc.repositories.analyze.useMutation({
    onSuccess: () => {
      setRequestError(null);
      setRequestedAt(Date.now());
    },
    onError: (error) => {
      setRequestedAt(null);
      setRequestError(error.message);
    },
  });

  // The analysis is done when a row newer than the request shows up, and the poll stops there.
  const storedHead = query.data?.analysis.headSha ?? null;
  const headAtRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!analyzing) return;
    if (storedHead !== null && storedHead !== headAtRequest.current) setRequestedAt(null);
  }, [analyzing, storedHead]);

  // A worker that never answers must not leave a spinner running forever (U5).
  useEffect(() => {
    if (requestedAt === null) return;
    const elapsed = Date.now() - requestedAt;
    const timer = setTimeout(
      () => {
        setRequestedAt(null);
        setRequestError(
          'The analysis did not come back in time. It may still be running — try again in a minute, or open the repository and record what you find by hand.',
        );
      },
      Math.max(0, ANALYSIS_POLL_TIMEOUT_MS - elapsed),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [requestedAt]);

  const onAnalyze = useCallback(() => {
    if (repoKey === null) return;
    headAtRequest.current = query.data?.analysis.headSha ?? null;
    analyze.mutate({ repoKey, force: query.data !== null && query.data !== undefined });
  }, [analyze, query.data, repoKey]);

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
      analyzing={analyzing}
      onAnalyze={onAnalyze}
      error={
        requestError !== null
          ? { title: 'The analysis could not be started', detail: requestError }
          : query.error === null
            ? null
            : {
                title: 'The analysis could not be loaded',
                detail:
                  'The repository analysis is not available right now. Try again, open the repository on its host, or record what you find by hand.',
              }
      }
      onRetry={() => {
        setRequestError(null);
        void query.refetch();
      }}
      onAnalyzeManually={() => {
        window.open(repositoryUrl, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}
