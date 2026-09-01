/**
 * The `ai.embed` job contract (14_AI_AGENT.md §6.6) — spec name `ai:embed`, dotted to match the
 * repo's other queue names. Shared by the producer (sync's projection hook) and the consumer
 * (apps/worker), so the two never drift; pure constants keep this package browser-safe (N2).
 */

export const AI_EMBED_QUEUE = 'ai.embed';
export const EMBED_DEBOUNCE_MS = 20_000;

export interface EmbedJobPayload {
  readonly nodeId: string;
}

/**
 * The jobId carries a 20 s time bucket: BullMQ ignores an add whose jobId already exists — even a
 * *completed* one until it is removed — so a stable per-node id would silently drop later edits.
 * Bucketing dedupes the keystroke burst (§6.6 trigger 1) and still lets the next edit re-embed.
 */
export function embedJobOptions(nodeId: string, now: () => number = Date.now) {
  return {
    jobId: `embed:${nodeId}:${String(Math.floor(now() / EMBED_DEBOUNCE_MS))}`,
    delay: EMBED_DEBOUNCE_MS,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: 5000,
  };
}
