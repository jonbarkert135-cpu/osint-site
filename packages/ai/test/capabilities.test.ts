import { describe, expect, it, vi } from 'vitest';

import {
  availableCapabilities,
  openAICompatibleProvider,
  runCapability,
  unavailableProvider,
  AIUnavailableError,
  type AIGraph,
  type AIRunContext,
} from '../src/index.ts';

const NOW = '2026-08-22T10:00:00.000Z';

function node(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'note',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 0,
    rotation: 0 as const,
    parentId: null,
    locked: false,
    hidden: false,
    title,
    tags: [] as string[],
    confidence: 'unknown' as const,
    color: null,
    starred: false,
    status: 'active' as const,
    provenance: { kind: 'manual' as const, source: null, tool: null },
    enrichment: {},
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    data: {},
    ...extra,
  } as unknown as AIGraph['nodes'][number];
}

function ctx(graph: Partial<AIGraph>, overrides: Partial<AIRunContext> = {}): AIRunContext {
  let counter = 0;
  return {
    boardId: 'board-1',
    runId: 'run-1',
    now: NOW,
    actorUserId: 'user-1',
    graph: { nodes: graph.nodes ?? [], edges: graph.edges ?? [] },
    provider: unavailableProvider(),
    newId: () => `id-${String(++counter)}`,
    ...overrides,
  };
}

describe('deterministic capabilities', () => {
  it('proposes same_as for two nodes with the same url', async () => {
    const result = await runCapability(
      'find-duplicates',
      ctx({
        nodes: [
          node('a', 'Acme Corp', { data: { url: 'https://acme.test/' } }),
          node('b', 'ACME corporation', { data: { url: 'https://acme.test' } }),
        ],
      }),
    );
    expect(result.proposal?.items).toHaveLength(1);
    const item = result.proposal?.items[0];
    expect(item?.kind).toBe('new_edge');
    expect(item?.explain).toContain('https://acme.test');
    expect(result.findings).toHaveLength(1);
  });

  it('skips pairs that are already connected', async () => {
    const result = await runCapability(
      'find-duplicates',
      ctx({
        nodes: [node('a', 'Same Title Here', {}), node('b', 'Same Title Here', {})],
        edges: [
          {
            id: 'e1',
            type: 'same_as',
            source: { nodeId: 'a', port: 'auto', offset: 0.5, anchorKey: null },
            target: { nodeId: 'b', port: 'auto', offset: 0.5, anchorKey: null },
          } as unknown as AIGraph['edges'][number],
        ],
      }),
    );
    expect(result.proposal).toBeUndefined();
    expect(result.explanation).toContain('No duplicate candidates');
  });

  it('suggests unselected related_to links from shared tags', async () => {
    const result = await runCapability(
      'suggest-connections',
      ctx({
        nodes: [node('a', 'A', { tags: ['osint'] }), node('b', 'B', { tags: ['osint'] })],
      }),
    );
    const item = result.proposal?.items[0];
    expect(item?.selectedByDefault).toBe(false);
    expect(item?.explain).toContain('osint');
  });

  it('clusters by tag and never proposes a write', async () => {
    const result = await runCapability(
      'cluster-nodes',
      ctx({
        nodes: [
          node('a', 'A', { tags: ['x'] }),
          node('b', 'B', { tags: ['x'] }),
          node('c', 'C', { tags: ['y'] }),
        ],
      }),
    );
    expect(result.proposal).toBeUndefined();
    expect(result.findings.map((f) => f.id)).toEqual(['cluster:x']);
  });

  it('runs without any endpoint configured', () => {
    expect(availableCapabilities(false).map((c) => c.id)).toEqual([
      'find-duplicates',
      'suggest-connections',
      'cluster-nodes',
    ]);
    expect(availableCapabilities(true)).toHaveLength(9);
  });
});

describe('model capabilities', () => {
  const provider = { modelId: 'llama3.1:8b', complete: () => Promise.resolve('a summary') };

  it('refuses to run when no endpoint is configured', async () => {
    await expect(runCapability('summarize-node', ctx({ nodes: [node('a', 'A')] }))).rejects.toThrow(
      AIUnavailableError,
    );
  });

  it('proposes a note linked back to its source instead of writing', async () => {
    const result = await runCapability(
      'summarize-node',
      ctx({ nodes: [node('a', 'Acme', { data: { text: 'long text' } })] }, { provider }),
    );
    const items = result.proposal?.items ?? [];
    expect(items[0]?.kind).toBe('new_node');
    expect(items[1]?.kind).toBe('new_edge');
    expect(items[1]?.kind === 'new_edge' && items[1].edge.edgeType).toBe('derived_from');
    expect(result.explanation).toContain('Nothing was written');
  });

  it('explains a connection read-only', async () => {
    const result = await runCapability(
      'explain-connection',
      ctx(
        {
          nodes: [node('a', 'A'), node('b', 'B')],
          edges: [
            {
              id: 'e1',
              type: 'mentions',
              source: { nodeId: 'a', port: 'auto', offset: 0.5, anchorKey: null },
              target: { nodeId: 'b', port: 'auto', offset: 0.5, anchorKey: null },
            } as unknown as AIGraph['edges'][number],
          ],
        },
        { provider, edgeId: 'e1' },
      ),
    );
    expect(result.proposal).toBeUndefined();
    expect(result.findings[0]?.detail).toBe('a summary');
  });

  it('summarises the investigation over the selection', async () => {
    const result = await runCapability(
      'investigation-summary',
      ctx({ nodes: [node('a', 'A'), node('b', 'B')] }, { provider, nodeIds: ['a'] }),
    );
    expect(result.proposal?.summary.newNodes).toBe(1);
    expect(result.proposal?.summary.newEdges).toBe(1);
  });

  it('reports a missing edge instead of guessing', async () => {
    await expect(
      runCapability('explain-connection', ctx({ nodes: [] }, { provider, edgeId: 'nope' })),
    ).rejects.toThrow(AIUnavailableError);
  });
});

describe('openAICompatibleProvider', () => {
  it('posts to /chat/completions and returns the first choice', async () => {
    const fetchImpl = vi.fn((_url: unknown, _init: unknown) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'hi' } }] }),
      } as unknown as Response),
    );
    const provider = openAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1/',
      model: 'llama3.1:8b',
      apiKey: 'k',
      fetchImpl: fetchImpl,
    });
    await expect(provider.complete('hello')).resolves.toBe('hi');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('turns a non-ok response and an empty body into AIUnavailableError', async () => {
    const bad = openAICompatibleProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: () => Promise.resolve({ ok: false, status: 502 } as Response),
    });
    await expect(bad.complete('x')).rejects.toThrow(AIUnavailableError);

    const empty = openAICompatibleProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        } as unknown as Response),
    });
    await expect(empty.complete('x')).rejects.toThrow(AIUnavailableError);
  });
});

describe('note, document and repository capabilities', () => {
  const provider = { modelId: 'llama3.1:8b', complete: () => Promise.resolve('a summary') };

  it('drafts a note from the selection and links it back to every source', async () => {
    const result = await runCapability(
      'generate-note',
      ctx({ nodes: [node('a', 'Acme'), node('b', 'Beta')] }, { provider }),
    );
    const items = result.proposal?.items ?? [];
    expect(items.filter((item) => item.kind === 'new_edge')).toHaveLength(2);
    expect(result.findings[0]?.detail).toBe('a summary');
  });

  it('analyses the selected document card only', async () => {
    const result = await runCapability(
      'analyze-document',
      ctx({ nodes: [node('a', 'Report.pdf', { data: { text: 'body' } })] }, { provider }),
    );
    expect(result.capability).toBe('analyze-document');
    expect(result.proposal?.items[0]?.kind).toBe('new_node');
  });

  it('explains a repository card without writing anything', async () => {
    const repo = node('r', 'spiderfoot', {
      data: { url: 'https://github.com/smicallef/spiderfoot', owner: 'smicallef', name: 'sf' },
    });
    const result = await runCapability('explain-repository', ctx({ nodes: [repo] }, { provider }));
    expect(result.proposal).toBeUndefined();
    expect(result.findings[0]?.title).toContain('spiderfoot');
  });

  it('refuses to explain a card that is not a repository', async () => {
    await expect(
      runCapability('explain-repository', ctx({ nodes: [node('a', 'A')] }, { provider })),
    ).rejects.toThrow(AIUnavailableError);
  });
});

describe('capability context (§6.2)', () => {
  const capture = () => {
    const prompts: string[] = [];
    return {
      prompts,
      provider: {
        modelId: 'llama3.1:8b',
        complete: (prompt: string) => {
          prompts.push(prompt);
          return Promise.resolve('a summary');
        },
      },
    };
  };

  it('feeds retrieval chunks and serialized nodes into investigation-summary', async () => {
    const { prompts, provider } = capture();
    const retrieve = vi.fn(() =>
      Promise.resolve([{ id: 'c1', nodeId: 'n9', text: 'CHUNK-FROM-PGVECTOR', score: 1 }]),
    );
    await runCapability(
      'investigation-summary',
      ctx({ nodes: [node('a', 'Acme')] }, { provider, retrieve }),
    );
    expect(retrieve).toHaveBeenCalledWith('Acme');
    expect(prompts[0]).toContain('CHUNK-FROM-PGVECTOR');
    expect(prompts[0]).toContain('<node id="a"');
    expect(prompts[0]).toContain('<board id="board-1"');
  });

  it('includes 1-hop neighbours of the selection', async () => {
    const { prompts, provider } = capture();
    await runCapability(
      'generate-note',
      ctx(
        {
          nodes: [node('a', 'Focus'), node('b', 'Neighbour'), node('c', 'Far')],
          edges: [
            {
              id: 'e1',
              type: 'mentions',
              source: { nodeId: 'a', port: 'auto', offset: 0.5, anchorKey: null },
              target: { nodeId: 'b', port: 'auto', offset: 0.5, anchorKey: null },
            } as unknown as AIGraph['edges'][number],
          ],
        },
        { provider, nodeIds: ['a'] },
      ),
    );
    expect(prompts[0]).toContain('<node id="b"');
    expect(prompts[0]).not.toContain('<node id="c"');
  });

  it('survives a failing retriever with graph-only context (U5)', async () => {
    const { provider } = capture();
    const result = await runCapability(
      'generate-note',
      ctx(
        { nodes: [node('a', 'Acme')] },
        { provider, retrieve: () => Promise.reject(new Error('down')) },
      ),
    );
    expect(result.findings).toHaveLength(1);
  });
});
