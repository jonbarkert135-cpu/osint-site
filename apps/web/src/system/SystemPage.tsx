/**
 * System Health + Engines (Part 2 §27, §28, §30, §31, §32).
 *
 * Two questions, one page: "is the machinery healthy right now?" and "what is actually installed?".
 * Both are rendered from real sources — health from run records, the registry from the transform
 * catalogue — so this page cannot show a service that does not exist or hide one that does.
 *
 * Every status here is honest about ignorance: an engine that has not run this session reads
 * "Not run yet", never "Online".
 */

import {
  DEFAULT_RESOURCE_BUDGET,
  HEALTH_LABEL,
  healthReport,
  type EngineAction,
  type EngineHealth,
} from '@nexus/query-engine';
import {
  compatibilityMatrix,
  createCatalogRegistry,
  DEPLOYMENT_LABEL,
  resolveRuntime,
  type CompatibilityRow,
  type DeploymentKind,
  type EngineManifest,
  type TransformRegistry,
} from '@nexus/transforms';
import { Button, Menu, MenuItem } from '@nexus/ui';
import { useMemo, useState } from 'react';

import { policyFor, requestAction, useRuntime } from './runtimeStore.ts';

const ACTIONS: readonly { readonly id: EngineAction; readonly label: string }[] = [
  { id: 'retry', label: 'Retry' },
  { id: 'retry-failed', label: 'Retry failed only' },
  { id: 'restart', label: 'Restart' },
  { id: 'disable', label: 'Disable' },
  { id: 'ignore', label: 'Ignore' },
  { id: 'enable', label: 'Enable' },
];

const ago = (at: number | null): string => {
  if (at === null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m ago`;
  return `${String(Math.round(seconds / 3600))}h ago`;
};

const categoryOf = (registry: TransformRegistry, engine: EngineManifest): string => {
  const owner = registry.transforms.find((transform) => transform.engines.includes(engine.id));
  return owner?.category ?? 'unassigned';
};

const kindsOf = (
  registry: TransformRegistry,
  engine: EngineManifest,
  side: 'inputs' | 'outputs',
): string => {
  const kinds = new Set<string>();
  for (const transform of registry.transforms) {
    if (!transform.engines.includes(engine.id)) continue;
    for (const kind of transform[side]) kinds.add(kind);
  }
  return kinds.size === 0 ? '—' : [...kinds].join(', ');
};

/** What the engine needs from the host — the field §33 says we may not assume is available. */
/** Compatibility text comes from the engine's runtime passport, never from a second guess (§34). */
const compatibilityOf = (engine: EngineManifest): string => {
  const spec = resolveRuntime(engine);
  return `${DEPLOYMENT_LABEL[spec.deployment]} · ${spec.runtime}`;
};

const DEPLOYMENT_NOTE: Readonly<Record<DeploymentKind, string>> = {
  native: 'Runs directly on the host.',
  containerized: 'Runs only inside a container, with explicit memory, cpu and pid limits.',
  external:
    'Runs off-box through the remote execution queue; falls back to local when no worker answers.',
  unsupported: 'Not viable on this host. The alternative column says what replaces it.',
};

function CompatibilityTable({
  kind,
  rows,
}: {
  kind: DeploymentKind;
  rows: readonly CompatibilityRow[];
}) {
  return (
    <section className="nx-stack" data-testid={`compat-${kind}`}>
      <h3 className="nx-compat-heading">
        {DEPLOYMENT_LABEL[kind]} <span className="nx-compat-count">{rows.length}</span>
      </h3>
      <p className="nx-system-note">{DEPLOYMENT_NOTE[kind]}</p>
      {rows.length === 0 ? (
        <p className="nx-system-note">None.</p>
      ) : (
        <table className="nx-table">
          <thead>
            <tr>
              <th scope="col">Engine</th>
              <th scope="col">Runtime</th>
              <th scope="col">Docker</th>
              <th scope="col">RAM</th>
              <th scope="col">CPU</th>
              <th scope="col">Persistent</th>
              <th scope="col">Host compatible</th>
              <th scope="col">Alternative</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.engine} data-testid={`compat-row-${row.engine}`}>
                <th scope="row">{row.engine}</th>
                <td>
                  {row.runtime}
                  {row.adapter === 'planned' ? ' (adapter planned)' : ''}
                </td>
                <td>{row.docker ? 'yes' : 'no'}</td>
                <td>{String(row.memoryMb)} MB</td>
                <td>{String(row.cpu)}</td>
                <td>{row.persistent ? 'yes' : 'no'}</td>
                <td>{row.hostCompatible ? 'yes' : 'no'}</td>
                <td>{row.alternative ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HealthRow({
  health,
  onAction,
}: {
  health: EngineHealth;
  onAction: (a: EngineAction) => void;
}) {
  return (
    <tr data-testid={`health-${health.engine}`}>
      <th scope="row" className="nx-health-name">
        <span className={`nx-dot nx-dot-${health.state}`} aria-hidden="true" />
        {health.engine}
      </th>
      <td>{HEALTH_LABEL[health.state]}</td>
      <td>{health.runs === 0 ? '—' : `${String(health.responseMs)} ms`}</td>
      <td>{health.queued === 0 ? '—' : String(health.queued)}</td>
      <td>
        {health.failures === 0 ? '0' : `${String(health.failures)} / ${String(health.runs)}`}
        {health.timeouts > 0 ? ` · ${String(health.timeouts)} timed out` : ''}
      </td>
      <td>{ago(health.lastSuccessAt)}</td>
      <td className="nx-health-actions">
        <Menu
          trigger={
            <Button variant="ghost" size="sm" aria-label={`${health.engine} actions`}>
              ⋯
            </Button>
          }
          align="end"
        >
          {ACTIONS.map((action) => (
            <MenuItem
              key={action.id}
              onSelect={() => {
                onAction(action.id);
              }}
            >
              {action.label}
            </MenuItem>
          ))}
        </Menu>
      </td>
    </tr>
  );
}

export default function SystemPage() {
  const registry = useMemo(() => createCatalogRegistry(), []);
  const runtime = useRuntime();
  const [tab, setTab] = useState<'health' | 'engines' | 'runtime'>('health');

  const engines = useMemo(
    () => [...registry.engines].sort((a, b) => a.id.localeCompare(b.id)),
    [registry],
  );

  const report = useMemo(
    () =>
      healthReport(
        engines.map((engine) => engine.id),
        runtime.runs,
        Object.fromEntries(engines.map((engine) => [engine.id, policyFor(engine.id)])),
      ),
    [engines, runtime],
  );

  const matrix = useMemo(() => compatibilityMatrix(engines), [engines]);

  const last = runtime.retries[0];

  return (
    <section className="nx-stack nx-system" data-testid="system-page">
      <header className="nx-system-head">
        <h2>System</h2>
        <div className="nx-tabs" role="tablist" aria-label="System views">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'health'}
            className="nx-tab"
            onClick={() => {
              setTab('health');
            }}
          >
            Health
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'engines'}
            className="nx-tab"
            onClick={() => {
              setTab('engines');
            }}
          >
            Engines
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'runtime'}
            className="nx-tab"
            onClick={() => {
              setTab('runtime');
            }}
          >
            Runtime
          </button>
        </div>
      </header>

      {last ? (
        <p className="nx-system-note" role="status" data-testid="system-action-note">
          {last.action} queued for {last.engine} — {String(last.runs)} run(s) will re-execute on the
          next investigation.
        </p>
      ) : null}

      {tab === 'runtime' ? (
        <div className="nx-stack nx-compat" data-testid="system-compat">
          <p className="nx-system-note">
            Host profile: self-managed Linux VPS with Docker (RAVEN-SPEC/29 §7). Engines that do not
            fit are not forced in — they get a stated alternative instead.
          </p>
          {(['native', 'containerized', 'external', 'unsupported'] as const).map((kind) => (
            <CompatibilityTable key={kind} kind={kind} rows={matrix[kind]} />
          ))}
        </div>
      ) : tab === 'health' ? (
        <>
          <table className="nx-table" data-testid="system-health">
            <caption className="nx-table-caption">
              Status is derived from this session&apos;s runs, never self-reported by a service.
            </caption>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Status</th>
                <th scope="col">Response</th>
                <th scope="col">Queue</th>
                <th scope="col">Failures</th>
                <th scope="col">Last success</th>
                <th scope="col">
                  <span className="nx-sr-label">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {report.map((health) => (
                <HealthRow
                  key={health.engine}
                  health={health}
                  onAction={(action) => {
                    requestAction(
                      health.engine,
                      action,
                      action === 'retry-failed' ? health.failures : health.runs,
                    );
                  }}
                />
              ))}
            </tbody>
          </table>
          <p className="nx-system-note" data-testid="system-budget">
            Resource manager: {String(DEFAULT_RESOURCE_BUDGET.concurrency)} run slots ·{' '}
            {String(DEFAULT_RESOURCE_BUDGET.memoryMb)} MB RAM ·{' '}
            {String(DEFAULT_RESOURCE_BUDGET.processes)} processes. No single engine may hold more
            than 60% of the slots.
          </p>
        </>
      ) : (
        <ul className="nx-engine-grid" data-testid="system-engines">
          {engines.map((engine) => {
            const health = report.find((row) => row.engine === engine.id);
            const limits = policyFor(engine.id).limits;
            return (
              <li key={engine.id} className="nx-engine-card" data-testid={`engine-${engine.id}`}>
                <div className="nx-engine-head">
                  <span
                    className={`nx-dot nx-dot-${health?.state ?? 'unknown'}`}
                    aria-hidden="true"
                  />
                  <strong>{engine.id}</strong>
                  <span className="nx-engine-version">v{engine.version}</span>
                </div>
                <dl className="nx-engine-facts">
                  <dt>Category</dt>
                  <dd>{categoryOf(registry, engine)}</dd>
                  <dt>Status</dt>
                  <dd>
                    {engine.status} · {HEALTH_LABEL[health?.state ?? 'unknown']}
                  </dd>
                  <dt>Inputs</dt>
                  <dd>{kindsOf(registry, engine, 'inputs')}</dd>
                  <dt>Outputs</dt>
                  <dd>{kindsOf(registry, engine, 'outputs')}</dd>
                  <dt>Permissions</dt>
                  <dd>
                    {engine.permissions.length === 0 ? 'none' : engine.permissions.join(', ')}
                  </dd>
                  <dt>Resources</dt>
                  <dd>
                    {String(limits.memoryLimitMb)} MB · {String(limits.concurrency)} concurrent ·{' '}
                    {String(Math.round(limits.executionTimeoutMs / 1000))}s timeout
                  </dd>
                  <dt>Compatibility</dt>
                  <dd>{compatibilityOf(engine)}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
