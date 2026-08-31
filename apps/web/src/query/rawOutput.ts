/**
 * The raw output of a run, kept so §10's "Download raw output" has something to download.
 *
 * ponytail: a bounded in-memory map, not IndexedDB. Raw output is only ever read back whole, by a
 * human, during the session that produced it — persisting it would mean a store, a migration and a
 * retention rule for data an analyst can already download. N2 keeps it on the client either way.
 */

import type { RawChunk } from '@nexus/transforms';

/** Enough to explain the run in front of the analyst; older runs fall off rather than grow forever. */
const MAX_RUNS = 20;

const runs = new Map<string, RawChunk[]>();

export const keepRawOutput = (runId: string, chunks: readonly RawChunk[]): void => {
  const kept = runs.get(runId) ?? [];
  kept.push(...chunks);
  runs.set(runId, kept);
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
};

export const rawOutputOf = (runId: string): readonly RawChunk[] => runs.get(runId) ?? [];

export const hasRawOutput = (runId: string): boolean => (runs.get(runId)?.length ?? 0) > 0;

/** JSONL: one chunk per line, verbatim — the same shape the engine produced. */
export const rawOutputText = (runIds: readonly string[]): string =>
  runIds
    .flatMap((runId) => rawOutputOf(runId).map((chunk) => JSON.stringify({ runId, ...chunk })))
    .join('\n');

export const clearRawOutput = (): void => {
  runs.clear();
};

/** Saves the raw output of the given runs as one JSONL file. No-op when nothing was kept. */
export const downloadRawOutput = (
  runIds: readonly string[],
  name = 'raven-raw-output.jsonl',
): boolean => {
  const text = rawOutputText(runIds);
  if (text === '') return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return true;
};
