/**
 * The board's layer list (canvas spec §4).
 *
 * "Hide" was a one-way door: a hidden node vanished from the canvas and from every list, so the
 * only way back was undo. These helpers give the panel the full stack — hidden rows first, because
 * that is the row a user comes looking for — and one write per toggle.
 */

import { listNodes, updateNode } from '@nexus/domain';
import type * as Y from 'yjs';

export interface LayerRow {
  id: string;
  title: string;
  type: string;
  hidden: boolean;
  locked: boolean;
}

export interface LayerContext {
  doc: Y.Doc;
  history: { label(text: string): void; separate(): void };
  now: () => string;
}

/** Hidden nodes first, then the rest — both in board order. */
export function boardLayers(doc: Y.Doc): LayerRow[] {
  const rows = listNodes(doc).map((node) => ({
    id: node.id,
    title: node.title === '' ? 'Untitled' : node.title,
    type: node.type,
    hidden: node.hidden,
    locked: node.locked,
  }));
  return [...rows.filter((row) => row.hidden), ...rows.filter((row) => !row.hidden)];
}

export function setLayerHidden(context: LayerContext, row: LayerRow, hidden: boolean): string {
  context.history.label(hidden ? 'hide node' : 'show node');
  updateNode(context.doc, row.id, { hidden }, { origin: 'local:edit', now: context.now() });
  context.history.separate();
  return hidden ? `Hid ${row.title}` : `${row.title} is visible again`;
}

export function setLayerLocked(context: LayerContext, row: LayerRow, locked: boolean): string {
  context.history.label(locked ? 'lock node' : 'unlock node');
  updateNode(context.doc, row.id, { locked }, { origin: 'local:edit', now: context.now() });
  context.history.separate();
  return locked ? `Locked ${row.title}` : `Unlocked ${row.title}`;
}
