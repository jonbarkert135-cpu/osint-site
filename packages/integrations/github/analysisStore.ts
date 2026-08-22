/**
 * Reading side of the analysis cache (11_GITHUB.md §5.10, §6.4).
 *
 * The core may not name a tool (R1), so the row lookup lives here and the API passes its Prisma
 * client in. Structural typing keeps this package free of a `@nexus/db` dependency: only the two
 * fields the reader touches are declared.
 */

import { RepositoryAnalysisSchema, type RepositoryAnalysis } from '@nexus/domain';

import type { IntegrationProposal } from './proposal.ts';

export interface AnalysisRowClient {
  githubAnalysis: {
    findFirst(args: {
      where: { repoKey: string };
      orderBy: { createdAt: 'desc' };
      select: { payload: true; proposal: true };
    }): Promise<{ payload: unknown; proposal: unknown } | null>;
  };
}

export interface StoredRepositoryAnalysis {
  analysis: RepositoryAnalysis;
  proposal: IntegrationProposal | null;
}

/**
 * The newest analysis for a repository, or `null` when it has never been analyzed. A row that no
 * longer matches the schema (an older analyzer version) reads as "not analyzed" rather than
 * crashing the panel — re-running the analysis is the fix, and the UI offers exactly that.
 */
export async function readLatestRepositoryAnalysis(
  client: AnalysisRowClient,
  repoKey: string,
): Promise<StoredRepositoryAnalysis | null> {
  const row = await client.githubAnalysis.findFirst({
    where: { repoKey },
    orderBy: { createdAt: 'desc' },
    select: { payload: true, proposal: true },
  });
  if (row === null) return null;

  const parsed = RepositoryAnalysisSchema.safeParse(row.payload);
  if (!parsed.success) return null;

  return {
    analysis: parsed.data,
    proposal: row.proposal === null ? null : (row.proposal as IntegrationProposal),
  };
}
