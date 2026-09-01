/**
 * Embeddings through the one configured OpenAI-compatible endpoint (14_AI_AGENT.md §2, §6):
 * `POST /embeddings`, batched at 96 inputs per call (§6.6). No endpoint → `unavailableEmbedder()`,
 * and retrieval degrades to keyword search instead of guessing (U5).
 */

import { AIUnavailableError } from '../provider.ts';

export interface Embedder {
  readonly modelId: string;
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface EmbedderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  /** Injected so tests never touch the network. */
  readonly fetchImpl?: typeof fetch;
}

export const EMBED_BATCH_SIZE = 96;

export function unavailableEmbedder(): Embedder {
  return {
    modelId: 'none',
    embed: () => Promise.reject(new AIUnavailableError('No embedding endpoint is configured')),
  };
}

export function openAICompatibleEmbedder(options: EmbedderOptions): Embedder {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;
  return {
    modelId: options.model,
    async embed(inputs, signal) {
      const vectors: number[][] = [];
      for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
        const batch = inputs.slice(i, i + EMBED_BATCH_SIZE);
        const response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
          },
          body: JSON.stringify({ model: options.model, input: batch }),
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) {
          throw new AIUnavailableError(`Embedding endpoint returned ${String(response.status)}`);
        }
        const parsed = parseEmbeddings((await response.json()) as unknown, batch.length);
        for (const vector of parsed) vectors.push(vector);
      }
      return vectors;
    },
  };
}

function parseEmbeddings(body: unknown, expected: number): number[][] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new AIUnavailableError('Embedding endpoint returned a malformed response');
  }
  const rows = (data as unknown[]).slice() as { index?: unknown; embedding?: unknown }[];
  rows.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  return rows.map((row) => {
    const vec = row.embedding;
    if (!Array.isArray(vec) || vec.length === 0 || vec.some((v) => typeof v !== 'number')) {
      throw new AIUnavailableError('Embedding endpoint returned a malformed vector');
    }
    return vec as number[];
  });
}
