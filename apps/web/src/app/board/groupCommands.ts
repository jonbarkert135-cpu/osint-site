/**
 * Group / ungroup the current selection (roadmap §19). Kept out of the component so the rules are
 * testable without a canvas: each call is one document write and returns the line the toast shows.
 */

import {
  groupOf,
  groupSelection,
  listGroups,
  ungroup,
  updateGroup,
  updateNode,
  type BoardGroup,
} from '@nexus/domain';
import type * as Y from 'yjs';

export interface GroupContext {
  doc: Y.Doc;
  history: { label(text: string): void; separate(): void };
  now: () => string;
}

export function groupSelected(context: GroupContext, ids: readonly string[]): string {
  if (ids.length < 2) return 'Select at least two nodes to group them.';
  context.history.label('group');
  const group = groupSelection(context.doc, ids, { now: context.now() });
  context.history.separate();
  return group === null ? 'Nothing to group.' : `Grouped ${String(group.childIds.length)} nodes`;
}

export function ungroupSelected(context: GroupContext, ids: readonly string[]): string {
  const group = ids.map((id) => groupOf(context.doc, id)).find((found) => found !== undefined);
  if (group === undefined) return 'The selection is not in a group.';
  context.history.label('ungroup');
  ungroup(context.doc, group.id, { now: context.now() });
  context.history.separate();
  return `Ungrouped ${group.label === '' ? 'the group' : group.label}`;
}

/** Every group on the board, newest first — what the groups panel lists. */
export function boardGroups(doc: Y.Doc): BoardGroup[] {
  return [...listGroups(doc)].reverse();
}

/**
 * Collapsing hides the members and marks the frame, so a finished line of enquiry stops competing
 * for attention without being deleted. Expanding is the exact inverse.
 */
export function setGroupCollapsed(
  context: GroupContext,
  group: BoardGroup,
  collapsed: boolean,
): string {
  const now = context.now();
  context.history.label(collapsed ? 'collapse group' : 'expand group');
  updateGroup(context.doc, group.id, { collapsed }, { origin: 'local:edit', now });
  for (const childId of group.childIds) {
    updateNode(context.doc, childId, { hidden: collapsed }, { origin: 'local:edit', now });
  }
  context.history.separate();
  return `${collapsed ? 'Collapsed' : 'Expanded'} ${labelOf(group)}`;
}

/** Locking the members is what "protect from accidental editing" means to the engine. */
export function setGroupLocked(context: GroupContext, group: BoardGroup, locked: boolean): string {
  const now = context.now();
  context.history.label(locked ? 'lock group' : 'unlock group');
  for (const childId of group.childIds) {
    updateNode(context.doc, childId, { locked }, { origin: 'local:edit', now });
  }
  context.history.separate();
  return `${locked ? 'Locked' : 'Unlocked'} ${labelOf(group)}`;
}

/** Selecting the members is how a group is moved, exported or acted on as a whole. */
export function groupMembers(group: BoardGroup): string[] {
  return [...group.childIds];
}

export function labelOf(group: BoardGroup): string {
  return group.label === '' ? 'the group' : group.label;
}
