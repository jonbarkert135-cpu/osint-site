/**
 * `ai.search` — hybrid retrieval over a project's chunks (14_AI_AGENT.md §6.5). Read-only, viewer
 * role: search never writes and never widens anything (N4). When no embedding endpoint is
 * configured the answer is still real — keyword-only, and `semantic: false` says so (U5).
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { prisma } from '@nexus/db';
import { createRetriever, openAICompatibleEmbedder, unavailableEmbedder } from '@nexus/ai';
import type { Embedder, Retriever } from '@nexus/ai';

import { createChunkStore } from '../../ai/chunkStore.ts';
import { resolveAiEndpoint, withAiKey } from '../../ai/settings.ts';
import { orgProcedure, router } from '../trpc.ts';

const zSearchInput = z.object({
  projectId: z.string().min(1),
  boardId: z.string().min(1).optional(),
  query: z.string().min(1).max(2000),
  k: z.number().int().min(1).max(50).default(12),
});

/**
 * Per request, from the org's own settings (14 §2.3): an admin can repoint the endpoint from
 * Settings → AI without a restart, so caching a retriever built from boot-time env would serve a
 * stale endpoint. The key exists only inside `withAiKey`, never on a module-level object.
 */
async function withRetriever<T>(
  orgId: string,
  use: (retrieve: Retriever, modelId: string) => Promise<T>,
): Promise<T> {
  const endpoint = await resolveAiEndpoint(orgId);
  const run = (embedder: Embedder): Promise<T> =>
    use(
      createRetriever({ embedder, search: createChunkStore(embedder.modelId) }),
      embedder.modelId,
    );
  if (!endpoint.configured || endpoint.baseUrl === null || endpoint.embedModel === '') {
    return await run(unavailableEmbedder());
  }
  const baseUrl = endpoint.baseUrl;
  return await withAiKey(orgId, async (apiKey) =>
    run(
      openAICompatibleEmbedder({
        baseUrl,
        model: endpoint.embedModel,
        ...(apiKey === undefined ? {} : { apiKey }),
      }),
    ),
  );
}

export const aiRouter = router({
  search: orgProcedure('viewer')
    .input(zSearchInput)
    .query(async ({ ctx, input }) => {
      const project = await prisma.project.findFirst({
        where: { id: input.projectId, orgId: ctx.org.id, deletedAt: null },
        select: { id: true },
      });
      if (!project) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That project no longer exists.' });
      }

      const scope = {
        projectId: input.projectId,
        ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
      };
      return await withRetriever(ctx.org.id, async (retrieve, modelId) => {
        const result = await retrieve(input.query, scope, input.k);
        return {
          chunks: result.chunks,
          semantic: result.semantic,
          model: result.semantic ? modelId : null,
        };
      });
    }),
});
