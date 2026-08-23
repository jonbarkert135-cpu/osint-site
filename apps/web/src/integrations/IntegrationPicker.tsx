/**
 * "Run integration…" — the picker (10_INTEGRATIONS.md §7.1).
 *
 * Never hides the affordance: a selection no tool accepts still shows a disabled row saying which
 * kind was refused, and a deployment with nothing installed says so instead of rendering nothing.
 */

import { Button } from '@nexus/ui';

import type { IntegrationSummary } from './types.ts';

export interface IntegrationPickerProps {
  integrations: readonly IntegrationSummary[];
  /** Entity kinds of the current selection; empty means "nothing selected". */
  selectionKinds: readonly string[];
  onPick: (integration: IntegrationSummary) => void;
  onSeeAll?: (() => void) | undefined;
}

/**
 * The board speaks node types (`website`, `link`, `person`…), manifests speak entity kinds
 * (`domain`, `url`, `email`…). Without this table every manifest that sources a field from the
 * selection is unreachable, because no node type is ever spelled like an entity kind.
 */
const ENTITY_KINDS_OF_NODE_TYPE: Readonly<Record<string, readonly string[]>> = {
  website: ['domain', 'url'],
  link: ['url'],
  repo: ['repo'],
  person: ['person', 'username', 'email'],
  note: ['note'],
  text: ['note'],
  file: ['file'],
  image: ['file'],
  unknown: ['unknown', 'ip', 'domain'],
};

export function accepts(
  integration: IntegrationSummary,
  selectionKinds: readonly string[],
): boolean {
  if (integration.acceptsKinds.length === 0) return true;
  return selectionKinds.some(
    (kind) =>
      integration.acceptsKinds.includes(kind) ||
      (ENTITY_KINDS_OF_NODE_TYPE[kind] ?? []).some((mapped) =>
        integration.acceptsKinds.includes(mapped),
      ),
  );
}

export function IntegrationPicker({
  integrations,
  selectionKinds,
  onPick,
  onSeeAll,
}: IntegrationPickerProps) {
  const usable = integrations.filter((integration) => accepts(integration, selectionKinds));

  return (
    <div className="nx-integration-picker" data-testid="integration-picker">
      <p className="nx-menu-heading">Run integration</p>

      {integrations.length === 0 ? (
        <p className="nx-muted" data-testid="picker-empty">
          No tools are installed on this server. Ask an admin to install one — the built-in URL
          expander is always available once integrations are enabled.
        </p>
      ) : null}

      {integrations.length > 0 && usable.length === 0 ? (
        <button type="button" className="nx-menu-item" disabled data-testid="picker-none-accepts">
          No tool accepts a {selectionKinds[0] ?? 'empty'} selection — see all tools
        </button>
      ) : null}

      {usable.map((integration) => (
        <button
          key={integration.id}
          type="button"
          className="nx-menu-item"
          onClick={() => onPick(integration)}
        >
          <span>{integration.name}</span>
          <span className="nx-muted"> — {integration.description}</span>
        </button>
      ))}

      {onSeeAll === undefined ? null : (
        <Button variant="secondary" onClick={onSeeAll}>
          See all tools
        </Button>
      )}
    </div>
  );
}
