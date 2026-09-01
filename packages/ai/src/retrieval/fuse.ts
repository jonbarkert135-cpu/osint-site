/**
 * Rank fusion for hybrid search (14_AI_AGENT.md §6.5): Reciprocal Rank Fusion over the vector and
 * lexical result lists, then recency/pinned/centrality boosts, then per-node dedupe for diversity.
 * All pure — the SQL lives with the API, the math lives here where it can be tested.
 */

export interface ScoredChunk {
  readonly id: string;
  readonly nodeId: string;
  readonly text: string;
  readonly score: number;
}

export interface BoostSignals {
  /** ISO timestamp of the node's observation; 1.0 today → 0 at 180 days, linear. */
  readonly observedAt?: string;
  readonly pinned?: boolean;
  /** Graph centrality normalized to 0..1, capped by the caller. */
  readonly degree?: number;
}

const RRF_K = 60;
const RECENCY_WINDOW_DAYS = 180;

/** Reciprocal Rank Fusion, K = 60. Input lists are already rank-ordered best-first. */
export function rrf(lists: readonly (readonly ScoredChunk[])[], k = RRF_K): ScoredChunk[] {
  const fused = new Map<string, ScoredChunk>();
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      const previous = fused.get(chunk.id);
      const score = (previous?.score ?? 0) + 1 / (k + rank + 1);
      fused.set(chunk.id, { ...(previous ?? chunk), score });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export function applyBoosts(
  chunks: readonly ScoredChunk[],
  signalsFor: (nodeId: string) => BoostSignals | undefined,
  now: Date,
): ScoredChunk[] {
  return chunks
    .map((chunk) => {
      const s = signalsFor(chunk.nodeId);
      if (s === undefined) return chunk;
      const factor =
        1 +
        0.15 * recency(s.observedAt, now) +
        0.1 * (s.pinned === true ? 1 : 0) +
        0.1 * Math.min(Math.max(s.degree ?? 0, 0), 1);
      return { ...chunk, score: chunk.score * factor };
    })
    .sort((a, b) => b.score - a.score);
}

function recency(observedAt: string | undefined, now: Date): number {
  if (observedAt === undefined) return 0;
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return 0;
  const days = (now.getTime() - observed) / 86_400_000;
  if (days <= 0) return 1;
  if (days >= RECENCY_WINDOW_DAYS) return 0;
  return 1 - days / RECENCY_WINDOW_DAYS;
}

/** At most `maxPerNode` chunks per node, order preserved — diversity over depth (§6.5). */
export function dedupeByNode(chunks: readonly ScoredChunk[], maxPerNode = 2): ScoredChunk[] {
  const seen = new Map<string, number>();
  const out: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const count = seen.get(chunk.nodeId) ?? 0;
    if (count >= maxPerNode) continue;
    seen.set(chunk.nodeId, count + 1);
    out.push(chunk);
  }
  return out;
}
