/** `ai.search` — hybrid retrieval endpoint with honest keyword-only degradation (14 §6.5, U5). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ID, ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const loadServerEnvFromProcess = vi.fn();
vi.mock('../src/env.ts', () => ({ loadServerEnvFromProcess }));

const vector = vi.fn();
const lexical = vi.fn();
vi.mock('../src/ai/chunkStore.ts', () => ({ createChunkStore: () => ({ vector, lexical }) }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');
const { resetAiSearchForTests } = await import('../src/trpc/routers/aiSearch.ts');

const caller = createCallerFactory(appRouter);

const chunk = (id: string, nodeId: string, score: number) => ({
  id,
  nodeId,
  text: `text ${id}`,
  score,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetAiSearchForTests();
  prismaMock.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
  loadServerEnvFromProcess.mockReturnValue({ AI_PROVIDER: 'mock' });
});

describe('ai.search', () => {
  it('degrades to keyword-only search when no AI endpoint is configured', async () => {
    lexical.mockResolvedValue([chunk('l1', 'n1', 0.4)]);

    const result = await caller(ctx({ role: 'viewer' })).ai.search({
      projectId: PROJECT_ID,
      query: 'acme',
    });

    expect(result.semantic).toBe(false);
    expect(result.model).toBeNull();
    expect(result.chunks.map((c) => c.id)).toEqual(['l1']);
    expect(vector).not.toHaveBeenCalled();
  });

  it('fuses vector and lexical results when an endpoint is configured', async () => {
    loadServerEnvFromProcess.mockReturnValue({
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://ai.local/v1',
      AI_EMBED_MODEL: 'embed-x',
    });
    const embedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] })));
    vi.stubGlobal('fetch', embedFetch);
    vector.mockResolvedValue([chunk('v1', 'n1', 0.9)]);
    lexical.mockResolvedValue([chunk('v1', 'n1', 0.5), chunk('l1', 'n2', 0.4)]);

    try {
      const result = await caller(ctx()).ai.search({
        projectId: PROJECT_ID,
        boardId: 'b1',
        query: 'acme',
        k: 2,
      });

      expect(result.semantic).toBe(true);
      expect(result.model).toBe('embed-x');
      expect(result.chunks[0]?.id).toBe('v1'); // in both lists → highest fused rank
      expect(vector).toHaveBeenCalledWith([0.1], { projectId: PROJECT_ID, boardId: 'b1' }, 40);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a project outside the caller org', async () => {
    prismaMock.project.findFirst.mockResolvedValue(null);
    await expect(caller(ctx()).ai.search({ projectId: 'other', query: 'x' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});
