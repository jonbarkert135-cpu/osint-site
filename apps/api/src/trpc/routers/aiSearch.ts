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
import { loadServerEnvFromProcess } from '../../env.ts';
import { orgProcedure, router } from '../trpc.ts';

const zSearchInput = z.object({
  projectId: z.string().min(1),
  boardId: z.string().min(1).optional(),
  query: z.string().min(1).max(2000),
  k: z.number().int().min(1).max(50).default(12),
});

let cached: { retriever: Retriever; modelId: string } | undefined;

function retriever(): { retriever: Retriever; modelId: string } {
  if (cached === undefined) {
    const env = loadServerEnvFromProcess();
    const embedder: Embedder =
      env.AI_PROVIDER === 'openai-compatible' && env.AI_BASE_URL !== undefined
        ? openAICompatibleEmbedder({
            baseUrl: env.AI_BASE_URL,
            model: env.AI_EMBED_MODEL,
            ...(env.AI_API_KEY === undefined ? {} : { apiKey: env.AI_API_KEY }),
          })
        : unavailableEmbedder();
    cached = {
      retriever: createRetriever({ embedder, search: createChunkStore(embedder.modelId) }),
      modelId: embedder.modelId,
    };
  }
  return cached;
}

/** Test-only: the retriever memoizes env, and env tests change it. */
export const resetAiSearchForTests = (): void => {
  cached = undefined;
};

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

      const { retriever: retrieve, modelId } = retriever();
      const scope = {
        projectId: input.projectId,
        ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
      };
      const result = await retrieve(input.query, scope, input.k);
      return {
        chunks: result.chunks,
        semantic: result.semantic,
        model: result.semantic ? modelId : null,
      };
    }),
});
