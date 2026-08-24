/**
 * The DOM card (06_NODE_SYSTEM.md §3.2, 04_DESIGN_SYSTEM.md card anatomy). One shell for every
 * type: accent edge, header with the type icon and title, the type body, tag chips and the hover
 * action rail. The shell is presentational; actions are callbacks the board layer supplies.
 */

import { builtinNodeTypes, type BoardNode } from '@nexus/domain';
import { memo } from 'react';

import { cardErrorMessage, cardStateOf, type CardContext } from './cardState.ts';
import { NodeIcon } from './icons.tsx';
import { bodyFor } from './renderers/bodies.tsx';

export interface NodeCardActions {
  onOpenInspector?: ((id: string) => void) | undefined;
  /** Enter in-place editing (double-click, or Enter on the selection) — text types only. */
  onBeginEdit?: ((id: string) => void) | undefined;
  onDuplicate?: ((id: string) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
  onRetry?: ((id: string) => void) | undefined;
  /**
   * Runs a tool against this node (10_INTEGRATIONS.md §7.1, first entry point). Supplied only when
   * the `integrations` capability is on — in local mode the affordance does not exist at all (N2).
   */
  onRunIntegration?: ((id: string) => void) | undefined;
}

export interface NodeCardProps extends NodeCardActions {
  node: BoardNode;
  /** L3 (zoom ≥ 1.6) shows descriptions, full badges and inline editing affordances. */
  detailed?: boolean;
  /**
   * Hover comes from the engine's hit test, never from CSS `:hover`: the card is transparent to
   * the pointer so the canvas keeps owning gestures, and a transparent element is never hovered.
   */
  hovered?: boolean;
  context?: CardContext;
  /** Filtered out by the active `#` tag filter: still drawn, visibly de-emphasised (03_UX.md §9.2). */
  dimmed?: boolean;
  now?: number;
  /**
   * The live editor, supplied by the binding layer while this card is being edited. The card stays
   * presentational: it decides *where* the editor sits, never *what* it edits (§7).
   */
  editorSlot?: React.ReactNode;
}

/** Tag chips appear from zoom ≥ 0.8, i.e. whenever the card is a DOM card at all (P4 §5.7). */
const MAX_VISIBLE_TAGS = 4;

function NodeCardImpl({
  node,
  detailed = false,
  hovered = false,
  context,
  dimmed = false,
  now,
  editorSlot,
  onOpenInspector,
  onBeginEdit,
  onDuplicate,
  onDelete,
  onRetry,
  onRunIntegration,
}: NodeCardProps) {
  const def = builtinNodeTypes().get(node.type);
  const Body = bodyFor(def.componentId);
  const state = cardStateOf(node, { ...context, ...(now === undefined ? {} : { now }) });
  const error = state === 'error' ? cardErrorMessage(node) : null;
  const editing = editorSlot !== undefined && editorSlot !== null;
  const canEdit = def.capabilities.editableText && !node.locked && onBeginEdit !== undefined;
  const visibleTags = node.tags.slice(0, MAX_VISIBLE_TAGS);
  const overflow = node.tags.length - visibleTags.length;

  return (
    <article
      className="nx-node-card"
      data-testid={`node-card-${node.id}`}
      data-node-type={node.type}
      data-state={editing ? 'editing' : state}
      data-hover={hovered ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      data-locked={node.locked ? 'true' : undefined}
      style={{ borderInlineStartColor: `var(${def.glyph.colorToken})` }}
      aria-label={`${def.label}: ${node.title === '' ? 'Untitled' : node.title}`}
      onDoubleClick={canEdit && !editing ? () => onBeginEdit(node.id) : undefined}
    >
      <header className="nx-card-head">
        <span className="nx-card-type" style={{ color: `var(${def.glyph.colorToken})` }}>
          <NodeIcon icon={def.glyph.icon} />
        </span>
        <h2 className="nx-card-title" data-clamp="2">
          {node.title === '' ? `Untitled ${def.label.toLowerCase()}` : node.title}
        </h2>
        {node.locked ? (
          <span className="nx-chip" data-kind="locked">
            Locked
          </span>
        ) : null}
        {state === 'stale' ? (
          <span
            className="nx-chip"
            data-kind="stale"
            title="Data captured a while ago. Refresh it."
          >
            Stale
          </span>
        ) : null}
      </header>

      {editing ? (
        <div className="nx-card-editor" data-testid={`card-editor-${node.id}`}>
          {editorSlot}
        </div>
      ) : state === 'loading' ? (
        <div className="nx-card-skeleton" data-testid="card-skeleton" aria-label="Loading" />
      ) : (
        <Body node={node} detailed={detailed} {...(now === undefined ? {} : { now })} />
      )}

      {error !== null ? (
        <p className="nx-card-error" role="status">
          {error}
          {onRetry === undefined ? null : (
            <button type="button" className="nx-link-button" onClick={() => onRetry(node.id)}>
              Retry
            </button>
          )}
        </p>
      ) : null}

      {visibleTags.length > 0 ? (
        <div className="nx-chip-row" data-testid="card-tags">
          {visibleTags.map((tag) => (
            <span key={tag} className="nx-chip">
              {tag}
            </span>
          ))}
          {overflow > 0 ? <span className="nx-chip">+{String(overflow)}</span> : null}
        </div>
      ) : null}

      {/* The rail is absolutely positioned so revealing it never shifts the card layout (§6). */}
      <div className="nx-card-rail" data-testid="card-rail">
        {onOpenInspector === undefined ? null : (
          <button type="button" onClick={() => onOpenInspector(node.id)} aria-label="Open details">
            Details
          </button>
        )}
        {!canEdit || editing ? null : (
          <button type="button" onClick={() => onBeginEdit(node.id)} aria-label="Edit text">
            Edit
          </button>
        )}
        {onDuplicate === undefined || !def.capabilities.duplicatable ? null : (
          <button type="button" onClick={() => onDuplicate(node.id)} aria-label="Duplicate node">
            Duplicate
          </button>
        )}
        {onRunIntegration === undefined ? null : (
          <button
            type="button"
            onClick={() => onRunIntegration(node.id)}
            aria-label="Run integration…"
          >
            Run integration…
          </button>
        )}
        {onDelete === undefined ? null : (
          <button type="button" onClick={() => onDelete(node.id)} aria-label="Delete node">
            Delete
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Memoised on the node object: the store hands out a new object only when that node was written,
 * so a 200-node board re-renders exactly one card per edit (P4 §10, asserted in the tests).
 */
export const NodeCard = memo(NodeCardImpl);
