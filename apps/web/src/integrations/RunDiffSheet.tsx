/**
 * The re-run diff sheet (13_SHERLOCK.md §6.5.5): what changed is shown *before* anything is
 * applied, and the "no longer reported" group carries its warning inline, because the single
 * mistake this screen exists to prevent is reading a failed check as a deleted account.
 */

import { Button } from '@nexus/ui';

import { describeRunDiff, type RunDiff } from './runDiff.ts';

export interface RunDiffSheetProps {
  diff: RunDiff;
  integrationName: string;
  onReviewCurrent: () => void;
  onClose: () => void;
}

export function RunDiffSheet({
  diff,
  integrationName,
  onReviewCurrent,
  onClose,
}: RunDiffSheetProps) {
  return (
    <section aria-label="Run diff" data-testid="run-diff-sheet">
      <h3>
        {integrationName}: run {diff.currentRunId} vs {diff.previousRunId}
      </h3>
      <p data-testid="run-diff-summary">{describeRunDiff(diff)}</p>

      {diff.appeared.length > 0 ? (
        <div data-testid="run-diff-appeared">
          <h4>New ({String(diff.appeared.length)})</h4>
          <ul>
            {diff.appeared.map((row) => (
              <li key={row.key}>{row.label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {diff.missing.length > 0 ? (
        <div data-testid="run-diff-missing">
          <h4>No longer reported ({String(diff.missing.length)})</h4>
          <p data-testid="run-diff-caution">
            A result the newer run did not report is not proof that it is gone — the check may
            simply have failed. Nothing is removed from your board; review it yourself.
          </p>
          <ul>
            {diff.missing.map((row) => (
              <li key={row.key}>{row.label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onReviewCurrent}>Review the newer run</Button>
      </footer>
    </section>
  );
}
