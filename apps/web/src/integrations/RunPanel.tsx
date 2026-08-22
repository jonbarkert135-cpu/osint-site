/**
 * The run surface (10_INTEGRATIONS.md §7.2–§7.4).
 *
 * Honest progress only: a phase label plus an elapsed timer and the live log, never a percentage
 * the runner cannot know. Failures render the canonical three-sentence copy from
 * `@nexus/integrations`' error table — the UI owns no error wording of its own.
 */

import { payloadFor, type IntegrationErrorCode } from '@nexus/integrations/errors';
import { Banner, Button, Spinner } from '@nexus/ui';

import type { RunUiState } from './types.ts';

export interface RunLogLine {
  seq: number;
  at: string;
  level: string;
  phase: string;
  message: string;
}

export interface RunPanelProps {
  state: RunUiState;
  integrationName: string;
  runId: string;
  elapsedMs: number;
  log: readonly RunLogLine[];
  errorCode?: IntegrationErrorCode | undefined;
  /** Items the parse stage produced; 0 with `succeeded` is the "empty" state, not an error. */
  itemsFound?: number | undefined;
  onCancel?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onReview?: (() => void) | undefined;
  /** Deep link back into the tool this run came from; absent when the tool has no such page. */
  externalUrl?: string | undefined;
}

const ACTIVE: readonly RunUiState[] = ['queued', 'starting', 'running', 'parsing'];

/** §7.4: the phase label, never a fake percentage. */
export function phaseLabel(state: RunUiState, log: readonly RunLogLine[]): string {
  const last = log.at(-1);
  if (!ACTIVE.includes(state)) return state;
  return last === undefined ? `${state}…` : `${last.phase}…`;
}

export function RunPanel({
  state,
  integrationName,
  runId,
  elapsedMs,
  log,
  errorCode,
  itemsFound,
  onCancel,
  onRetry,
  onReview,
  externalUrl,
}: RunPanelProps) {
  const active = ACTIVE.includes(state);
  const error = errorCode === undefined ? null : payloadFor(errorCode, { runId });

  return (
    <section className="nx-run-panel" aria-label="Run" data-testid="run-panel" data-state={state}>
      <header>
        <strong>{integrationName}</strong>
        <span className="nx-muted" data-testid="run-phase">
          {phaseLabel(state, log)}
        </span>
        <span className="nx-muted" data-testid="run-elapsed">
          {String(Math.floor(elapsedMs / 1000))}s
        </span>
        {active ? <Spinner /> : null}
      </header>

      {state === 'partial' ? (
        <Banner kind="warn" title="Run ended early">
          Some of the work finished before the run stopped. Import what was collected, or run it
          again.
        </Banner>
      ) : null}

      {state === 'cancelled' ? (
        <Banner kind="info" title="Run cancelled">
          You stopped this run, so nothing was imported. Start it again whenever you want.
        </Banner>
      ) : null}

      {error === null ? null : (
        <Banner kind="danger" title={error.what} actions={<Button onClick={onRetry}>Retry</Button>}>
          {error.why} {error.action}
        </Banner>
      )}

      {state === 'succeeded' && itemsFound === 0 ? (
        <Banner kind="info" title="No results found">
          {integrationName} ran successfully but found nothing new to add for these inputs. Try a
          different input, or open the run log to see what it checked.
        </Banner>
      ) : null}

      <ol className="nx-run-log" data-testid="run-log">
        {log.map((line) => (
          <li key={line.seq} data-level={line.level}>
            <span className="nx-muted">{line.phase}</span> {line.message}
          </li>
        ))}
      </ol>

      <footer>
        {active && onCancel !== undefined ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {(state === 'succeeded' || state === 'partial') &&
        onReview !== undefined &&
        itemsFound !== 0 ? (
          <Button onClick={onReview}>Review results</Button>
        ) : null}
        {externalUrl === undefined ? null : (
          <a
            className="nx-link"
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="run-external-link"
          >
            Open in {integrationName}
          </a>
        )}
      </footer>
    </section>
  );
}
