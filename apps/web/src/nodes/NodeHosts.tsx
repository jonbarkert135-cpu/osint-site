/**
 * React ⇄ overlay bridge (P4 §7). The engine decides *which* nodes deserve a DOM host and owns the
 * slot elements; React renders a card into each slot through a portal. Neither side learns about
 * the other's model: the engine emits ids, React reads those nodes from the store.
 */

import { builtinNodeTypes } from '@nexus/domain';
import type { Engine } from '@nexus/canvas-engine';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';

import { NodeCard, type NodeCardActions } from './NodeCard.tsx';
import type { NodeStore } from './nodeStore.ts';
import { LazyRichTextEditor } from './richtext/LazyRichTextEditor.tsx';

/** Above this zoom a card shows descriptions and full badges (05_CANVAS_ENGINE.md §5, L3). */
export const DETAIL_ZOOM = 1.6;

export interface NodeHostsProps extends NodeCardActions {
  engine: Engine | null;
  store: NodeStore;
  /** Needed only to bind the in-place editor; cards themselves never see the document. */
  doc: Y.Doc;
  /** Slot lookup, supplied by the canvas hook that owns the overlay. */
  slotOf: (id: string) => HTMLElement | undefined;
  selectedIds?: readonly string[];
  /**
   * Palette `#` mode (03_UX.md §9.2): when set, cards that do not carry this tag are dimmed rather
   * than hidden — the analyst keeps the shape of the board while the matches stand out.
   */
  tagFilter?: string | null;
}

function HostedCard({
  id,
  doc,
  store,
  slot,
  detailed,
  hovered,
  selected,
  multiSelected,
  dimmed,
  editing,
  onEndEdit,
  actions,
}: {
  id: string;
  doc: Y.Doc;
  store: NodeStore;
  slot: HTMLElement;
  detailed: boolean;
  hovered: boolean;
  selected: boolean;
  multiSelected: boolean;
  dimmed: boolean;
  editing: boolean;
  onEndEdit: () => void;
  actions: NodeCardActions;
}) {
  const node = useSyncExternalStore(
    (listener) => store.subscribe(id, listener),
    () => store.getSnapshot(id),
    () => store.getSnapshot(id),
  );
  if (node === undefined) return null;
  return createPortal(
    <NodeCard
      node={node}
      detailed={detailed}
      hovered={hovered}
      context={{ selected, multiSelected }}
      dimmed={dimmed}
      {...(editing
        ? {
            editorSlot: (
              <LazyRichTextEditor
                doc={doc}
                node={node}
                focusOnMount
                toolbar={false}
                onExit={onEndEdit}
              />
            ),
          }
        : {})}
      {...actions}
    />,
    slot,
  );
}

export function NodeHosts({
  engine,
  doc,
  store,
  slotOf,
  selectedIds = [],
  tagFilter = null,
  ...actions
}: NodeHostsProps) {
  const [ids, setIds] = useState<readonly string[]>([]);
  const [zoom, setZoom] = useState(engine?.camera.state.zoom ?? 1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const beginEdit = useCallback(
    (id: string) => {
      const node = store.getSnapshot(id);
      if (node === undefined || node.locked) return;
      if (!builtinNodeTypes().get(node.type).capabilities.editableText) return;
      setEditingId(id);
    },
    [store],
  );

  useEffect(() => {
    if (engine === null) return undefined;
    const offHosts = engine.on('hostsChanged', (next) => setIds([...next]));
    const offCamera = engine.on('cameraChanged', (state) => setZoom(state.zoom));
    // The engine owns hit-testing, so it also owns hover: cards are transparent to the pointer
    // (05 §3), which means CSS `:hover` never fires on them. A port hit still counts as its node —
    // the analyst is over that card and the rail must stay reachable.
    const offHover = engine.on('hoverChanged', (target) => {
      setHoveredId(
        target.t === 'node' || target.t === 'port' || target.t === 'handle' ? target.id : null,
      );
    });
    // Double-click editing used to hang off the card's own DOM handler. With a pointer-transparent
    // card the gesture reaches the engine instead, which publishes `begin-edit-text`.
    const offIntent = engine.on('intent', (intent) => {
      if (intent.t === 'begin-edit-text') beginEdit(intent.id);
    });
    return () => {
      offHosts();
      offCamera();
      offHover();
      offIntent();
    };
  }, [engine, beginEdit]);

  // Enter on a single selection starts editing — the keyboard path to the same gesture as a
  // double-click (§5.5). Typing inside a field must never be hijacked, hence the target check.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (selectedIds.length !== 1) return;
      // Enter also confirms a pending connection (P5 §6). The engine owns that gesture, so the
      // text editor must not steal the key mid-connection.
      if (engine?.state.interaction === 'connecting') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return;
      const id = selectedIds[0];
      if (id === undefined) return;
      event.preventDefault();
      beginEdit(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, beginEdit, engine]);

  // A node that stops being hosted (culled, deleted) must not stay "in edit" invisibly.
  useEffect(() => {
    if (editingId !== null && !ids.includes(editingId)) setEditingId(null);
  }, [ids, editingId]);

  const detailed = zoom >= DETAIL_ZOOM;
  const selected = new Set(selectedIds);

  return (
    <>
      {ids.map((id) => {
        const slot = slotOf(id);
        if (slot === undefined) return null;
        return (
          <HostedCard
            key={id}
            id={id}
            doc={doc}
            store={store}
            editing={editingId === id}
            onEndEdit={() => setEditingId(null)}
            slot={slot}
            detailed={detailed}
            hovered={hoveredId === id}
            selected={selected.has(id) && selected.size === 1}
            multiSelected={selected.has(id) && selected.size > 1}
            dimmed={
              tagFilter !== null && !(store.getSnapshot(id)?.tags.includes(tagFilter) ?? false)
            }
            actions={{ ...actions, onBeginEdit: beginEdit }}
          />
        );
      })}
    </>
  );
}
