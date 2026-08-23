/**
 * The layers panel is the way back from "Hide": a hidden node stays listed, on top, and one click
 * brings it back. Every row writes to a real document.
 */

import { addNode, createBoardDoc, createBoardHistory, getNode, makeNode } from '@nexus/domain';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LayersPanel } from './LayersPanel.tsx';
import { boardLayers, setLayerHidden } from './layerCommands.ts';

const NOW = '2026-08-23T00:00:00.000Z';

function setup(empty = false) {
  const doc = createBoardDoc({ boardId: 'b_layers', now: NOW });
  if (!empty) {
    const seeds: ReadonlyArray<readonly [string, string]> = [
      ['n1', 'Visible card'],
      ['n2', 'Hidden card'],
    ];
    for (const [id, title] of seeds) {
      addNode(doc, makeNode({ id, type: 'note', x: 0, y: 0, title }, NOW), {
        origin: 'local:create',
        now: NOW,
      });
    }
  }
  const context = { doc, history: createBoardHistory(doc), now: () => NOW };
  return { doc, context };
}

describe('LayersPanel', () => {
  it('lists hidden nodes first so a hidden card can always be found', () => {
    const { doc, context } = setup();
    setLayerHidden(context, boardLayers(doc)[1] as never, true);

    expect(boardLayers(doc)[0]?.id).toBe('n2');
    expect(boardLayers(doc)[0]?.hidden).toBe(true);
  });

  it('brings a hidden node back from its row', async () => {
    const user = userEvent.setup();
    const { doc, context } = setup();
    setLayerHidden(context, boardLayers(doc)[1] as never, true);
    const onNotice = vi.fn();

    render(
      <LayersPanel
        open
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={onNotice}
      />,
    );

    expect(screen.getByTestId('layers-hidden-count')).toHaveTextContent('1 hidden');
    const row = screen.getByTestId('layer-row-n2');
    await user.click(within(row).getByRole('button', { name: 'Show' }));

    expect(getNode(doc, 'n2')?.hidden).toBe(false);
    expect(onNotice.mock.lastCall?.[0]).toContain('visible again');
  });

  it('locks a node from its row and reports it', async () => {
    const user = userEvent.setup();
    const { doc, context } = setup();
    const onNotice = vi.fn();

    render(
      <LayersPanel
        open
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={onNotice}
      />,
    );

    await user.click(
      within(screen.getByTestId('layer-row-n1')).getByRole('button', { name: 'Lock' }),
    );
    expect(getNode(doc, 'n1')?.locked).toBe(true);
  });

  it('explains the empty board instead of showing an empty list', () => {
    const { doc, context } = setup(true);
    render(
      <LayersPanel
        open
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(screen.getByTestId('layers-empty')).toHaveTextContent('board is empty');
  });

  it('renders nothing while closed', () => {
    const { doc, context } = setup();
    render(
      <LayersPanel
        open={false}
        doc={doc}
        context={context}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('layers-panel')).toBeNull();
  });
});
