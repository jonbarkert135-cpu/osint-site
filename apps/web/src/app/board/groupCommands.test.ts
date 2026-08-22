/**
 * Roadmap §19 — grouping a selection from the UI.
 */

import {
  addNode,
  createBoardDoc,
  createBoardHistory,
  getNode,
  listGroups,
  makeNode,
} from '@nexus/domain';
import { describe, expect, it } from 'vitest';

import {
  boardGroups,
  groupSelected,
  setGroupCollapsed,
  setGroupLocked,
  ungroupSelected,
} from './groupCommands.ts';

const NOW = '2026-08-22T10:00:00.000Z';

function context() {
  const doc = createBoardDoc({ boardId: 'b_group', now: NOW });
  for (const id of ['n1', 'n2']) {
    addNode(doc, makeNode({ id, type: 'note', x: 0, y: 0 }, NOW), {
      origin: 'local:create',
      now: NOW,
    });
  }
  return { doc, history: createBoardHistory(doc), now: () => NOW };
}

describe('group commands', () => {
  it('groups two selected nodes as one undo step', () => {
    const ctx = context();
    expect(groupSelected(ctx, ['n1', 'n2'])).toBe('Grouped 2 nodes');
    expect(listGroups(ctx.doc)).toHaveLength(1);
  });

  it('explains why a short selection cannot be grouped', () => {
    const ctx = context();
    expect(groupSelected(ctx, ['n1'])).toBe('Select at least two nodes to group them.');
    expect(groupSelected(ctx, ['n1', 'gone'])).toBe('Nothing to group.');
    expect(listGroups(ctx.doc)).toHaveLength(0);
  });

  it('ungroups whatever group the selection belongs to', () => {
    const ctx = context();
    groupSelected(ctx, ['n1', 'n2']);
    expect(ungroupSelected(ctx, ['n2'])).toBe('Ungrouped Group');
    expect(listGroups(ctx.doc)).toHaveLength(0);
    expect(ungroupSelected(ctx, ['n2'])).toBe('The selection is not in a group.');
  });

  it('collapses a group by hiding its members, and expanding brings them back', () => {
    const ctx = context();
    groupSelected(ctx, ['n1', 'n2']);
    const group = boardGroups(ctx.doc)[0]!;

    expect(setGroupCollapsed(ctx, group, true)).toBe('Collapsed Group');
    expect(getNode(ctx.doc, 'n1')?.hidden).toBe(true);
    expect(listGroups(ctx.doc)[0]?.collapsed).toBe(true);

    const collapsed = boardGroups(ctx.doc)[0]!;
    expect(setGroupCollapsed(ctx, collapsed, false)).toBe('Expanded Group');
    expect(getNode(ctx.doc, 'n1')?.hidden).toBe(false);
    expect(listGroups(ctx.doc)[0]?.collapsed).toBe(false);
  });

  it('protects a group from accidental edits by locking its members', () => {
    const ctx = context();
    groupSelected(ctx, ['n1', 'n2']);
    const group = boardGroups(ctx.doc)[0]!;

    expect(setGroupLocked(ctx, group, true)).toBe('Locked Group');
    expect(getNode(ctx.doc, 'n1')?.locked).toBe(true);
    expect(getNode(ctx.doc, 'n2')?.locked).toBe(true);

    expect(setGroupLocked(ctx, group, false)).toBe('Unlocked Group');
    expect(getNode(ctx.doc, 'n2')?.locked).toBe(false);
  });
});
