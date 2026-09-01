/**
 * 14_AI_AGENT.md §6.6 — the `ai.embed` consumer: chunk from `searchFields()`, skip unchanged
 * hashes, honest degradation without an endpoint, stale-row cleanup and node-delete cleanup.
 */

import { describe, expect, it } from 'vitest';
import { AIUnavailableError, EMBED_DEBOUNCE_MS, embedJobOptions, type Embedder } from '@nexus/ai';

import {
  processEmbedJob,
  type ChunkRow,
  type EmbedNodeRow,
  type EmbedStore,
} from '../src/queues/ai.embed.ts';

const node = (over: Partial<EmbedNodeRow> = {}): EmbedNodeRow => ({
  id: 'node-1',
  projectId: 'project-1',
  boardId: 'board-1',
  type: 'text',
  title: 'Shell company web',
  data: { plain: 'ACME Ltd wires funds to Meridian Holdings monthly.' },
  deletedAt: null,
  ...over,
});

interface FakeStore extends EmbedStore {
  upserts: ChunkRow[];
  deletedIds: string[];
  deletedNodes: string[];
}

function fakeStore(
  row: EmbedNodeRow | null,
  prior: Map<string, { id: string; hash: string; hasVector: boolean }> = new Map(),
): FakeStore {
  const store: FakeStore = {
    upserts: [],
    deletedIds: [],
    deletedNodes: [],
    loadNode: () => Promise.resolve(row),
    existing: () => Promise.resolve(prior),
    upsertChunk(chunk) {
      store.upserts.push(chunk);
      return Promise.resolve();
    },
    deleteChunks(ids) {
      store.deletedIds.push(...ids);
      return Promise.resolve();
    },
    deleteAllChunks(nodeId) {
      store.deletedNodes.push(nodeId);
      return Promise.resolve();
    },
  };
  return store;
}

function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    modelId: 'test-embed',
    embed(inputs) {
      calls.push([...inputs]);
      return Promise.resolve(inputs.map((_, i) => [i + 1, 0, 0]));
    },
  };
}

describe('processEmbedJob', () => {
  it('chunks searchFields text and stores embedded rows', async () => {
    const store = fakeStore(node());
    const embedder = fakeEmbedder();
    const outcome = await processEmbedJob({ store, embedder }, { nodeId: 'node-1' });

    expect(outcome).toMatchObject({ status: 'embedded', chunks: 2, embedded: 2, degraded: false });
    expect(store.upserts.map((row) => row.kind)).toEqual(['title', 'body']);
    expect(store.upserts[0]).toMatchObject({
      projectId: 'project-1',
      boardId: 'board-1',
      nodeId: 'node-1',
      model: 'test-embed',
      text: 'Shell company web',
      embedding: [1, 0, 0],
    });
    expect(embedder.calls).toHaveLength(1);
  });

  it('skips chunks whose content_hash is unchanged', async () => {
    const first = fakeStore(node());
    const embedder = fakeEmbedder();
    await processEmbedJob({ store: first, embedder }, { nodeId: 'node-1' });

    const prior = new Map(
      first.upserts.map((row) => [
        `${row.kind}:${String(row.ord)}`,
        { id: `chunk-${row.kind}`, hash: row.contentHash, hasVector: true },
      ]),
    );
    const second = fakeStore(node(), prior);
    const outcome = await processEmbedJob({ store: second, embedder }, { nodeId: 'node-1' });

    expect(outcome).toMatchObject({ status: 'unchanged', embedded: 0 });
    expect(second.upserts).toHaveLength(0);
    expect(embedder.calls).toHaveLength(1); // only the first run called the endpoint
  });

  it('re-embeds vectorless rows even when their hash is unchanged', async () => {
    const first = fakeStore(node());
    const embedder = fakeEmbedder();
    await processEmbedJob({ store: first, embedder }, { nodeId: 'node-1' });

    // Same hashes, but the rows were written degraded (endpoint was down): they must retry.
    const prior = new Map(
      first.upserts.map((row) => [
        `${row.kind}:${String(row.ord)}`,
        { id: `chunk-${row.kind}`, hash: row.contentHash, hasVector: false },
      ]),
    );
    const second = fakeStore(node(), prior);
    const outcome = await processEmbedJob({ store: second, embedder }, { nodeId: 'node-1' });

    expect(outcome).toMatchObject({ status: 'embedded', embedded: 2, degraded: false });
    expect(second.upserts.every((row) => row.embedding !== null)).toBe(true);
  });

  it('writes NULL-vector rows when the endpoint is unavailable (keyword-only, U5)', async () => {
    const store = fakeStore(node());
    const embedder: Embedder = {
      modelId: 'none',
      embed: () => Promise.reject(new AIUnavailableError('No embedding endpoint is configured')),
    };
    const outcome = await processEmbedJob({ store, embedder }, { nodeId: 'node-1' });

    expect(outcome.degraded).toBe(true);
    expect(store.upserts).toHaveLength(2);
    expect(store.upserts.every((row) => row.embedding === null)).toBe(true);
  });

  it('propagates non-availability errors instead of swallowing them', async () => {
    const store = fakeStore(node());
    const embedder: Embedder = {
      modelId: 'test-embed',
      embed: () => Promise.reject(new Error('boom')),
    };
    await expect(processEmbedJob({ store, embedder }, { nodeId: 'node-1' })).rejects.toThrow(
      'boom',
    );
  });

  it('deletes all chunks for a missing or soft-deleted node', async () => {
    const gone = fakeStore(null);
    expect(
      await processEmbedJob({ store: gone, embedder: fakeEmbedder() }, { nodeId: 'n' }),
    ).toMatchObject({ status: 'deleted' });
    expect(gone.deletedNodes).toEqual(['n']);

    const soft = fakeStore(node({ deletedAt: new Date() }));
    await processEmbedJob({ store: soft, embedder: fakeEmbedder() }, { nodeId: 'node-1' });
    expect(soft.deletedNodes).toEqual(['node-1']);
  });

  it('removes rows the new chunking no longer produces', async () => {
    const prior = new Map([
      ['title:0', { id: 'keep-maybe', hash: 'old', hasVector: true }],
      ['body:7', { id: 'stale-7', hash: 'x', hasVector: true }],
    ]);
    const store = fakeStore(node(), prior);
    await processEmbedJob({ store, embedder: fakeEmbedder() }, { nodeId: 'node-1' });
    expect(store.deletedIds).toEqual(['stale-7']);
  });

  it('falls back to title-only for a payload the type schema rejects', async () => {
    const store = fakeStore(node({ type: 'text', data: { plain: 42 } }));
    const outcome = await processEmbedJob(
      { store, embedder: fakeEmbedder() },
      { nodeId: 'node-1' },
    );
    expect(outcome.chunks).toBe(1);
    expect(store.upserts.map((row) => row.kind)).toEqual(['title']);
  });
});

describe('embedJobOptions', () => {
  it('debounces per node within a 20 s bucket but frees the id for the next edit', () => {
    const at = (ms: number) => embedJobOptions('node-1', () => ms);
    expect(at(0).jobId).toBe(at(EMBED_DEBOUNCE_MS - 1).jobId);
    expect(at(0).jobId).not.toBe(at(EMBED_DEBOUNCE_MS).jobId);
    expect(at(0).delay).toBe(EMBED_DEBOUNCE_MS);
    expect(embedJobOptions('node-2', () => 0).jobId).not.toBe(at(0).jobId);
  });
});
