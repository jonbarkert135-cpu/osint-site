/**
 * "Ask Raven": one input, one plan (24_UNIFIED_QUERY.md §1, §3, §7).
 *
 * The analyst types a domain, an e-mail, a handle — anything — and sees what Raven *would* run
 * for it: the detected entity type (overridable, because `raven.io` is also a company name), the
 * ordered steps with the engine chain behind each one, and an honest count of what was left out
 * and why. Nothing executes here: the layer proposes, the analyst commits.
 */

import { planQuery } from '@nexus/query-engine';
import { createCatalogRegistry, type EntityKind, type ExecutionMode } from '@nexus/transforms';
import { Button } from '@nexus/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface AskPanelProps {
  open: boolean;
  onClose: () => void;
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

export function AskPanel({ open, onClose }: AskPanelProps) {
  const [raw, setRaw] = useState('');
  const [override, setOverride] = useState<EntityKind | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

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

  if (!open) return null;

  const steps = result.plan?.steps ?? [];

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
