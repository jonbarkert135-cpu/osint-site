/**
 * Saved workflows, local-first (Part 2 §46).
 *
 * A workflow an analyst assembled is theirs, so it lives where their board lives: in the browser,
 * with no account and no server (N2). Stored JSON is read back through `deserializeWorkflow`, which
 * treats it as untrusted input — a corrupted or hand-edited entry is dropped with a warning, never
 * loaded half-parsed.
 */

import { deserializeWorkflow, type Workflow } from '@nexus/query-engine';

const KEY = 'raven.workflows.v1';

export interface SavedWorkflow {
  readonly workflow: Workflow;
  readonly savedAt: string;
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage;
  } catch {
    return null; // a browser with storage disabled still gets a working editor, just no saving
  }
};

export const listWorkflows = (): readonly SavedWorkflow[] => {
  const raw = storage()?.getItem(KEY);
  if (raw === null || raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as { workflow?: unknown; savedAt?: unknown };
    const loaded = deserializeWorkflow(JSON.stringify(record.workflow));
    if (!loaded.ok) return [];
    return [
      {
        workflow: loaded.workflow,
        savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
      },
    ];
  });
};

const write = (entries: readonly SavedWorkflow[]): void => {
  storage()?.setItem(
    KEY,
    JSON.stringify(entries.map((entry) => ({ workflow: entry.workflow, savedAt: entry.savedAt }))),
  );
};

/** Upsert by id: saving an edited workflow replaces it instead of growing a list of near-copies. */
export const saveWorkflow = (workflow: Workflow, now = new Date()): readonly SavedWorkflow[] => {
  const entry: SavedWorkflow = { workflow, savedAt: now.toISOString() };
  const kept = listWorkflows().filter((saved) => saved.workflow.id !== workflow.id);
  const entries = [entry, ...kept];
  write(entries);
  return entries;
};

export const deleteWorkflow = (id: string): readonly SavedWorkflow[] => {
  const entries = listWorkflows().filter((saved) => saved.workflow.id !== id);
  write(entries);
  return entries;
};
