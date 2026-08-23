/**
 * The two halves of the P3 binding: document → scene patches, and engine intents → transactions.
 */

import type { Intent } from '@nexus/canvas-engine';
import {
  addEdge,
  addGroup,
  addNode,
  createBoardDoc,
  createBoardHistory,
  getEdge,
  getNode,
  listEdges,
  listNodes,
  makeEdge,
  groupSelection,
  makeGroup,
  makeNode,
  observeBoard,
  type BoardChange,
} from '@nexus/domain';
import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';

import { applyIntent, createNoteNode, type IntentContext } from './applyIntents';
import { MAIN_LAYER_ID, patchesFromChange, sceneFromDoc } from './sceneFromDoc';

const NOW = '2026-08-17T12:00:00.000Z';
const local = { origin: 'local:create', now: NOW } as const;

function board(): Y.Doc {
  const doc = createBoardDoc({ boardId: 'b_bind', now: NOW });
  addNode(doc, makeNode({ id: 'n1', type: 'note', x: 0, y: 0, title: 'One' }, NOW), local);
  addNode(doc, makeNode({ id: 'n2', type: 'website', x: 400, y: 0, title: 'Two' }, NOW), local);
  addEdge(doc, makeEdge({ id: 'e1', from: 'n1', to: 'n2', label: 'links to' }, NOW), local);
  return doc;
}

const context = (doc: Y.Doc, ids = ['x1', 'x2', 'x3']): IntentContext => {
  let index = 0;
  return {
    doc,
    history: createBoardHistory(doc, { captureTimeout: 0 }),
    now: () => NOW,
    makeId: () => ids[index++] ?? `y${String(index)}`,
  };
};

function changesOf(doc: Y.Doc, mutate: () => void): BoardChange {
  let captured: BoardChange | null = null;
  const off = observeBoard(doc, (change) => (captured = change));
  mutate();
  off();
  if (captured === null) throw new Error('no change was observed');
  return captured;
}

describe('sceneFromDoc', () => {
  it('maps a document to a full scene snapshot', () => {
    const doc = board();
    addGroup(doc, makeGroup({ id: 'g1', x: 0, y: 0, w: 100, h: 100, label: 'Infra' }, NOW), local);
    const scene = sceneFromDoc(doc);

    expect(scene.layers).toEqual([
      { id: MAIN_LAYER_ID, name: 'Main', visible: true, locked: false },
    ]);
    expect(scene.nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(scene.nodes[0]?.glyph.title).toBe('One');
    expect(scene.nodes[0]?.domKey).toBe('note:n1');
    expect(scene.nodes[1]?.glyph.accent).not.toEqual(scene.nodes[0]?.glyph.accent);
    expect(scene.edges[0]).toMatchObject({ from: 'n1', to: 'n2', label: 'links to' });
    expect(scene.groups[0]).toMatchObject({ id: 'g1', title: 'Infra' });
  });

  it('hides archived nodes and unlabelled edges are null', () => {
    const doc = createBoardDoc({ boardId: 'b_hidden', now: NOW });
    addNode(
      doc,
      { ...makeNode({ id: 'n1', x: 0, y: 0 }, NOW), status: 'archived' as const },
      local,
    );
    addNode(doc, makeNode({ id: 'n2', x: 10, y: 0 }, NOW), local);
    addEdge(doc, makeEdge({ id: 'e1', from: 'n1', to: 'n2' }, NOW), local);
    const scene = sceneFromDoc(doc);
    expect(scene.nodes[0]?.hidden).toBe(true);
    expect(scene.edges[0]?.label).toBeNull();
  });

  it('turns an observed change into incremental patches only for what changed', () => {
    const doc = board();
    const change = changesOf(doc, () => {
      addNode(doc, makeNode({ id: 'n3', x: 20, y: 20, title: 'Three' }, NOW), local);
    });
    const patches = patchesFromChange(doc, change);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ op: 'upsert-node' });
  });

  it('emits removals for nodes, edges and groups', () => {
    const doc = board();
    addGroup(doc, makeGroup({ id: 'g1', x: 0, y: 0, w: 10, h: 10 }, NOW), local);
    const change = changesOf(doc, () => {
      applyIntent({ t: 'delete', ids: ['n1'] }, context(doc));
    });
    const ops = patchesFromChange(doc, change).map((patch) => patch.op);
    expect(ops).toContain('remove-node');
    expect(ops).toContain('remove-edge');
  });

  it('ignores ids that vanished before the patch was computed', () => {
    const doc = board();
    const change: BoardChange = {
      nodes: { upserted: ['ghost'], removed: [] },
      edges: { upserted: ['ghost'], removed: [] },
      groups: { upserted: ['ghost'], removed: [] },
      orderChanged: false,
      metaChanged: false,
      origin: 'local:edit',
      remote: false,
    };
    expect(patchesFromChange(doc, change)).toEqual([]);
  });
});

describe('applyIntent', () => {
  it('drags a whole group when one of its members is dragged', () => {
    const doc = board();
    groupSelection(doc, ['n1', 'n2'], { now: NOW });

    applyIntent(
      { t: 'move-nodes', deltas: [{ id: 'n1', dx: 10, dy: 5 }], phase: 'end' },
      context(doc),
    );

    expect(getNode(doc, 'n1')).toMatchObject({ x: 10, y: 5 });
    expect(getNode(doc, 'n2')).toMatchObject({ x: 410, y: 5 });
  });

  it('moves nodes by the gesture delta and skips unknown ids', () => {
    const doc = board();
    expect(
      applyIntent(
        {
          t: 'move-nodes',
          deltas: [
            { id: 'n1', dx: 10, dy: 20 },
            { id: 'ghost', dx: 5, dy: 5 },
          ],
          phase: 'end',
        },
        context(doc),
      ),
    ).toBe(true);
    expect(getNode(doc, 'n1')).toMatchObject({ x: 10, y: 20 });
    expect(
      applyIntent(
        { t: 'move-nodes', deltas: [{ id: 'n1', dx: 1, dy: 1 }], phase: 'cancel' },
        context(doc),
      ),
    ).toBe(false);
    expect(
      applyIntent(
        { t: 'move-nodes', deltas: [{ id: 'ghost', dx: 1, dy: 1 }], phase: 'end' },
        context(doc),
      ),
    ).toBe(false);
  });

  it('resizes a node and ignores a cancelled gesture', () => {
    const doc = board();
    expect(
      applyIntent(
        { t: 'resize-node', id: 'n1', x: 5, y: 5, w: 320, h: 200, phase: 'end' },
        context(doc),
      ),
    ).toBe(true);
    expect(getNode(doc, 'n1')).toMatchObject({ w: 320, h: 200 });
    expect(
      applyIntent(
        { t: 'resize-node', id: 'n1', x: 0, y: 0, w: 10, h: 10, phase: 'cancel' },
        context(doc),
      ),
    ).toBe(false);
  });

  it('deletes nodes and edges together and reports when nothing matched', () => {
    const doc = board();
    expect(applyIntent({ t: 'delete', ids: ['ghost'] }, context(doc))).toBe(false);
    expect(applyIntent({ t: 'delete', ids: ['n1', 'e1'] }, context(doc))).toBe(true);
    expect(listNodes(doc)).toHaveLength(1);
    expect(listEdges(doc)).toHaveLength(0);
  });

  it('hands the new relationship to the host so it opens in the inspector', () => {
    const doc = board();
    addNode(doc, makeNode({ id: 'n3', x: 0, y: 400 }, NOW), local);
    const created: string[] = [];
    applyIntent(
      {
        t: 'create-edge',
        from: 'n1',
        fromAnchor: { side: 'auto', t: 0.5 },
        to: 'n3',
        toAnchor: { side: 'auto', t: 0.5 },
      },
      { ...context(doc), onEdgeCreated: (id) => created.push(id) },
    );
    expect(created).toEqual(['x1']);
  });

  it('creates and reconnects edges', () => {
    const doc = board();
    addNode(doc, makeNode({ id: 'n3', x: 0, y: 400 }, NOW), local);
    expect(
      applyIntent(
        {
          t: 'create-edge',
          from: 'n1',
          fromAnchor: { side: 'auto', t: 0.5 },
          to: 'n3',
          toAnchor: { side: 'auto', t: 0.5 },
        },
        context(doc),
      ),
    ).toBe(true);
    expect(getEdge(doc, 'x1')?.target.nodeId).toBe('n3');

    expect(
      applyIntent(
        {
          t: 'reconnect-edge',
          edgeId: 'e1',
          end: 'to',
          to: 'n3',
          anchor: { side: 'auto', t: 0.5 },
        },
        context(doc),
      ),
    ).toBe(true);
    expect(getEdge(doc, 'e1')?.target.nodeId).toBe('n3');

    expect(
      applyIntent(
        {
          t: 'create-edge',
          from: 'n1',
          fromAnchor: { side: 'auto', t: 0 },
          to: 'ghost',
          toAnchor: { side: 'auto', t: 0 },
        },
        context(doc),
      ),
    ).toBe(false);
    expect(
      applyIntent(
        {
          t: 'reconnect-edge',
          edgeId: 'ghost',
          end: 'from',
          to: 'n1',
          anchor: { side: 'auto', t: 0 },
        },
        context(doc),
      ),
    ).toBe(false);
  });

  it('creates nodes from every drop payload', () => {
    const doc = createBoardDoc({ boardId: 'b_drop', now: NOW });
    const ctx = context(doc, ['d1', 'd2', 'd3']);
    applyIntent(
      {
        t: 'create-node-from-drop',
        at: { x: 100, y: 100 },
        payload: { kind: 'url', text: 'https://x.test' },
      },
      ctx,
    );
    applyIntent(
      {
        t: 'create-node-from-drop',
        at: { x: 0, y: 0 },
        payload: { kind: 'text', text: 'note body' },
      },
      ctx,
    );
    applyIntent(
      {
        t: 'create-node-from-drop',
        at: { x: 0, y: 0 },
        payload: { kind: 'files', files: [new File(['x'], 'evidence.png')] },
      },
      ctx,
    );
    // The capture registry picks the type: a URL unfurls, prose becomes a text note, a .png is an image.
    expect(listNodes(doc).map((node) => node.type)).toEqual(['website', 'text', 'image']);
    expect(getNode(doc, 'd1')?.provenance.source).toBe('https://x.test');
    expect(getNode(doc, 'd3')?.title).toBe('evidence.png');
  });

  it('handles z-order and lock intents', () => {
    const doc = board();
    expect(applyIntent({ t: 'z-order', ids: ['ghost'], op: 'front' }, context(doc))).toBe(false);
    expect(applyIntent({ t: 'z-order', ids: ['n1'], op: 'front' }, context(doc))).toBe(true);
    expect(applyIntent({ t: 'lock', ids: ['n1'], locked: true }, context(doc))).toBe(true);
    expect(getNode(doc, 'n1')?.locked).toBe(true);
    expect(applyIntent({ t: 'lock', ids: ['ghost'], locked: true }, context(doc))).toBe(false);
  });

  it('ignores ephemeral intents', () => {
    const doc = board();
    const ephemeral: Intent[] = [
      { t: 'select', ids: ['n1'], mode: 'replace' },
      { t: 'camera', camera: { x: 0, y: 0, zoom: 1 }, cause: 'user' },
      { t: 'begin-edit-text', id: 'n1' },
    ];
    for (const intent of ephemeral) expect(applyIntent(intent, context(doc))).toBe(false);
  });

  it('creates a note centred on a point and labels the undo step', () => {
    const doc = createBoardDoc({ boardId: 'b_note', now: NOW });
    const ctx = context(doc, ['note1']);
    const id = createNoteNode(ctx, { x: 500, y: 300 });
    const node = getNode(doc, id);
    expect(node).toMatchObject({ type: 'note', title: 'New note' });
    expect(node?.x).toBe(500 - 280 / 2);
    expect(ctx.history?.state.undoLabel).toBe('create 1 node');
  });

  it('keeps two quick commands as two undo steps but merges a drag', () => {
    const doc = createBoardDoc({ boardId: 'b_steps', now: NOW });
    // The production capture timeout: without an explicit separation these would merge.
    const ctx: IntentContext = { doc, history: createBoardHistory(doc), now: () => NOW };

    createNoteNode(ctx, { x: 0, y: 0 });
    const moved = createNoteNode(ctx, { x: 100, y: 0 });
    expect(ctx.history?.state.undoDepth).toBe(2);
    // The second note is nudged off the first one, so the drag assertions start from where it
    // actually landed rather than from the aim.
    const placedX = getNode(doc, moved)?.x ?? 0;

    const drag = (phase: 'update' | 'end'): void => {
      applyIntent({ t: 'move-nodes', deltas: [{ id: moved, dx: 10, dy: 0 }], phase }, ctx);
    };
    drag('update');
    drag('update');
    drag('end');
    // Three interim commits, one gesture, one extra undo step.
    expect(ctx.history?.state.undoDepth).toBe(3);
    expect(getNode(doc, moved)?.x).toBe(placedX + 30);

    ctx.history?.undo();
    expect(getNode(doc, moved)?.x).toBe(placedX);
    ctx.history?.undo();
    expect(listNodes(doc)).toHaveLength(1);
  });

  it('never stacks two notes on the same spot', () => {
    const doc = createBoardDoc({ boardId: 'b_stack', now: NOW });
    const ctx: IntentContext = { doc, history: createBoardHistory(doc), now: () => NOW };

    const ids = [0, 1, 2].map(() => createNoteNode(ctx, { x: 500, y: 300 }));
    const boxes = ids.map((id) => getNode(doc, id));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const hit =
          a !== undefined &&
          b !== undefined &&
          a.x < b.x + b.w &&
          b.x < a.x + a.w &&
          a.y < b.y + b.h &&
          b.y < a.y + a.h;
        expect(hit).toBe(false);
      }
    }
  });

  it('mints ids on its own when none are injected', () => {
    const doc = createBoardDoc({ boardId: 'b_auto', now: NOW });
    const id = createNoteNode({ doc, now: () => NOW }, { x: 0, y: 0 });
    expect(id).toHaveLength(24);
    expect(listNodes(doc)).toHaveLength(1);
  });
});

describe('waypoint intents (P5 part 4 §1)', () => {
  const waypoints = (doc: Y.Doc): readonly { x: number; y: number }[] =>
    getEdge(doc, 'e1')?.waypoints ?? [];

  it('inserts, moves and deletes a waypoint, one document write each', () => {
    const doc = board();
    const ctx = context(doc);

    expect(
      applyIntent({ t: 'edge-waypoint', op: 'insert', edgeId: 'e1', at: { x: 200, y: 90 } }, ctx),
    ).toBe(true);
    expect(waypoints(doc)).toEqual([{ x: 200, y: 90 }]);

    applyIntent(
      {
        t: 'edge-waypoint',
        op: 'move',
        edgeId: 'e1',
        index: 0,
        at: { x: 220, y: 140 },
        phase: 'end',
      },
      ctx,
    );
    expect(waypoints(doc)).toEqual([{ x: 220, y: 140 }]);

    applyIntent({ t: 'edge-waypoint', op: 'delete', edgeId: 'e1', index: 0 }, ctx);
    expect(waypoints(doc)).toEqual([]);
  });

  it('follows the drag and ignores a cancelled one', () => {
    const doc = board();
    const ctx = context(doc);
    applyIntent({ t: 'edge-waypoint', op: 'insert', edgeId: 'e1', at: { x: 200, y: 90 } }, ctx);

    let step = 0;
    for (const phase of ['start', 'update', 'end'] as const) {
      step += 10;
      applyIntent(
        {
          t: 'edge-waypoint',
          op: 'move',
          edgeId: 'e1',
          index: 0,
          at: { x: 300 + step, y: 300 },
          phase,
        },
        ctx,
      );
    }
    expect(waypoints(doc)).toEqual([{ x: 330, y: 300 }]);

    expect(
      applyIntent(
        {
          t: 'edge-waypoint',
          op: 'move',
          edgeId: 'e1',
          index: 0,
          at: { x: 900, y: 900 },
          phase: 'cancel',
        },
        ctx,
      ),
    ).toBe(false);
  });

  it('is a no-op for a relationship that no longer exists', () => {
    const doc = board();
    expect(
      applyIntent(
        { t: 'edge-waypoint', op: 'insert', edgeId: 'gone', at: { x: 0, y: 0 } },
        context(doc),
      ),
    ).toBe(false);
  });
});

describe('edge views carry the routing inputs', () => {
  it('passes waypoints and the flow flag to the engine', () => {
    const doc = board();
    applyIntent(
      { t: 'edge-waypoint', op: 'insert', edgeId: 'e1', at: { x: 200, y: 90 } },
      context(doc),
    );
    const view = sceneFromDoc(doc).edges.find((edge) => edge.id === 'e1');
    expect(view?.waypoints).toEqual([{ x: 200, y: 90 }]);
    expect(view?.manualRoute).toBe(false);
    expect(view?.style.animated).toBe(false);
  });
});
