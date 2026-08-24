/**
 * "Ask Raven": one input, one plan (24_UNIFIED_QUERY.md §1, §3, §7).
 *
 * The analyst types a domain, an e-mail, a handle — anything — and sees what Raven *would* run
 * for it: the detected entity type (overridable, because `raven.io` is also a company name), the
 * ordered steps with the engine chain behind each one, and an honest count of what was left out
 * and why. Nothing executes here: the layer proposes, the analyst commits.
 */

import { newId } from '@nexus/domain';
import { applyProposal } from '@nexus/integrations';
import { planQuery } from '@nexus/query-engine';
import {
  createCatalogRegistry,
  type EntityKind,
  type ExecutionMode,
  type HostFetch,
} from '@nexus/transforms';
import { Button } from '@nexus/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';

import { ProposalReview } from '../integrations/ProposalReview.tsx';
import { toImportProposal } from './investigationProposal.ts';
import { useQueryRun } from './useQueryRun.ts';

export interface AskPanelProps {
  open: boolean;
  onClose: () => void;
  /** Absent in surfaces with no board (the panel then plans but cannot land results). */
  doc?: Y.Doc;
  boardId?: string;
  onUndo?: () => void;
  /** Injected by tests and by deployments that route provider traffic through the egress proxy. */
  hostFetch?: HostFetch;
}

const REASON_LABELS: Record<string, string> = {
  'requires-configuration': 'need an API key',
  'paid-only': 'paid only',
  'blocked-by-mode': 'blocked by the current mode',
  'provider-rate-limited': 'rate limited',
  'provider-unavailable': 'provider unavailable',
  'permission-denied': 'permission not granted',
  'provider-deprecated': 'deprecated',
  'engine-unavailable': 'engine unavailable',
  'not-executable': 'link out only',
  'no-engine': 'no engine',
  'already-covered': 'already covered',
  'budget-exhausted': 'over budget',
};

export function AskPanel({ open, onClose, doc, boardId, onUndo, hostFetch }: AskPanelProps) {
  const [raw, setRaw] = useState('');
  const [override, setOverride] = useState<EntityKind | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const runner = useQueryRun(hostFetch === undefined ? {} : { fetch: hostFetch });

  // The panel is opened from the palette, so the caret must land in the field: the alternative is
  // typing into the board's single-key shortcuts. `autoFocus` is banned by jsx-a11y, this is not.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const registry = useMemo(() => createCatalogRegistry(), []);
  // Keyless by default (U3): nothing that needs a stored credential is planned until the analyst
  // connects one, in any deployment mode.
  const mode: ExecutionMode = 'zero-credential';

  const result = useMemo(
    () =>
      planQuery(
        registry,
        raw,
        {
          mode,
          configuredProviders: new Set<string>(),
          grantedPermissions: new Set(['network'] as const),
        },
        override === undefined ? {} : { kind: override },
      ),
    [registry, raw, mode, override],
  );

  const investigation = runner.result;

  // The run is a proposal, not a write (U7/N4): it goes through the same review + apply path as an
  // integration import, so it is previewable, per-item selectable and one undo step.
  const proposal = useMemo(
    () =>
      investigation === null || boardId === undefined
        ? null
        : toImportProposal(investigation, { boardId, runId: newId.board() }),
    [investigation, boardId],
  );

  const apply = useCallback(
    (selectedItemIds: string[]) => {
      if (proposal === null || doc === undefined) return;
      const outcome = applyProposal(doc, proposal, {
        selectedItemIds,
        conflictResolutions: {},
        placement: 'radial',
        newId: () => newId.board(),
        now: new Date().toISOString(),
      });
      setApplied(
        `Added ${String(outcome.createdNodeIds.length)} node(s) and ${String(outcome.createdEdgeIds.length)} edge(s).`,
      );
      runner.reset();
    },
    [proposal, doc, runner],
  );

  if (!open) return null;

  const steps = result.plan?.steps ?? [];
  // `result` *is* the query plan (input + chosen candidate + transform plan); the executor takes it whole.
  const plan = result;

  return (
    <aside className="nx-ask-panel" aria-label="Ask Raven" data-testid="ask-panel">
      <header>
        <strong>Ask Raven</strong>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </header>

      <label className="nx-ask-field">
        <span className="nx-muted">Domain, e-mail, IP, handle, wallet, repo or a question</span>
        <input
          type="text"
          ref={inputRef}
          value={raw}
          placeholder="example.com"
          data-testid="ask-input"
          onChange={(event) => {
            setRaw(event.target.value);
            setOverride(undefined);
          }}
        />
      </label>

      {result.candidates.length > 0 ? (
        <div className="nx-ask-kinds" data-testid="ask-kinds">
          {result.candidates.map((candidate) => (
            <button
              key={candidate.kind}
              type="button"
              aria-pressed={candidate.kind === result.chosen?.kind}
              title={candidate.why}
              onClick={() => setOverride(candidate.kind)}
            >
              {candidate.kind}
            </button>
          ))}
        </div>
      ) : null}

      {result.ambiguous ? (
        <p className="nx-muted" data-testid="ask-ambiguous">
          Two readings are about equally likely — pick the one you meant.
        </p>
      ) : null}

      {raw.trim() === '' ? (
        <p className="nx-muted">Nothing runs until you accept a plan.</p>
      ) : steps.length === 0 ? (
        <p className="nx-muted" data-testid="ask-empty">
          Nothing can run for this input in the current mode.
        </p>
      ) : (
        <ol className="nx-ask-plan" data-testid="ask-plan">
          {steps.map((step) => {
            const manifest = registry.transform(step.transform);
            return (
              <li key={step.transform}>
                <span className="nx-ask-step">{manifest?.name ?? step.transform}</span>
                <span className="nx-muted">
                  {step.chain.join(' → ')} · ≤{String(step.maxResults)} results ·{' '}
                  {String(Math.round(step.estimatedRuntimeMs / 1000))}s
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {steps.length > 0 && runner.phase !== 'done' ? (
        <div className="nx-ask-actions">
          {runner.phase === 'running' ? (
            <Button variant="secondary" onClick={runner.stop} data-testid="ask-stop">
              Stop
            </Button>
          ) : (
            <Button
              data-testid="ask-run"
              onClick={() => {
                setApplied(null);
                void runner.run(plan);
              }}
            >
              Run plan
            </Button>
          )}
          {runner.phase === 'running' ? (
            <span className="nx-muted" data-testid="ask-progress">
              {String(Math.round(runner.progress * 100))}% · {String(runner.found)} found
              {runner.inFlight > 0 ? ` · ${String(runner.inFlight)} running in parallel` : ''}
            </span>
          ) : null}
        </div>
      ) : null}

      {runner.steps.length > 0 ? (
        <ul className="nx-ask-run" data-testid="ask-run-steps">
          {runner.steps.map((step) => (
            <li key={step.transform} data-state={step.state}>
              <span className="nx-ask-step">
                {registry.transform(step.transform)?.name ?? step.transform}
              </span>
              <span
                className="nx-ask-bar"
                role="progressbar"
                aria-label={registry.transform(step.transform)?.name ?? step.transform}
                aria-valuenow={Math.round(step.fraction * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                data-testid={`ask-bar-${step.transform}`}
              >
                <span
                  className="nx-ask-bar-fill"
                  style={{ inlineSize: `${String(Math.round(step.fraction * 100))}%` }}
                />
              </span>
              <span className="nx-muted">
                {step.state} · {step.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {investigation !== null && investigation.entities.length > 0 ? (
        <ul className="nx-ask-results" data-testid="ask-results">
          {investigation.entities
            .filter((entity) => !entity.seed)
            .map((entity) => {
              const refs = entity.sources.flatMap((source) => source.refs ?? []);
              const url = refs.find((ref) => ref.url !== undefined)?.url;
              const raw = refs.find((ref) => ref.raw !== undefined)?.raw;
              return (
                <li key={entity.id}>
                  <span className="nx-ask-step">{entity.label ?? entity.value}</span>
                  <span className="nx-muted">
                    {entity.kind} · {entity.confidence.toFixed(2)} ·{' '}
                    {[...new Set(entity.sources.map((source) => source.provider))].join(', ')}
                  </span>
                  {url === undefined ? null : (
                    <a href={url} target="_blank" rel="noreferrer noopener">
                      Open source
                    </a>
                  )}
                  {raw === undefined ? null : (
                    <details>
                      <summary>View raw result</summary>
                      <pre>{JSON.stringify(raw, null, 2).slice(0, 4000)}</pre>
                    </details>
                  )}
                </li>
              );
            })}
        </ul>
      ) : null}

      {investigation !== null && investigation.duplicates.length > 0 ? (
        <ul className="nx-ask-dupes" data-testid="ask-duplicates">
          {investigation.duplicates.map((hint) => {
            const label = (id: string) =>
              investigation.entities.find((entity) => entity.id === id)?.value ?? id;
            return (
              <li key={`${hint.a}|${hint.b}`}>
                Possible duplicate: <strong>{label(hint.a)}</strong> ·{' '}
                <strong>{label(hint.b)}</strong>{' '}
                <span className="nx-muted">({hint.reason} — merge manually if you agree)</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {runner.error !== null ? (
        <p role="alert" data-testid="ask-error">
          {runner.error}
        </p>
      ) : null}

      {applied !== null ? (
        <p role="status" data-testid="ask-applied">
          {applied}{' '}
          {onUndo === undefined ? null : (
            <Button variant="secondary" onClick={onUndo}>
              Undo
            </Button>
          )}
        </p>
      ) : null}

      {proposal !== null && doc !== undefined ? (
        <ProposalReview
          proposal={proposal}
          integrationName="Ask Raven"
          onApply={apply}
          onDiscard={runner.reset}
        />
      ) : investigation !== null ? (
        <p className="nx-muted" data-testid="ask-no-board">
          The run finished with {String(investigation.entities.length)} entities. Open a board to
          land them on a canvas.
        </p>
      ) : null}

      {result.hidden.length > 0 ? (
        <p className="nx-muted" data-testid="ask-hidden">
          Hidden:{' '}
          {result.hidden
            .map((group) => `${String(group.count)} ${REASON_LABELS[group.reason] ?? group.reason}`)
            .join(', ')}
          .
        </p>
      ) : null}
    </aside>
  );
}
