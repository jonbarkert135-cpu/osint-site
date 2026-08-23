/**
 * What moved between two runs of the same tool (13_SHERLOCK.md §6.5, 10_INTEGRATIONS.md §7.6).
 *
 * The UI only ever sees proposals, never the raw tool output, so the comparison is made over the
 * proposed nodes of both runs — keyed by identity, which is exactly the key the importer already
 * uses to decide whether two findings are the same thing.
 *
 * The §6.5.3 rule survives the reduction: a result the newer run did not report is listed as
 * "no longer reported", never as removed, and nothing on the board is deleted (N8).
 */

import type { ImportProposal } from '@nexus/integrations';

export interface RunDiffRow {
  readonly key: string;
  readonly label: string;
}

export interface RunDiff {
  readonly previousRunId: string;
  readonly currentRunId: string;
  readonly appeared: RunDiffRow[];
  readonly missing: RunDiffRow[];
  readonly unchanged: number;
}

function nodeRows(proposal: ImportProposal): Map<string, RunDiffRow> {
  const rows = new Map<string, RunDiffRow>();
  for (const item of proposal.items) {
    if (item.kind !== 'new_node') continue;
    const key = item.node.identityKey === '' ? item.node.title : item.node.identityKey;
    rows.set(key, { key, label: item.node.title });
  }
  return rows;
}

export function diffProposals(previous: ImportProposal, current: ImportProposal): RunDiff {
  const before = nodeRows(previous);
  const after = nodeRows(current);
  const appeared = [...after.values()].filter((row) => !before.has(row.key));
  const missing = [...before.values()].filter((row) => !after.has(row.key));
  return {
    previousRunId: previous.runId,
    currentRunId: current.runId,
    appeared,
    missing,
    unchanged: after.size - appeared.length,
  };
}

/** One plain sentence for the sheet header — no counts of nothing. */
export function describeRunDiff(diff: RunDiff): string {
  const parts: string[] = [];
  if (diff.appeared.length > 0) parts.push(`${String(diff.appeared.length)} new`);
  if (diff.missing.length > 0) parts.push(`${String(diff.missing.length)} no longer reported`);
  if (diff.unchanged > 0) parts.push(`${String(diff.unchanged)} unchanged`);
  return parts.length === 0
    ? 'Both runs found nothing.'
    : `${parts.join(', ')} since the previous run.`;
}
