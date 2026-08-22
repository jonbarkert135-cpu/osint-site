/**
 * The groups panel (roadmap §19).
 *
 * The grouping commands existed but had no surface at all: a group could be created from the
 * palette and then never touched again. This panel is that surface — one row per group, with the
 * four things an analyst actually does to a cluster: select it (which is how it is moved or
 * exported as a whole), collapse it out of the way, protect it from accidental edits, and take it
 * apart.
 */

import { Button } from '@nexus/ui';
import type * as Y from 'yjs';

import {
  boardGroups,
  groupMembers,
  labelOf,
  setGroupCollapsed,
  setGroupLocked,
  ungroupSelected,
  type GroupContext,
} from './groupCommands.ts';

export interface GroupsPanelProps {
  open: boolean;
  doc: Y.Doc;
  context: GroupContext;
  onClose: () => void;
  onSelect: (ids: readonly string[]) => void;
  onNotice: (message: string) => void;
}

export function GroupsPanel({ open, doc, context, onClose, onSelect, onNotice }: GroupsPanelProps) {
  if (!open) return null;
  const groups = boardGroups(doc);

  return (
    <aside className="nx-groups-panel" aria-label="Groups" data-testid="groups-panel">
      <header>
        <strong>Groups</strong>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </header>

      {groups.length === 0 ? (
        <p className="nx-muted" data-testid="groups-empty">
          No groups yet. Select two or more cards and press Ctrl+G to frame them together.
        </p>
      ) : (
        <ul className="nx-groups-list">
          {groups.map((group) => {
            const members = groupMembers(group);
            return (
              <li key={group.id} data-testid={`group-row-${group.id}`}>
                <span className="nx-groups-label">{labelOf(group)}</span>
                <span className="nx-muted">
                  {String(members.length)} {members.length === 1 ? 'card' : 'cards'}
                </span>
                <Button variant="secondary" onClick={() => onSelect(members)}>
                  Select
                </Button>
                <Button
                  variant="secondary"
                  aria-pressed={group.collapsed}
                  onClick={() => onNotice(setGroupCollapsed(context, group, !group.collapsed))}
                >
                  {group.collapsed ? 'Expand' : 'Collapse'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => onNotice(setGroupLocked(context, group, true))}
                >
                  Lock
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => onNotice(setGroupLocked(context, group, false))}
                >
                  Unlock
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => onNotice(ungroupSelected(context, members))}
                >
                  Ungroup
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
