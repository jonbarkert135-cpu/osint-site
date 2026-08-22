/**
 * `repositories.*` — read access to the stored repository analysis (11_GITHUB.md §5.10, §6.4).
 *
 * Read-only by design: producing an analysis is the worker's job, so the router only hands the
 * cached result (and its draft proposal) to the panel. The row lookup lives in
 * `@nexus/integrations` because the core may not name a tool (R1).
 */

import { z } from 'zod';
import { prisma } from '@nexus/db';
import { readLatestRepositoryAnalysis } from '@nexus/integrations/repository-analysis';

import { orgProcedure, router } from '../trpc.ts';

export const repositoriesRouter = router({
  /** The newest analysis for `repoKey`, or `null` when the repository was never analyzed. */
  latestAnalysis: orgProcedure('viewer')
    .input(z.object({ repoKey: z.string().min(1).max(255) }))
    .query(async ({ input }) => readLatestRepositoryAnalysis(prisma, input.repoKey)),
});
