/**
 * Inspector behaviour (P4 §5.6, §6, acceptance criterion 4). The panel writes through the domain
 * lifecycle, so these tests assert the *document* changed — not that a local state hook did.
 */

import {
  addEdge,
  createBoardDoc,
  createNode,
  getNode,
  listEdges,
  makeEdge,
  updateNode,
} from '@nexus/domain';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';

import { createNodeStore, type NodeStore } from '../nodeStore.ts';
import { Inspector, INSPECTOR_MAX_WIDTH } from './Inspector.tsx';

const T0 = '2026-06-01T00:00:00.000Z';

function board(): { doc: Y.Doc; store: NodeStore; ids: string[] } {
  const doc = createBoardDoc({ boardId: 'b_inspector', now: T0 });
  const ids: string[] = [];
  let counter = 0;
  const make = (type: string, data: Record<string, unknown>, title: string): string => {
    const { node } = createNode(
      doc,
      { type, x: 0, y: 0, title, data, tags: ['osint'] },
      { now: T0, makeId: () => `n_${String(++counter)}` },
    );
    ids.push(node.id);
    return node.id;
  };
  make('website', { url: 'https://example.com', status: 'ok' }, 'Example page');
  make('note', { plain: 'A finding' }, 'Finding');
  return { doc, store: createNodeStore(doc), ids };
}

const panel = (props: Partial<React.ComponentProps<typeof Inspector>> = {}) => {
  const { doc, store, ids } = board();
  const view = render(
    <Inspector doc={doc} store={store} selectedIds={[ids[0] ?? '']} now={() => T0} {...props} />,
  );
  return { doc, store, ids, view };
};

describe('Inspector', () => {
  it('suggests connecting a node that shares an identifier, and creates the edge on click', async () => {
    const user = userEvent.setup();
    const { doc, ids } = panel();
    const other = ids[1] ?? '';
    expect(listEdges(doc)).toHaveLength(0);
    const suggestion = within(screen.getByTestId('link-suggestions'));
    expect(suggestion.getByText(/shares tag:osint/)).toBeTruthy();
    await user.click(screen.getByTestId(`suggest-connect-${other}`));
    await waitFor(() => {
      expect(listEdges(doc)).toHaveLength(1);
    });
    const [edge] = listEdges(doc);
    expect([edge?.source.nodeId, edge?.target.nodeId].sort()).toEqual([ids[0], other].sort());
  });

  it('shows board-level info and a multi-select hint when nothing is selected', () => {
    const { doc, store } = board();
    render(<Inspector doc={doc} store={store} selectedIds={[]} now={() => T0} />);
    expect(screen.getByText(/Select a node to see its details/)).toBeInTheDocument();
    expect(screen.getByText('2 nodes · 0 connections')).toBeInTheDocument();
  });

  it('renders the type fields from the registry descriptors', () => {
    panel();
    expect(screen.getByLabelText(/URL/)).toHaveValue('https://example.com');
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Fetch status')).toHaveValue('ok');
  });

  it('writes a field change into the document on blur', async () => {
    const { doc, ids } = panel();
    const url = screen.getByLabelText(/URL/);
    await userEvent.clear(url);
    await userEvent.type(url, 'https://changed.test');
    await userEvent.tab();
    expect(getNode(doc, ids[0] ?? '')?.data['url']).toBe('https://changed.test');
  });

  it('reports a validation problem in the analyst’s terms', async () => {
    panel();
    const url = screen.getByLabelText(/URL/);
    await userEvent.clear(url);
    await userEvent.type(url, 'not a url');
    await userEvent.tab();
    expect(screen.getByText(/is not a valid URL/)).toBeInTheDocument();
  });

  it('writes a select immediately', async () => {
    const { doc, ids } = panel();
    await userEvent.selectOptions(screen.getByLabelText('Fetch status'), 'failed');
    expect(getNode(doc, ids[0] ?? '')?.data['status']).toBe('failed');
  });

  it('edits the title', async () => {
    const { doc, ids } = panel();
    const title = screen.getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed');
    await userEvent.tab();
    expect(getNode(doc, ids[0] ?? '')?.title).toBe('Renamed');
  });

  it('adds and removes tags, and explains a refusal', async () => {
    const { doc, ids } = panel();
    const input = screen.getByLabelText('Add a tag');
    await userEvent.type(input, 'infra{Enter}');
    expect(getNode(doc, ids[0] ?? '')?.tags).toEqual(['osint', 'infra']);

    await userEvent.type(input, 'OSINT{Enter}');
    expect(screen.getByText(/already on this node/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag infra' }));
    expect(getNode(doc, ids[0] ?? '')?.tags).toEqual(['osint']);
  });

  it('saves a title on Enter, without needing the field to lose focus', async () => {
    const { doc, store, ids } = board();
    const id = ids[0] ?? '';
    render(<Inspector doc={doc} store={store} selectedIds={[id]} now={() => T0} />);

    const input = screen.getByLabelText('Title');
    await userEvent.clear(input);
    await userEvent.type(input, 'acmecorp.com leak{Enter}');
    expect(getNode(doc, id)?.title).toBe('acmecorp.com leak');
  });

  it('writes nothing when an untouched field loses focus, so undo keeps the real last step', async () => {
    const { doc, store, ids } = board();
    const id = ids[0] ?? '';
    render(<Inspector doc={doc} store={store} selectedIds={[id]} now={() => T0} />);

    const before = getNode(doc, id)?.updatedAt;
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });

    screen.getByLabelText('Title').focus();
    await userEvent.tab();

    expect(updates).toBe(0);
    expect(getNode(doc, id)?.updatedAt).toBe(before);
  });

  it('restores the stored title on Escape', async () => {
    const { doc, store, ids } = board();
    const id = ids[0] ?? '';
    const before = getNode(doc, id)?.title;
    render(<Inspector doc={doc} store={store} selectedIds={[id]} now={() => T0} />);

    const input = screen.getByLabelText('Title');
    await userEvent.type(input, ' typo{Escape}');
    expect(input).toHaveValue(before);
    expect(getNode(doc, id)?.title).toBe(before);
  });

  it('locks and hides the selected node from the panel', async () => {
    const { doc, store, ids } = board();
    const id = ids[0] ?? '';
    render(<Inspector doc={doc} store={store} selectedIds={[id]} now={() => T0} />);

    await userEvent.click(screen.getByTestId('inspector-lock'));
    expect(getNode(doc, id)?.locked).toBe(true);
    expect(screen.getByTestId('inspector-lock')).toHaveTextContent('Unlock');

    await userEvent.click(screen.getByTestId('inspector-hide'));
    expect(getNode(doc, id)?.hidden).toBe(true);
    expect(screen.getByTestId('inspector-hide')).toHaveTextContent('Show');

    await userEvent.click(screen.getByTestId('inspector-hide'));
    expect(getNode(doc, id)?.hidden).toBe(false);
  });

  it('names the shortcut the engine actually binds when there are no connections', () => {
    const { doc, store, ids } = board();
    render(<Inspector doc={doc} store={store} selectedIds={[ids[0] ?? '']} now={() => T0} />);
    const connections = within(screen.getByTestId('inspector-connections'));
    // The engine starts a connection on `c` (see fsm.connect.test.ts); the hint used to say `E`.
    expect(connections.getByText(/Press C/)).toBeInTheDocument();
  });

  it('lists connections with their direction', () => {
    const { doc, store, ids } = board();
    addEdge(
      doc,
      makeEdge({ id: 'e1', from: ids[0] ?? '', to: ids[1] ?? '', label: 'mentions' }, T0),
      {
        origin: 'local:create',
        now: T0,
      },
    );
    render(<Inspector doc={doc} store={store} selectedIds={[ids[0] ?? '']} now={() => T0} />);
    const connections = within(screen.getByTestId('inspector-connections'));
    expect(connections.getByText(/Finding/)).toBeInTheDocument();
    expect(connections.getByText('out')).toBeInTheDocument();
  });

  it('shows provenance and the node id', () => {
    const { ids } = panel();
    const provenance = within(screen.getByTestId('inspector-provenance'));
    expect(provenance.getByText('manual')).toBeInTheDocument();
    expect(provenance.getByText(ids[0] ?? '')).toBeInTheDocument();
  });

  it('shows only shared tags for a multi-selection', () => {
    const { doc, store, ids } = board();
    render(<Inspector doc={doc} store={store} selectedIds={ids} now={() => T0} />);
    expect(screen.getByText('2 nodes selected')).toBeInTheDocument();
    const tags = within(screen.getByTestId('inspector-tags'));
    expect(tags.getByText('osint')).toBeInTheDocument();
  });

  it('applies a tag to every node in a multi-selection', async () => {
    const { doc, store, ids } = board();
    render(<Inspector doc={doc} store={store} selectedIds={ids} now={() => T0} />);
    await userEvent.type(screen.getByLabelText('Add a tag'), 'sweep{Enter}');
    for (const id of ids) expect(getNode(doc, id)?.tags).toContain('sweep');
  });

  it('says so when the selected node was deleted', () => {
    const { doc, store } = board();
    render(<Inspector doc={doc} store={store} selectedIds={['ghost']} now={() => T0} />);
    expect(screen.getByText('Node deleted')).toBeInTheDocument();
  });

  it('clamps the panel width to the allowed range', () => {
    const { doc, store, ids } = board();
    render(
      <Inspector
        doc={doc}
        store={store}
        selectedIds={[ids[0] ?? '']}
        width={9000}
        onWidthChange={() => undefined}
        now={() => T0}
      />,
    );
    const slider = screen.getByLabelText('Panel width');
    expect(slider).toHaveValue(String(INSPECTOR_MAX_WIDTH));
  });

  it('renders unknown payloads read-only', () => {
    const doc = createBoardDoc({ boardId: 'b_unknown', now: T0 });
    const { node } = createNode(
      doc,
      { type: 'quantum-thing', x: 0, y: 0, data: { anything: 1 } },
      { now: T0, makeId: () => 'n_u' },
    );
    render(
      <Inspector doc={doc} store={createNodeStore(doc)} selectedIds={[node.id]} now={() => T0} />,
    );
    expect(screen.getByTestId('inspector-data-readonly').textContent).toContain('anything');
  });
});

describe('Inspector rich text', () => {
  it('binds the note body to the same fragment the card edits, and locks with the node', async () => {
    const { doc, store, ids } = board();
    const noteId = ids[1] ?? '';
    const { rerender } = render(
      <Inspector doc={doc} store={store} selectedIds={[noteId]} now={() => T0} />,
    );

    const editor = await screen.findByTestId(`richtext-${noteId}`);
    expect(editor).not.toHaveAttribute('data-readonly');
    expect(within(editor).getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finding' })).toBeInTheDocument();

    updateNode(doc, noteId, { locked: true }, { origin: 'local:edit', now: T0 });
    rerender(<Inspector doc={doc} store={store} selectedIds={[noteId]} now={() => T0} />);
    await waitFor(() =>
      expect(screen.getByTestId(`richtext-${noteId}`)).toHaveAttribute('data-readonly', 'true'),
    );
  });

  describe('cross-project references (§20)', () => {
    it('links back to the board a pasted node came from', () => {
      const doc = createBoardDoc({ boardId: 'b_here', now: T0 });
      const { node } = createNode(
        doc,
        {
          type: 'note',
          x: 0,
          y: 0,
          title: 'Copied finding',
          data: {
            referencedFrom: { boardId: 'b_there', projectId: 'p_there', boardTitle: 'Case A' },
          },
        },
        { now: T0, makeId: () => 'n_ref' },
      );
      render(
        <Inspector doc={doc} store={createNodeStore(doc)} selectedIds={[node.id]} now={() => T0} />,
      );
      const section = screen.getByTestId('inspector-referenced-from');
      expect(within(section).getByRole('link', { name: 'Case A' })).toHaveAttribute(
        'href',
        '/p/p_there/b/b_there',
      );
    });

    it('says nothing when the node has no origin', () => {
      panel();
      expect(screen.queryByTestId('inspector-referenced-from')).toBeNull();
    });

    it('ignores a malformed origin', () => {
      const doc = createBoardDoc({ boardId: 'b_here', now: T0 });
      const { node } = createNode(
        doc,
        { type: 'note', x: 0, y: 0, title: 'Odd', data: { referencedFrom: { boardId: 7 } } },
        { now: T0, makeId: () => 'n_bad' },
      );
      render(
        <Inspector doc={doc} store={createNodeStore(doc)} selectedIds={[node.id]} now={() => T0} />,
      );
      expect(screen.queryByTestId('inspector-referenced-from')).toBeNull();
    });
  });
});
