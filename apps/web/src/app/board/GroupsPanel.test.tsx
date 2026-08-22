/**
 * The groups panel is the surface §19 was missing: every row does something to a real document.
 */

import { addNode, createBoardDoc, createBoardHistory, getNode, makeNode } from '@nexus/domain';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GroupsPanel } from './GroupsPanel.tsx';
import { boardGroups, groupSelected } from './groupCommands.ts';

const NOW = '2026-08-23T00:00:00.000Z';

function setup(withGroup: boolean) {
  const doc = createBoardDoc({ boardId: 'b_panel', now: NOW });
  for (const id of ['n1', 'n2']) {
    addNode(doc, makeNode({ id, type: 'note', x: 0, y: 0 }, NOW), {
      origin: 'local:create',
      now: NOW,
    });
  }
  const context = { doc, history: createBoardHistory(doc), now: () => NOW };
  if (withGroup) groupSelected(context, ['n1', 'n2']);
  return { doc, context };
}

describe('GroupsPanel', () => {
  it('teaches how to make a group when there is none', () => {
    const { doc, context } = setup(false);
    render(
      <GroupsPanel
        open
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(screen.getByTestId('groups-empty')).toHaveTextContent('Ctrl+G');
  });

  it('selects, collapses and locks a real group from its row', async () => {
    const user = userEvent.setup();
    const { doc, context } = setup(true);
    const onSelect = vi.fn();
    const onNotice = vi.fn();
    render(
      <GroupsPanel
        open
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={onSelect}
        onNotice={onNotice}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelect).toHaveBeenCalledWith(['n1', 'n2']);

    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(getNode(doc, 'n1')?.hidden).toBe(true);
    expect(onNotice).toHaveBeenCalledWith('Collapsed Group');

    await user.click(screen.getByRole('button', { name: 'Lock' }));
    expect(getNode(doc, 'n2')?.locked).toBe(true);
  });

  it('takes a group apart', async () => {
    const user = userEvent.setup();
    const { doc, context } = setup(true);
    render(
      <GroupsPanel
        open
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Ungroup' }));
    expect(boardGroups(doc)).toHaveLength(0);
  });

  it('renders nothing while closed', () => {
    const { doc, context } = setup(true);
    render(
      <GroupsPanel
        open={false}
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('groups-panel')).not.toBeInTheDocument();
  });
});
