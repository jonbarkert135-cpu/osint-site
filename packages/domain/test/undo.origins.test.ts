/**
 * Undo is local-origin scoped (N3, P3 §5.4–5.5): ⌘Z never reverts a collaborator's edit, and it
 * reverses every mutation type that exists so far, 200 levels deep.
 */

import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { createBoardDoc, emptyBoardDoc } from '../src/doc/createBoardDoc.ts';
import {
  addEdges,
  addGroup,
  addNodes,
  getNode,
  listEdges,
  listGroups,
  listNodes,
  moveNodes,
  ensureFragment,
  removeNodes,
  reorder,
  updateNode,
} from '../src/doc/mutations.ts';
import { makeEdge } from '../src/entities/edge.ts';
import { makeGroup } from '../src/entities/group.ts';
import { makeNode } from '../src/entities/node.ts';
import { isUndoable, LOCAL_IMPORT, LOCAL_USER, REMOTE, SYSTEM } from '../src/history/origins.ts';
import { UNDO_STACK_LIMIT, createBoardHistory } from '../src/history/undoManager.ts';
import { T0, fixtureNode } from './doc-fixtures.ts';

const local = { origin: 'local:create', now: T0 } as const;
// captureTimeout 0 keeps every operation a separate undo step in tests.
const history = (doc: Y.Doc) => createBoardHistory(doc, { captureTimeout: 0 });

describe('undo/redo', () => {
  it('classifies origins', () => {
    expect([LOCAL_USER, LOCAL_IMPORT].every(isUndoable)).toBe(true);
    expect(isUndoable(REMOTE)).toBe(false);
    expect(isUndoable(SYSTEM)).toBe(false);
    expect(isUndoable(undefined)).toBe(false);
  });

  it('reverses every mutation type introduced so far', () => {
    const doc = createBoardDoc({ boardId: 'b_undo', now: T0 });
    const h = history(doc);

    addNodes(doc, [fixtureNode('n1', 0), fixtureNode('n2', 1)], local);
    addEdges(doc, [makeEdge({ id: 'e1', from: 'n1', to: 'n2' }, T0)], local);
    addGroup(doc, makeGroup({ id: 'g1', x: 0, y: 0, w: 100, h: 100 }, T0), local);
    moveNodes(doc, [{ id: 'n1', x: 900, y: 900 }], { origin: 'local:move', now: T0 });
    updateNode(doc, 'n1', { title: 'renamed' }, { origin: 'local:edit', now: T0 });
    reorder(doc, ['n1'], 'front', { origin: 'local:layout', now: T0 });
    removeNodes(doc, ['n2'], { origin: 'local:delete', now: T0 });

    expect(listNodes(doc)).toHaveLength(1);
    h.undo(); // delete
    expect(listNodes(doc)).toHaveLength(2);
    h.undo(); // reorder
    h.undo(); // rename
    expect(getNode(doc, 'n1')?.title).not.toBe('renamed');
    h.undo(); // move
    expect(getNode(doc, 'n1')?.x).toBe(0);
    h.undo(); // group
    expect(listGroups(doc)).toHaveLength(0);
    h.undo(); // edge
    expect(listEdges(doc)).toHaveLength(0);
    h.undo(); // nodes
    expect(listNodes(doc)).toHaveLength(0);
    expect(h.state.canUndo).toBe(false);

    h.redo();
    expect(listNodes(doc)).toHaveLength(2);
    h.destroy();
  });

  it('never undoes a remote change', () => {
    const mine = createBoardDoc({ boardId: 'b_remote', now: T0 });
    const theirs = emptyBoardDoc('b_remote');
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine), 'remote:sync');
    const h = history(mine);

    addNodes(mine, [fixtureNode('mine', 0)], local);
    addNodes(theirs, [fixtureNode('theirs', 1)], local);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs), 'remote:sync');
    expect(listNodes(mine)).toHaveLength(2);

    h.undo();
    const ids = listNodes(mine).map((node) => node.id);
    expect(ids).toEqual(['theirs']);
    expect(h.state.canUndo).toBe(false);
    h.destroy();
  });

  it('ignores system and import-side origins outside the tracked set', () => {
    const doc = createBoardDoc({ boardId: 'b_sys', now: T0 });
    const h = history(doc);
    addNodes(doc, [fixtureNode('sys', 0)], { origin: 'system:import', now: T0 });
    expect(h.state.canUndo).toBe(false);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
    h.destroy();
  });

  it('labels steps and notifies subscribers', () => {
    const doc = createBoardDoc({ boardId: 'b_label', now: T0 });
    const h = history(doc);
    const states: Array<string | null> = [];
    const off = h.subscribe((state) => states.push(state.undoLabel));

    h.label('create 1 node');
    addNodes(doc, [fixtureNode('n1', 0)], local);
    expect(h.state.undoLabel).toBe('create 1 node');

    h.label('move 1 node');
    moveNodes(doc, [{ id: 'n1', x: 5, y: 5 }], { origin: 'local:move', now: T0 });
    expect(h.state.undoLabel).toBe('move 1 node');
    h.undo();
    expect(h.state.redoLabel).toBe('move 1 node');

    off();
    expect(states.length).toBeGreaterThan(1);
    h.destroy();
  });

  it('merges edits inside the capture window but separates them on demand', () => {
    const doc = createBoardDoc({ boardId: 'b_capture', now: T0 });
    // The real capture timeout: two quick edits would otherwise become one undo step.
    const h = createBoardHistory(doc);

    addNodes(doc, [fixtureNode('n1', 0)], local);
    addNodes(doc, [fixtureNode('n2', 1)], local);
    expect(h.state.undoDepth).toBe(1);
    h.undo();
    expect(listNodes(doc)).toHaveLength(0);

    h.redo();
    h.separate();
    addNodes(doc, [fixtureNode('n3', 2)], local);
    expect(h.state.undoDepth).toBe(2);
    h.undo();
    expect(
      listNodes(doc)
        .map((node) => node.id)
        .sort(),
    ).toEqual(['n1', 'n2']);
    h.destroy();
  });

  it('caps the undo stack at 200 items', () => {
    const doc = createBoardDoc({ boardId: 'b_cap', now: T0 });
    const h = history(doc);
    for (let i = 0; i < UNDO_STACK_LIMIT + 25; i += 1) {
      addNodes(doc, [makeNode({ id: `n${String(i)}`, x: i, y: 0 }, T0)], local);
    }
    expect(h.state.undoDepth).toBe(UNDO_STACK_LIMIT);
    h.destroy();
  });

  it('caps the redo stack at 200 items as well', () => {
    const doc = createBoardDoc({ boardId: 'b_cap_redo', now: T0 });
    const h = history(doc);
    for (let i = 0; i < UNDO_STACK_LIMIT + 25; i += 1) {
      addNodes(doc, [makeNode({ id: `n${String(i)}`, x: i, y: 0 }, T0)], local);
    }
    for (let i = 0; i < UNDO_STACK_LIMIT; i += 1) h.undo();
    expect(h.state.redoDepth).toBe(UNDO_STACK_LIMIT);
    h.destroy();
  });
});

describe('extra tracked origins', () => {
  it('tracks an editor origin that is not one of our own transaction tags', () => {
    // y-prosemirror transacts under its plugin key; without opting it in, typing in the rich-text
    // editor would be invisible to ⌘Z (P4 §5.5).
    const board = createBoardDoc({ boardId: 'b_undo_extra', now: T0 });
    const editorOrigin = { plugin: 'y-sync' };
    const h = createBoardHistory(board, { captureTimeout: 0, extraTrackedOrigins: [editorOrigin] });

    const fragment = ensureFragment(board, 'fk_editor', 'local:create');
    const before = h.state.undoDepth;
    board.transact(() => fragment.insert(0, [new Y.XmlText('typed by the editor')]), editorOrigin);
    expect(h.state.undoDepth).toBe(before + 1);

    h.undo();
    expect(fragment.length).toBe(0);
    expect(h.state.undoDepth).toBe(before);

    // An untracked origin still stays out of the stack.
    board.transact(() => fragment.insert(0, [new Y.XmlText('from a peer')]), 'remote:sync');
    expect(h.state.undoDepth).toBe(before);
    h.destroy();
  });
});
