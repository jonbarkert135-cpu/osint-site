/**
 * One decision, kept in one place: the right-hand panel shows the node inspector, unless the
 * selection is exactly one relationship — then it shows the relationship inspector (P5 §5.11).
 *
 * It is a separate component so the choice is unit-testable without a canvas: the board itself
 * only owns the selection.
 */

import type * as Y from 'yjs';

import { EdgeInspector } from '../../edges/EdgeInspector.tsx';
import { endpointTitles, selectedEdgeOf } from '../../edges/EdgeLayer.tsx';
import type { EdgeCommandContext } from '../../edges/edgeCommands.ts';
import { Inspector } from '../../nodes/inspector/Inspector.tsx';
import type { NodeStore } from '../../nodes/nodeStore.ts';

export interface BoardInspectorProps {
  doc: Y.Doc;
  store: NodeStore;
  selectedIds: readonly string[];
  context: EdgeCommandContext;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onEdgeDeleted?: (() => void) | undefined;
  focusTitleFor?: string | undefined;
}

export function BoardInspector({
  doc,
  store,
  selectedIds,
  context,
  width,
  onWidthChange,
  onClose,
  onEdgeDeleted,
  focusTitleFor,
}: BoardInspectorProps) {
  const edgeId = selectedEdgeOf(doc, selectedIds);
  if (edgeId === null) {
    return (
      <Inspector
        doc={doc}
        store={store}
        selectedIds={selectedIds}
        width={width}
        onWidthChange={onWidthChange}
        onClose={onClose}
        focusTitleFor={focusTitleFor}
      />
    );
  }
  return (
    <EdgeInspector
      doc={doc}
      edgeId={edgeId}
      context={context}
      endpoints={endpointTitles(doc, edgeId)}
      width={width}
      onClose={onClose}
      onDeleted={() => onEdgeDeleted?.()}
    />
  );
}
