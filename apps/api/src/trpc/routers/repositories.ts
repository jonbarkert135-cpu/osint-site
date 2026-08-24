/**
 * `repositories.*` — the stored repository analysis and the request to (re)build it
 * (11_GITHUB.md §5.10, §6.4, §10).
 *
 * The API never analyzes (N5): `analyze` validates the key, records the request and enqueues the
 * job the worker consumes; `latestAnalysis` hands the cached result (and its draft proposal) to the
 * panel. Which hosts are analyzable, and what the job looks like, are answered by
 * `@nexus/integrations` — the core may not name a tool (R1).
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@nexus/db';
import {
  isAnalyzableRepoKey,
  readLatestRepositoryAnalysis,
} from '@nexus/integrations/repository-analysis';
import { ANALYZER_VERSION } from '@nexus/domain';

import { audit } from '../../audit.ts';
import { enqueueRepositoryAnalysis } from '../../integrations/analysisQueue.ts';
import { orgProcedure, router } from '../trpc.ts';

const RepoKey = z.string().min(1).max(255);

export const repositoriesRouter = router({
  /** The newest analysis for `repoKey`, or `null` when the repository was never analyzed. */
  latestAnalysis: orgProcedure('viewer')
    .input(z.object({ repoKey: RepoKey }))
    .query(async ({ input }) => readLatestRepositoryAnalysis(prisma, input.repoKey)),

  /**
   * Requests an analysis of `repoKey`. Returns as soon as the job is queued — the panel polls
   * `latestAnalysis` for the result, so a slow analysis never holds a request open.
   */
  analyze: orgProcedure('editor')
    .input(z.object({ repoKey: RepoKey, force: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      if (!isAnalyzableRepoKey(input.repoKey)) {
        // A clear refusal, not a silent no-op: the panel prints this sentence to the user.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This repository cannot be analyzed: ${input.repoKey} is not on a host the analyzer supports.`,
        });
      }

      const repository = await prisma.repository.findUnique({ where: { repoKey: input.repoKey } });
      // The head the analysis is keyed by: an unhydrated repository has none yet, and 'HEAD' lets
      // the worker resolve the default branch itself rather than refusing the first run.
      const headSha = repository?.lastHeadSha ?? 'HEAD';

      await enqueueRepositoryAnalysis({
        repoKey: input.repoKey,
        headSha,
        analyzerVersion: ANALYZER_VERSION,
        userId: ctx.user.id,
        boardId: '',
        force: input.force,
      });

      await audit(
        {
          action: 'repository.analysis.requested',
          outcome: 'success',
          actorId: ctx.user.id,
          orgId: ctx.org.id,
          targetKind: 'repository',
          targetId: input.repoKey,
          ip: ctx.ip,
          metadata: { headSha, analyzerVersion: ANALYZER_VERSION, forced: input.force },
        },
        ctx.logger,
      );

      return { queued: true as const, repoKey: input.repoKey, headSha };
    }),
});
