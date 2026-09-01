/**
 * Chunking for retrieval (14_AI_AGENT.md §6.3): the title is one chunk, body text splits into
 * ~512-token windows with 64-token overlap, breaking on paragraphs first, then sentences, then
 * hard. Tokens are estimated as chars/4 — the same fallback the context budget uses; ranking
 * tolerates the error and the package stays browser-safe (N2, no tokenizer binary).
 */

export type ChunkKind = 'title' | 'body' | 'finding';

export interface RetrievalChunk {
  readonly kind: ChunkKind;
  readonly ord: number;
  readonly text: string;
  readonly tokenCount: number;
}

const WINDOW_TOKENS = 512;
const OVERLAP_TOKENS = 64;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** sha256 of whitespace-normalized text — makes re-embedding idempotent (08_DATA_MODEL.md §4.17). */
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalize(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Paragraphs → sentences → hard slices, so no segment alone exceeds a window. */
function segments(body: string): string[] {
  const out: string[] = [];
  for (const paragraph of body.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (p.length === 0) continue;
    if (estimateTokens(p) <= WINDOW_TOKENS) {
      out.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (estimateTokens(sentence) <= WINDOW_TOKENS) {
        out.push(sentence);
        continue;
      }
      const step = WINDOW_TOKENS * 4;
      for (let i = 0; i < sentence.length; i += step) out.push(sentence.slice(i, i + step));
    }
  }
  return out;
}

/** One `title` chunk plus 512/64 `body` windows. Empty inputs produce no chunks — never a blank row. */
export function chunkText(title: string, body: string, kind: ChunkKind = 'body'): RetrievalChunk[] {
  const chunks: RetrievalChunk[] = [];
  const t = normalize(title);
  if (t.length > 0) chunks.push({ kind: 'title', ord: 0, text: t, tokenCount: estimateTokens(t) });

  const parts = segments(body);
  let ord = 0;
  let window: string[] = [];
  let windowTokens = 0;
  const flush = (): void => {
    if (window.length === 0) return;
    const text = window.join('\n');
    chunks.push({ kind, ord, text, tokenCount: estimateTokens(text) });
    ord += 1;
    // Overlap: the next window starts with the tail segments worth ≥ 64 tokens.
    const tail: string[] = [];
    let tailTokens = 0;
    for (let i = window.length - 1; i >= 0 && tailTokens < OVERLAP_TOKENS; i -= 1) {
      const segment = window[i] as string;
      tail.unshift(segment);
      tailTokens += estimateTokens(segment);
    }
    window = tail.length < window.length ? tail : [];
    windowTokens = window.reduce((sum, s) => sum + estimateTokens(s), 0);
  };

  for (const segment of parts) {
    const tokens = estimateTokens(segment);
    if (windowTokens + tokens > WINDOW_TOKENS && windowTokens > 0) flush();
    window.push(segment);
    windowTokens += tokens;
  }
  if (windowTokens > 0 && (chunks.length === 0 || window.some((s) => !chunkHasTail(chunks, s))))
    flush();

  return chunks;
}

/** True when the segment already appears in the last emitted chunk (pure-overlap leftover). */
function chunkHasTail(chunks: readonly RetrievalChunk[], segment: string): boolean {
  const last = chunks[chunks.length - 1];
  return last !== undefined && last.kind !== 'title' && last.text.includes(segment);
}
