/**
 * Reading side of the analysis cache (11_GITHUB.md §5.10, §6.4).
 *
 * The core may not name a tool (R1), so the row lookup lives here and the API passes its Prisma
 * client in. Structural typing keeps this package free of a `@nexus/db` dependency: only the two
 * fields the reader touches are declared.
 */

import { RepositoryAnalysisSchema, type RepositoryAnalysis } from '@nexus/domain';

import type { IntegrationProposal } from './proposal.ts';
import { GITHUB_QUEUE, githubJobOptions, type GithubAnalyzePayload } from './jobs.ts';

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

/* ------------------------------------------------------------------ *
 * Requesting an analysis (§10). The core may not name a tool (R1), so the queue name, the job
 * options and the "can this host be analyzed at all" answer live here and the API stays generic.
 * ------------------------------------------------------------------ */

/** Hosts the analyzer understands, as they appear in a `host/owner/name` key. */
export const ANALYZABLE_HOSTS: readonly string[] = ['github.com'];

/** `host/owner/name`, lowercased — the shape the client builds from a repository node's URL. */
export const REPO_KEY_PATTERN = /^[a-z0-9.-]+\/[\w.-]+\/[\w.-]+$/;

export function isAnalyzableRepoKey(repoKey: string): boolean {
  if (!REPO_KEY_PATTERN.test(repoKey)) return false;
  return ANALYZABLE_HOSTS.includes(repoKey.split('/')[0] ?? '');
}

export interface RepositoryAnalysisRequest {
  repoKey: string;
  headSha: string;
  analyzerVersion: string;
  userId: string;
  boardId: string;
  force?: boolean;
}

export interface QueuedJob {
  queue: string;
  name: string;
  payload: RepositoryAnalysisRequest;
  options: ReturnType<typeof githubJobOptions>;
}

/**
 * The one job an analysis request turns into. Without `force` the idempotency key in §10 dedupes a
 * second request for the same head against the one already queued, so a double-click costs nothing.
 */
export function repositoryAnalysisJob(request: RepositoryAnalysisRequest): QueuedJob {
  const payload: GithubAnalyzePayload = request;
  return {
    queue: GITHUB_QUEUE,
    name: 'github.analyze',
    payload,
    options: githubJobOptions('github.analyze', payload),
  };
}
