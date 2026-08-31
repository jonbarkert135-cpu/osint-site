/**
 * Where a drift finding goes (§5.1: "each writing a dated record").
 *
 * ponytail: one JSONL file per UTC day on the persistent disk the VPS profile already assumes
 * (`29_RUNTIME_ENVIRONMENT.md` §7). No table, no migration, no query layer — a finding is read by a
 * human or grepped by a script, and neither needs SQL. Move it into `packages/db` when something in
 * the product has to query findings, not before.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DriftFinding } from './checks.ts';

export const DEFAULT_FINDINGS_DIR = process.env.RAVEN_FINDINGS_DIR ?? '/var/lib/raven/findings';

export const findingsFile = (at: Date, dir = DEFAULT_FINDINGS_DIR): string =>
  join(dir, `${at.toISOString().slice(0, 10)}.jsonl`);

/** Appends findings and returns the file they landed in. Drift and `ok` are both recorded: the
 *  absence of a record must mean "the watcher did not run", never "nothing changed". */
export const appendFindings = async (
  findings: readonly DriftFinding[],
  options: { readonly dir?: string; readonly at?: Date } = {},
): Promise<string | undefined> => {
  if (findings.length === 0) return undefined;
  const dir = options.dir ?? DEFAULT_FINDINGS_DIR;
  const file = findingsFile(options.at ?? new Date(), dir);
  await mkdir(dir, { recursive: true });
  await appendFile(file, findings.map((finding) => JSON.stringify(finding)).join('\n') + '\n');
  return file;
};
