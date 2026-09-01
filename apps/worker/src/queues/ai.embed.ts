/**
 * The `ai.embed` queue (14_AI_AGENT.md §6.6) — spec name `ai:embed`, dotted here to match the
 * repo's other queue names. One job per node: re-read the node from the projection, chunk its
 * `searchFields()` text (§6.3), embed only the chunks whose `content_hash` changed, and write the
 * rows the retriever reads (§6.4). No embedding endpoint → the rows are still written with a NULL
 * vector, so keyword search works and semantic search picks them up on the next full re-embed (U5).
 */

import {
  AIUnavailableError,
  chunkText,
  contentHash,
  type EmbedJobPayload,
  type Embedder,
} from '@nexus/ai';
import { builtinNodeTypes } from '@nexus/domain';

export { AI_EMBED_QUEUE, embedJobOptions, type EmbedJobPayload } from '@nexus/ai';

/** What the worker needs from the projection row; `projectId` comes via the board. */
export interface EmbedNodeRow {
  readonly id: string;
  readonly projectId: string;
  readonly boardId: string;
  readonly type: string;
  readonly title: string;
  readonly data: Record<string, unknown>;
  readonly deletedAt: Date | null;
}

export interface ChunkRow {
  readonly projectId: string;
  readonly boardId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly ord: number;
  readonly text: string;
  readonly tokenCount: number;
  readonly contentHash: string;
  readonly model: string;
  readonly embedding: readonly number[] | null;
}

export interface EmbedStore {
  loadNode(nodeId: string): Promise<EmbedNodeRow | null>;
  /** Existing rows for this node+model, keyed `kind:ord` → { id, contentHash }. */
  existing(nodeId: string, model: string): Promise<Map<string, { id: string; hash: string }>>;
  upsertChunk(row: ChunkRow): Promise<void>;
  deleteChunks(ids: readonly string[]): Promise<void>;
  deleteAllChunks(nodeId: string): Promise<void>;
}

export interface EmbedJobDeps {
  readonly store: EmbedStore;
  readonly embedder: Embedder;
}

export interface EmbedOutcome {
  readonly status: 'embedded' | 'unchanged' | 'deleted';
  readonly chunks: number;
  readonly embedded: number;
  /** True when the endpoint was unavailable and rows were written without vectors (§6.5). */
  readonly degraded: boolean;
}

/**
 * The node's indexable text comes from its type's `searchFields()` — the same projection local
 * search uses, so retrieval never invents its own reading of `data` (§6.3). Unknown types fall
 * back to the `unknown` definition inside the registry.
 */
function indexableText(node: EmbedNodeRow): { title: string; body: string } {
  const def = builtinNodeTypes().get(node.type);
  try {
    const data = def.schema.parse(node.data);
    const fields = def.searchFields({ ...node, data } as never);
    return { title: fields.title, body: fields.body };
  } catch {
    // A payload the schema rejects still has a human-written title worth finding.
    return { title: node.title, body: '' };
  }
}

export async function processEmbedJob(
  deps: EmbedJobDeps,
  payload: EmbedJobPayload,
): Promise<EmbedOutcome> {
  const node = await deps.store.loadNode(payload.nodeId);
  if (node === null || node.deletedAt !== null) {
    // Node gone or soft-deleted: its chunks must not keep answering searches (§6.6 deletion).
    await deps.store.deleteAllChunks(payload.nodeId);
    return { status: 'deleted', chunks: 0, embedded: 0, degraded: false };
  }

  const { title, body } = indexableText(node);
  const chunks = chunkText(title, body);
  const model = deps.embedder.modelId;
  const prior = await deps.store.existing(node.id, model);

  const keyed = await Promise.all(
    chunks.map(async (chunk) => ({
      chunk,
      key: `${chunk.kind}:${String(chunk.ord)}`,
      hash: await contentHash(chunk.text),
    })),
  );
  const changed = keyed.filter(({ key, hash }) => prior.get(key)?.hash !== hash);

  // One provider call for the whole node; the embedder batches at 96 internally (§6.6).
  let vectors: number[][] | null = null;
  if (changed.length > 0) {
    try {
      vectors = await deps.embedder.embed(changed.map(({ chunk }) => chunk.text));
    } catch (error) {
      if (!(error instanceof AIUnavailableError)) throw error;
      vectors = null;
    }
  }

  for (const [i, { chunk, hash }] of changed.entries()) {
    await deps.store.upsertChunk({
      projectId: node.projectId,
      boardId: node.boardId,
      nodeId: node.id,
      kind: chunk.kind,
      ord: chunk.ord,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      contentHash: hash,
      model,
      embedding: vectors?.[i] ?? null,
    });
  }

  // Rows the new chunking no longer produces (shorter text, kind gone) are stale — drop them.
  const keep = new Set(keyed.map(({ key }) => key));
  const stale = [...prior.entries()].filter(([key]) => !keep.has(key)).map(([, row]) => row.id);
  if (stale.length > 0) await deps.store.deleteChunks(stale);

  return {
    status: changed.length === 0 && stale.length === 0 ? 'unchanged' : 'embedded',
    chunks: chunks.length,
    embedded: changed.length,
    degraded: changed.length > 0 && vectors === null,
  };
}
