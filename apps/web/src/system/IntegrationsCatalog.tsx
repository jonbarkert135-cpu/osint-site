/**
 * Integrations tab (Part 2 §55) with the discovery feed (§56).
 *
 * The catalogue answers "can I use this": every engine this build knows about, in exactly one of
 * five states, with the reason spelled out. Filtering is by state, because that is the only axis a
 * user acts on.
 *
 * The discovery feed underneath is the "a supported alternative was found" notice. It is a prop,
 * not a fetch: the scanner that produces candidates is the host's job, and no candidate source is
 * wired in this build — so with nothing passed in, the section says so instead of showing an empty
 * promise. Review opens the project, Ignore drops it for the session, and Install is inert until
 * the app has a package fetcher, which it does not: an honest disabled button beats a dead one.
 */

import {
  catalogSummary,
  integrationCatalog,
  type CatalogState,
  type DiscoveryFinding,
} from '@nexus/query-engine';
import { createCatalogRegistry } from '@nexus/transforms';
import { useMemo, useState } from 'react';

export interface IntegrationsCatalogProps {
  /** Engines this build has an adapter registered for. */
  readonly installed: ReadonlySet<string>;
  readonly configuredProviders?: ReadonlySet<string>;
  /** Findings from the periodic scan (§56); empty until a candidate source is wired. */
  readonly findings?: readonly DiscoveryFinding[];
}

export function IntegrationsCatalog({
  installed,
  configuredProviders,
  findings = [],
}: IntegrationsCatalogProps) {
  const registry = useMemo(() => createCatalogRegistry(), []);
  const entries = useMemo(
    () =>
      integrationCatalog(registry, {
        installed,
        ...(configuredProviders === undefined ? {} : { configuredProviders }),
      }),
    [registry, installed, configuredProviders],
  );
  const summary = catalogSummary(entries);
  const [filter, setFilter] = useState<CatalogState | 'all'>('all');
  const [ignored, setIgnored] = useState<readonly string[]>([]);
  const shown = entries.filter((entry) => filter === 'all' || entry.state === filter);

  return (
    <section className="nx-stack" data-testid="integrations-catalog">
      <div className="nx-tabs" role="group" aria-label="Catalogue filters">
        {(['all', ...(Object.keys(summary) as CatalogState[])] as const).map((state) => (
          <button
            key={state}
            type="button"
            className="nx-tab"
            aria-pressed={filter === state}
            onClick={() => {
              setFilter(state);
            }}
          >
            {state} {state === 'all' ? entries.length : summary[state]}
          </button>
        ))}
      </div>

      <ul className="nx-engine-grid">
        {shown.map((entry) => (
          <li
            key={entry.engine}
            className="nx-engine-card"
            data-state={entry.state}
            data-testid={`catalog-${entry.engine}`}
          >
            <div className="nx-engine-head">
              <strong>{entry.engine}</strong>
              <span className="nx-engine-version">v{entry.version}</span>
              <span className="nx-activity-kind">{entry.state}</span>
            </div>
            <p className="nx-muted">{entry.detail}</p>
            {entry.needsCredentials ? (
              <p className="nx-muted">Needs {entry.provider} credentials.</p>
            ) : null}
          </li>
        ))}
      </ul>

      <h3>Discovered</h3>
      {findings.filter((finding) => !ignored.includes(finding.candidate.id)).length === 0 ? (
        <p className="nx-muted" data-testid="discovery-empty">
          {findings.length === 0
            ? 'No tool scan has run in this build yet — nothing is being proposed.'
            : 'Everything found has been ignored.'}
        </p>
      ) : (
        <ul className="nx-activity" data-testid="discovery-list">
          {findings
            .filter((finding) => !ignored.includes(finding.candidate.id))
            .map((finding) => (
              <li key={finding.candidate.id} data-kind={finding.kind}>
                <span className="nx-activity-kind">{finding.kind}</span>
                <span>{finding.headline}</span>
                <a href={finding.candidate.url} target="_blank" rel="noreferrer">
                  Review
                </a>
                {finding.actions.includes('install') ? (
                  <button
                    type="button"
                    className="nx-tab"
                    disabled
                    title="Installing from outside the built-in catalogue is not wired up yet."
                  >
                    Install
                  </button>
                ) : null}
                <button
                  type="button"
                  className="nx-tab"
                  data-testid={`discovery-ignore-${finding.candidate.id}`}
                  onClick={() => {
                    setIgnored((current) => [...current, finding.candidate.id]);
                  }}
                >
                  Ignore
                </button>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
