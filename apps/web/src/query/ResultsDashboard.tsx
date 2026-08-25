/**
 * The dashboard a run builds for itself (Part 2 §20–§23).
 *
 * §20 the overview is assembled from the run, not hardcoded; §21 every service gets its own panel
 * but rendered in the one design system, so the analyst reads findings, not tool output; §22 each
 * result card carries the actions that are real here (open, expand, copy, evidence, dismiss) — the
 * ones that need a board live on the node once it is on the canvas; §23 `Build Graph` turns the
 * kept results into nodes, edges and a layout in one reviewable, undoable step.
 */

import type { InvestigationResult, ResolvedEntity } from '@nexus/query-engine';
import { Button } from '@nexus/ui';
import { useMemo, useState } from 'react';

import { buildDashboard, sourceOf } from './dashboard.ts';

export interface ResultsDashboardProps {
  readonly result: InvestigationResult;
  /** Called with the entity ids the analyst kept. Absent when there is no board to build onto. */
  readonly onBuildGraph?: (entityIds: readonly string[]) => void;
}

export function ResultsDashboard({ result, onBuildGraph }: ResultsDashboardProps) {
  const dashboard = useMemo(() => buildDashboard(result), [result]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [evidence, setEvidence] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (
    set: ReadonlySet<string>,
    apply: (next: ReadonlySet<string>) => void,
    id: string,
  ) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    apply(next);
  };

  const kept = result.entities.filter((entity) => !entity.seed && !dismissed.has(entity.id));

  const card = (entity: ResolvedEntity) => {
    const { url, raw } = sourceOf(entity);
    const isOpen = expanded.has(entity.id);
    return (
      <li key={entity.id} className="nx-result-card" data-evidence={evidence.has(entity.id)}>
        <div className="nx-result-head">
          <span className="nx-ask-step">{entity.label ?? entity.value}</span>
          <span className="nx-muted">
            {entity.kind} · {entity.confidence.toFixed(2)}
          </span>
        </div>
        <div className="nx-result-actions">
          {url === undefined ? null : (
            <a href={url} target="_blank" rel="noreferrer noopener">
              Open source
            </a>
          )}
          <button type="button" onClick={() => toggle(expanded, setExpanded, entity.id)}>
            {isOpen ? 'Collapse' : 'Expand'}
          </button>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(entity.value)}>
            Copy
          </button>
          <button
            type="button"
            aria-pressed={evidence.has(entity.id)}
            onClick={() => toggle(evidence, setEvidence, entity.id)}
          >
            Mark as evidence
          </button>
          <button type="button" onClick={() => toggle(dismissed, setDismissed, entity.id)}>
            {dismissed.has(entity.id) ? 'Restore' : 'Dismiss'}
          </button>
        </div>
        {!isOpen ? null : (
          <div className="nx-result-detail">
            <p className="nx-muted">
              {[...new Set(entity.sources.map((source) => source.provider))].join(', ')} ·{' '}
              {String(entity.sources.length)} observation(s)
            </p>
            {raw === undefined ? (
              <p className="nx-muted">No raw payload was kept for this finding.</p>
            ) : (
              <details>
                <summary>View raw result</summary>
                <pre>{JSON.stringify(raw, null, 2).slice(0, 4000)}</pre>
              </details>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section
      className="nx-dashboard"
      aria-label="Intelligence overview"
      data-testid="ask-dashboard"
    >
      <header className="nx-dashboard-head">
        <strong>Intelligence Overview</strong>
        {onBuildGraph === undefined ? null : (
          <Button
            data-testid="ask-build-graph"
            onClick={() => onBuildGraph(kept.map((entity) => entity.id))}
          >
            Build Graph
          </Button>
        )}
      </header>

      <ul className="nx-dashboard-counters" data-testid="ask-counters">
        {dashboard.counters.map((counter) => (
          <li key={counter.label}>
            <span className="nx-dashboard-value">{counter.value}</span>
            <span className="nx-muted">{counter.label}</span>
          </li>
        ))}
      </ul>

      {dashboard.services.map((panel) => (
        <section key={panel.provider} className="nx-service-panel" data-state={panel.state}>
          <header>
            <strong>{panel.provider}</strong>
            <span className="nx-muted">
              {panel.state === 'complete'
                ? `${String(panel.entities.length)} result(s)`
                : panel.state === 'failed'
                  ? 'failed'
                  : 'no results'}
            </span>
          </header>
          {panel.entities.length === 0 ? null : (
            <ul className="nx-result-cards">{panel.entities.map(card)}</ul>
          )}
        </section>
      ))}

      {dashboard.recommendations.length === 0 ? null : (
        <section className="nx-dashboard-block" data-testid="ask-recommendations">
          <strong>Recommendations</strong>
          <ul>
            {dashboard.recommendations.map((line) => (
              <li key={line} className="nx-muted">
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dashboard.timeline.length === 0 ? null : (
        <details className="nx-dashboard-block" data-testid="ask-timeline">
          <summary>Timeline ({String(dashboard.timeline.length)})</summary>
          <ol>
            {dashboard.timeline.map((item, index) => (
              <li key={`${item.at}-${String(index)}`} className="nx-muted">
                {item.at} · {item.provider} · {item.label}
              </li>
            ))}
          </ol>
        </details>
      )}

      {dashboard.evidence.length === 0 ? null : (
        <details className="nx-dashboard-block" data-testid="ask-evidence">
          <summary>Evidence ({String(dashboard.evidence.length)})</summary>
          <ul>
            {dashboard.evidence.map((item, index) => (
              <li key={`${item.entityId}-${String(index)}`} className="nx-muted">
                {item.entity} · {item.provider} · {item.ref.observedAt}
                {item.ref.url === undefined ? null : (
                  <>
                    {' '}
                    <a href={item.ref.url} target="_blank" rel="noreferrer noopener">
                      source
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
