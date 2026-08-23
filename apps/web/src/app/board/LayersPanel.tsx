/**
 * The layers panel (canvas spec §4): every node on the board, hidden ones on top.
 *
 * It exists for one reason — a hidden node had no way back. Each row can be selected, shown or
 * hidden again, and locked, so the panel doubles as the board's object list.
 */

import { Button } from '@nexus/ui';
import type * as Y from 'yjs';

import { boardLayers, setLayerHidden, setLayerLocked, type LayerContext } from './layerCommands.ts';

export interface LayersPanelProps {
  open: boolean;
  doc: Y.Doc;
  context: LayerContext;
  onClose: () => void;
  onSelect: (ids: readonly string[]) => void;
  onNotice: (message: string) => void;
}

export function LayersPanel({ open, doc, context, onClose, onSelect, onNotice }: LayersPanelProps) {
  if (!open) return null;
  const rows = boardLayers(doc);
  const hiddenCount = rows.filter((row) => row.hidden).length;

  return (
    <aside className="nx-layers-panel" aria-label="Layers" data-testid="layers-panel">
      <header>
        <strong>Layers</strong>
        <span className="nx-muted" data-testid="layers-hidden-count">
          {String(hiddenCount)} hidden
        </span>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </header>

      {rows.length === 0 ? (
        <p className="nx-muted" data-testid="layers-empty">
          The board is empty. Add a card and it will appear here.
        </p>
      ) : (
        <ul className="nx-layers-list">
          {rows.map((row) => (
            <li key={row.id} data-testid={`layer-row-${row.id}`} data-hidden={row.hidden}>
              <span className="nx-layers-title">{row.title}</span>
              <span className="nx-muted">{row.type}</span>
              <Button variant="secondary" onClick={() => onSelect([row.id])}>
                Select
              </Button>
              <Button
                variant="secondary"
                aria-pressed={row.hidden}
                onClick={() => onNotice(setLayerHidden(context, row, !row.hidden))}
              >
                {row.hidden ? 'Show' : 'Hide'}
              </Button>
              <Button
                variant="secondary"
                aria-pressed={row.locked}
                onClick={() => onNotice(setLayerLocked(context, row, !row.locked))}
              >
                {row.locked ? 'Unlock' : 'Lock'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
