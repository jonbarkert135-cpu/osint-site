/**
 * The hybrid retriever (14_AI_AGENT.md §6.5): embed the query, run vector + lexical search in
 * parallel, RRF-fuse, boost, dedupe. Storage is injected — this package never talks to a database
 * (R1), and the same retriever runs against pgvector on the server or a stub in tests.
 *
 * Degradation is honest (U5): no embedder, or an embedder that fails, means `semantic: false` and
 * keyword results only — the UI states "Semantic search is unavailable; using keyword search."
 */

import { AIUnavailableError } from '../provider.ts';
import type { Embedder } from './embed.ts';
import { applyBoosts, dedupeByNode, rrf } from './fuse.ts';
import type { BoostSignals, ScoredChunk } from './fuse.ts';

export interface RetrievalScope {
  readonly projectId: string;
  readonly boardId?: string;
}

/** The two searches the storage layer must provide. Lists come back rank-ordered best-first. */
export interface ChunkSearch {
  vector(
    embedding: readonly number[],
    scope: RetrievalScope,
    limit: number,
  ): Promise<ScoredChunk[]>;
  lexical(query: string, scope: RetrievalScope, limit: number): Promise<ScoredChunk[]>;
}

export interface RetrieverOptions {
  readonly embedder: Embedder;
  readonly search: ChunkSearch;
  readonly signalsFor?: (nodeId: string) => BoostSignals | undefined;
  readonly now?: () => Date;
}

export interface RetrievalResult {
  readonly chunks: readonly ScoredChunk[];
  /** False when retrieval fell back to keyword-only search. */
  readonly semantic: boolean;
}

const CANDIDATES_PER_LIST = 40;

export type Retriever = (
  query: string,
  scope: RetrievalScope,
  k?: number,
) => Promise<RetrievalResult>;

export function createRetriever(options: RetrieverOptions): Retriever {
  const signalsFor = options.signalsFor ?? (() => undefined);
  return async (query, scope, k = 12) => {
    const [vec, lex] = await Promise.all([
      vectorList(options, query, scope),
      options.search.lexical(query, scope, CANDIDATES_PER_LIST),
    ]);
    const lists = vec === undefined ? [lex] : [vec, lex];
    const fused = applyBoosts(rrf(lists), signalsFor, options.now?.() ?? new Date());
    return { chunks: dedupeByNode(fused).slice(0, k), semantic: vec !== undefined };
  };
}

/** `undefined` = semantic search unavailable; an empty list is still a semantic answer. */
async function vectorList(
  options: RetrieverOptions,
  query: string,
  scope: RetrievalScope,
): Promise<ScoredChunk[] | undefined> {
  let embedding: number[];
  try {
    const vectors = await options.embedder.embed([query]);
    const first = vectors[0];
    if (first === undefined) return undefined;
    embedding = first;
  } catch (error) {
    if (error instanceof AIUnavailableError) return undefined;
    throw error;
  }
  return options.search.vector(embedding, scope, CANDIDATES_PER_LIST);
}
