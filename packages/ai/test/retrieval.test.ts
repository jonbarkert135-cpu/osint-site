import { describe, expect, it } from 'vitest';

import {
  AI_EMBED_QUEUE,
  AIUnavailableError,
  applyBoosts,
  chunkText,
  contentHash,
  createRetriever,
  dedupeByNode,
  EMBED_DEBOUNCE_MS,
  embedJobOptions,
  estimateTokens,
  openAICompatibleEmbedder,
  rrf,
  unavailableEmbedder,
} from '../src/index.ts';
import type { ChunkSearch, ScoredChunk } from '../src/index.ts';

const chunk = (id: string, nodeId = id, score = 0): ScoredChunk => ({
  id,
  nodeId,
  text: `text ${id}`,
  score,
});

describe('chunkText', () => {
  it('emits one title chunk and nothing for empty body', () => {
    const chunks = chunkText('  A   Title ', '');
    expect(chunks).toEqual([{ kind: 'title', ord: 0, text: 'A Title', tokenCount: 2 }]);
  });

  it('emits nothing at all for empty inputs', () => {
    expect(chunkText('', '   ')).toEqual([]);
  });

  it('keeps a short body as one window', () => {
    const chunks = chunkText('t', 'one paragraph\n\ntwo paragraph');
    expect(chunks.map((c) => c.kind)).toEqual(['title', 'body']);
    expect(chunks[1]?.text).toBe('one paragraph\ntwo paragraph');
  });

  it('splits a long body into overlapping windows', () => {
    const paragraph = 'sentence word '.repeat(100).trim(); // ~350 tokens
    const body = [paragraph, paragraph, paragraph].join('\n\n');
    const chunks = chunkText('', body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.kind).toBe('body');
      expect(c.tokenCount).toBeLessThanOrEqual(512 + 350); // window + one segment tolerance
    }
    // Overlap: consecutive windows share tail text.
    const [first, second] = chunks;
    const tail = (first?.text ?? '').slice(-40);
    expect(second?.text).toContain(tail.split('\n').pop() ?? '');
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it('hard-splits a single oversized sentence', () => {
    const monster = 'x'.repeat(5000); // no spaces, no sentence breaks
    const chunks = chunkText('', monster);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(512 * 2);
  });

  it('marks tool findings with their kind', () => {
    expect(chunkText('', 'a finding', 'finding')[0]?.kind).toBe('finding');
  });
});

describe('contentHash', () => {
  it('is stable under whitespace noise', async () => {
    expect(await contentHash('a  b\n\nc')).toBe(await contentHash(' a b c '));
    expect(await contentHash('a b c')).not.toBe(await contentHash('a b d'));
    expect(await contentHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('embedder', () => {
  it('unavailableEmbedder rejects with AIUnavailableError', async () => {
    await expect(unavailableEmbedder().embed(['q'])).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it('posts to /embeddings and returns vectors in input order', async () => {
    const calls: { url: string; body: { model: string; input: string[] } }[] = [];
    const fetchImpl = ((url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { model: string; input: string[] };
      calls.push({ url, body });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: body.input.map((_, i) => ({ index: i, embedding: [i, i + 1] })).reverse(), // out of order on purpose
          }),
        ),
      );
    }) as unknown as typeof fetch;

    const embedder = openAICompatibleEmbedder({
      baseUrl: 'http://ai.local/v1/',
      model: 'embed-x',
      apiKey: 'k',
      fetchImpl,
    });
    const vectors = await embedder.embed(['a', 'b']);
    expect(vectors).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(calls[0]?.url).toBe('http://ai.local/v1/embeddings');
    expect(calls[0]?.body).toEqual({ model: 'embed-x', input: ['a', 'b'] });
  });

  it('batches at 96 inputs per call', async () => {
    let callCount = 0;
    const fetchImpl = ((_url: string, init: { body: string }) => {
      callCount += 1;
      const { input } = JSON.parse(init.body) as { input: string[] };
      expect(input.length).toBeLessThanOrEqual(96);
      return Promise.resolve(
        new Response(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: [1] })) })),
      );
    }) as unknown as typeof fetch;
    const embedder = openAICompatibleEmbedder({ baseUrl: 'http://x', model: 'm', fetchImpl });
    const vectors = await embedder.embed(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(vectors).toHaveLength(100);
    expect(callCount).toBe(2);
  });

  it('turns HTTP and shape failures into AIUnavailableError', async () => {
    const failing = (() =>
      Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch;
    await expect(
      openAICompatibleEmbedder({ baseUrl: 'http://x', model: 'm', fetchImpl: failing }).embed([
        'q',
      ]),
    ).rejects.toBeInstanceOf(AIUnavailableError);

    const malformed = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] })),
      )) as unknown as typeof fetch;
    await expect(
      openAICompatibleEmbedder({ baseUrl: 'http://x', model: 'm', fetchImpl: malformed }).embed([
        'q',
      ]),
    ).rejects.toBeInstanceOf(AIUnavailableError);
  });
});

describe('fusion', () => {
  it('rrf rewards appearing in both lists', () => {
    const fused = rrf([
      [chunk('a'), chunk('b')],
      [chunk('b'), chunk('c')],
    ]);
    expect(fused[0]?.id).toBe('b'); // in both lists
    expect(fused.map((c) => c.id)).toContain('a');
    expect(fused.map((c) => c.id)).toContain('c');
  });

  it('applyBoosts multiplies by recency, pinned and degree', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const base = [chunk('a', 'n1', 1), chunk('b', 'n2', 1)];
    const boosted = applyBoosts(
      base,
      (nodeId) =>
        nodeId === 'n2'
          ? { observedAt: '2026-09-01T00:00:00Z', pinned: true, degree: 1 }
          : { observedAt: '2020-01-01T00:00:00Z' },
      now,
    );
    expect(boosted[0]?.id).toBe('b');
    expect(boosted[0]?.score).toBeCloseTo(1.35); // 1 + 0.15 + 0.1 + 0.1
    expect(boosted[1]?.score).toBe(1); // stale observation → no recency boost
  });

  it('applyBoosts leaves chunks without signals untouched', () => {
    const [only] = applyBoosts([chunk('a', 'n1', 2)], () => undefined, new Date());
    expect(only?.score).toBe(2);
  });

  it('dedupeByNode keeps at most two chunks per node', () => {
    const deduped = dedupeByNode([
      chunk('a1', 'n1'),
      chunk('a2', 'n1'),
      chunk('a3', 'n1'),
      chunk('b1', 'n2'),
    ]);
    expect(deduped.map((c) => c.id)).toEqual(['a1', 'a2', 'b1']);
  });
});

describe('createRetriever', () => {
  const search = (vec: ScoredChunk[], lex: ScoredChunk[]): ChunkSearch => ({
    vector: () => Promise.resolve(vec),
    lexical: () => Promise.resolve(lex),
  });
  const workingEmbedder = { modelId: 'm', embed: () => Promise.resolve([[0.1, 0.2]]) };

  it('fuses both lists when the embedder works', async () => {
    const retrieve = createRetriever({
      embedder: workingEmbedder,
      search: search([chunk('v', 'n1')], [chunk('l', 'n2'), chunk('v', 'n1')]),
    });
    const result = await retrieve('query', { projectId: 'p1' });
    expect(result.semantic).toBe(true);
    expect(result.chunks[0]?.id).toBe('v');
  });

  it('degrades to keyword-only when no embedder is configured (U5)', async () => {
    const retrieve = createRetriever({
      embedder: unavailableEmbedder(),
      search: search([chunk('v')], [chunk('l')]),
    });
    const result = await retrieve('query', { projectId: 'p1' });
    expect(result.semantic).toBe(false);
    expect(result.chunks.map((c) => c.id)).toEqual(['l']);
  });

  it('rethrows non-availability errors', async () => {
    const broken = {
      modelId: 'm',
      embed: () => Promise.reject(new Error('boom')),
    };
    const retrieve = createRetriever({ embedder: broken, search: search([], []) });
    await expect(retrieve('q', { projectId: 'p' })).rejects.toThrow('boom');
  });

  it('caps the answer at k after dedupe', async () => {
    const many = Array.from({ length: 30 }, (_, i) => chunk(`c${String(i)}`, `n${String(i)}`));
    const retrieve = createRetriever({ embedder: workingEmbedder, search: search(many, []) });
    const result = await retrieve('q', { projectId: 'p' }, 5);
    expect(result.chunks).toHaveLength(5);
  });
});

describe('embedJobOptions', () => {
  it('buckets the jobId by the debounce window so later edits re-embed', () => {
    const idAt = (ms: number) => embedJobOptions('n1', () => ms).jobId;
    expect(idAt(0)).toBe('embed:n1:0');
    expect(idAt(EMBED_DEBOUNCE_MS - 1)).toBe('embed:n1:0');
    expect(idAt(EMBED_DEBOUNCE_MS)).toBe('embed:n1:1');
  });

  it('delays by the debounce window and cleans up after itself', () => {
    const options = embedJobOptions('n1');
    expect(options.jobId.startsWith('embed:n1:')).toBe(true);
    expect(options.delay).toBe(EMBED_DEBOUNCE_MS);
    expect(options.attempts).toBe(1);
    expect(options.removeOnComplete).toBe(true);
    expect(AI_EMBED_QUEUE).toBe('ai.embed');
  });
});
